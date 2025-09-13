import { ServerModel } from "../database/model/ServerModel";
import Docker from 'dockerode';
import { CoreData, AllocationData, StartData, StopData } from "../types/ServerTypes";
import fs from 'fs/promises'; // Adicionado para manipulação de arquivos
import { PassThrough } from 'stream';

const PREFIX_LABEL = 'container@hightd ~';

// --- Classe Principal de Gerenciamento do Servidor ---
const docker = new Docker();
const CONTAINER_NAME_PREFIX = 'ptero-clone-';
export const BASE_SERVER_PATH = 'E:/servers';

export default class Server {

    delete() {
        //deletar pasta e da memoria
        this.kill().catch(() => { });
        if (this.container) {
            this.container.remove({ force: true }).catch(() => { });
            this.container = null;
        }
        this.running = false;
        this.isInitializing = false;
        this.startedAt = null;
        this.stdinStream = null;
        this.liveListeners.clear();
        const serverPath = `${BASE_SERVER_PATH}/${this.id}`;
        fs.rm(serverPath, { recursive: true, force: true }).catch(() => { });
        const index = Server.servers.indexOf(this);
        if (index !== -1) {
            Server.servers.splice(index, 1);
        }
        // retornar void

    }

    id: string;
    container: Docker.Container | null = null;
    running: boolean = false;
    private isInitializing: boolean = false;
    private startedAt: number | null = null;
    private stdinStream: any | null = null;
    private liveListeners: Set<(entry: { category: string; message: string; timestamp: number }) => void> = new Set();

    constructor(id: string) {
        this.id = id;
    }

    /**
     * Envia comando (fila até attach estar pronto). Aceita string ou {command}.
     */
    async sendCommand(input: string | { command: string }): Promise<void> {
        const cmd = typeof input === 'string' ? input : input?.command;
        if (!cmd || typeof cmd !== 'string') throw new Error('Comando inválido');
        if (!this.container) throw new Error('Container inexistente');
        if (!this.stdinStream) {
            console.log(`[Server:${this.id}] STDIN ausente, tentando reattach antes de enviar comando...`);
            await this._reattach();
        }
        if (!this.stdinStream) throw new Error('STDIN indisponível');
        const line = cmd.endsWith('\n') ? cmd : cmd + '\n';
        try {
            this.stdinStream.write(line);
            console.log(`[Server:${this.id}] Comando enviado: ${cmd}`);
        } catch (e) {
            throw new Error('Falha ao escrever no STDIN: ' + (e as any)?.message);
        }
    }

    /**
     * Puxa as estatísticas de uso de CPU e RAM do container.
     */
    async getUsages(): Promise<{ cpu: number; memory: number; memoryLimit: number }> {
        if (await this.getStatus() === 'stopped' || !this.container) {
            return { cpu: 0, memory: 0, memoryLimit: 0 };
        }
        try {
            const stats = await this.container.stats({ stream: false });
            const memoryUsage = stats.memory_stats?.usage || 0;
            const memoryLimit = stats.memory_stats?.limit || 0;
            const previousCpu = stats.precpu_stats?.cpu_usage?.total_usage || 0;
            const previousSystemCpu = stats.precpu_stats?.system_cpu_usage || 0;
            const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage || 0) - previousCpu;
            const systemCpuDelta = (stats.cpu_stats?.system_cpu_usage || 0) - previousSystemCpu;
            const numberOfCpus = stats.cpu_stats?.online_cpus || (stats.cpu_stats?.cpu_usage?.percpu_usage?.length) || 0;
            let cpuUsage = 0.0;
            if (systemCpuDelta > 0 && cpuDelta > 0 && numberOfCpus > 0) {
                cpuUsage = (cpuDelta / systemCpuDelta) * numberOfCpus * 100.0;
            }
            const cpu = parseFloat(cpuUsage.toFixed(2));
            const memory = memoryUsage; // bytes
            const memoryLimitOut = memoryLimit; // bytes
            return { cpu, memory, memoryLimit: memoryLimitOut };
        } catch (e) {
            return { cpu: 0, memory: 0, memoryLimit: 0 };
        }
    }

    /**
     * Cria, inicia e monitora um novo container.
     */
    async start(data: StartData): Promise<void> {
        // Limpeza de container pré-existente
        if (this.container) {
            try { await this.container.remove({ force: true }); } catch { } finally { this.container = null; }
        }

        // Estado inicial: sem mais 'initializing'; só definimos running=false até confirmação.
        this.startedAt = null;
        this.running = false;
        this.isInitializing = false;
        this._emitLive('status', 'Iniciando servidor...');

        // --- Substituição de variáveis ---
        const primaryPort = data.primaryAllocation?.port;
        const primaryIp = data.primaryAllocation?.ip;
        const varMap: Record<string,string> = {
            SERVER_MEMORY: String(data.memory),
            SERVER_PORT: primaryPort !== undefined ? String(primaryPort) : '',
            SERVER_IP: primaryIp || '',
            ...Object.fromEntries(Object.entries(data.environment || {}).map(([k,v])=>[k, String(v)]))
        };
        const replaceVars = (txt: string) => txt.replace(/\{\{([A-Z0-9_]+)\}\}/g,(m,k)=> varMap[k] !== undefined ? varMap[k] : m);

        let installScript = data.core.installScript ? replaceVars(data.core.installScript) : '';
        let startupBase = data.core.startupCommand ? replaceVars(data.core.startupCommand) : '';
        startupBase = startupBase.replace('{{SERVER_MEMORY}}', String(data.memory));

        const needsExec = !/^\s*exec\b/.test(startupBase);
        const finalStartupCommand = needsExec ? `exec ${startupBase}` : startupBase;
        const combinedCommand = installScript && installScript.trim() !== ''
            ? `${installScript}\n${finalStartupCommand}`
            : finalStartupCommand;

        // --- Geração de arquivos de config / templates ---
        const templates: Record<string, any> = {};
        if((data.core as any).configSystem && typeof (data.core as any).configSystem === 'object') {
            Object.assign(templates, (data.core as any).configSystem);
        }
        const sp = (data.core as any).startupParser;
        let doneString: string | null = null; // Mantido para compat mas não altera mais estado
        if(sp && typeof sp === 'object' && !Array.isArray(sp)) {
            if(typeof sp.done === 'string') {
                doneString = sp.done;
                const { done, ...rest } = sp;
                Object.assign(templates, rest);
            } else {
                Object.assign(templates, sp);
            }
        }
        const serverPath = `${BASE_SERVER_PATH}/${this.id}`;
        try { await fs.mkdir(serverPath, { recursive: true }); } catch {}
        const writeTemplateFile = async (name: string, contentSpec: any) => {
            const filePath = `${serverPath}/${name}`;
            try {
                let out = '';
                if(typeof contentSpec === 'string') {
                    out = replaceVars(contentSpec);
                } else if(typeof contentSpec === 'object') {
                    if(name.endsWith('.json')) {
                        const jsonReplaced = JSON.parse(replaceVars(JSON.stringify(contentSpec)));
                        out = JSON.stringify(jsonReplaced, null, 2);
                    } else {
                        out = Object.entries(contentSpec).map(([k,v])=>`${k}=${replaceVars(String(v))}`).join('\n');
                    }
                }
                await fs.writeFile(filePath, out, 'utf8');
                this._emitLive('status', `Arquivo de config gerado: ${name}`);
            } catch(e:any) {
                this._emitLive('error', `Falha ao gerar arquivo ${name}: ${e.message || e}`);
            }
        };
        for(const fname of Object.keys(templates)) {
            await writeTemplateFile(fname, templates[fname]);
        }

        const envVars = Object.entries(data.environment).map(([key, value]) => `${key}=${String(value)}`);

        const portBindings: Docker.PortMap = {};
        const allAllocations = [data.primaryAllocation, ...data.additionalAllocations];
        for (const alloc of allAllocations) {
            if (!alloc) continue;
            const containerPortTCP = `${alloc.port}/tcp`;
            portBindings[containerPortTCP] = [{ HostIp: alloc.ip, HostPort: String(alloc.port) }];
            const containerPortUDP = `${alloc.port}/udp`;
            portBindings[containerPortUDP] = [{ HostIp: alloc.ip, HostPort: String(alloc.port) }];
        }

        const containerOptions: Docker.ContainerCreateOptions = {
            Image: data.image,
            name: `${CONTAINER_NAME_PREFIX}${this.id}`,
            Env: envVars,
            Cmd: ['/bin/sh', '-c', combinedCommand],
            Tty: true,
            OpenStdin: true,
            AttachStdin: true,
            StdinOnce: false,
            AttachStdout: true,
            AttachStderr: true,
            WorkingDir: '/home/hightd',
            HostConfig: {
                Memory: data.memory * 1024 * 1024,
                CpuQuota: data.cpu * 1000,
                CpuPeriod: 100000,
                StorageOpt: { size: `${data.disk}M` },
                PortBindings: portBindings,
                Binds: [`${BASE_SERVER_PATH}/${this.id}:/home/hightd`],
                LogConfig: {
                    Type: 'json-file',
                    Config: {
                        compress: 'false',
                        'max-file': '1',
                        'max-size': '70k',
                        mode: 'non-blocking'
                    }
                }
            }
        };

        try {
            console.log(`[Server:${this.id}] Iniciando start...`);
            console.log(`[Server:${this.id}] Pull imagem: ${data.image}`);
            this._emitLive('pull', `Baixando imagem ${data.image}`);
            const pullStream = await docker.pull(data.image);
            await new Promise((resolve, reject) => {
                (docker as any).modem.followProgress(pullStream, (err: any) => err ? reject(err) : resolve(null), (event: any) => {
                    try {
                        if(event?.status) {
                            const ref = event.id ? `${event.id}: ${event.status}` : event.status;
                            const prog = event.progress ? ` ${event.progress}` : '';
                            this._emitLive('pull', `${ref}${prog}`);
                        }
                    } catch {}
                });
            });
            this._emitLive('pull', 'Pull concluído');
            const newContainer = await docker.createContainer(containerOptions);
            this.container = newContainer;
            console.log(`[Server:${this.id}] Container criado. Iniciando...`);


            await this.container.start();

            // Confirma estado running no Docker
            let isRunning = false;
            for (let i = 0; i < 15; i++) {
                try {
                    if(!this.container) break;
                    const inspectData = await this.container.inspect();
                    if (inspectData.State.Status === 'running') { isRunning = true; break; }
                } catch {}
                await new Promise(r => setTimeout(r, 200));
            }
            if (!isRunning) {
                this._emitLive('error', 'Timeout para container ficar running.');
            } else {
                this.running = true;
                this.startedAt = Date.now();
                this._emitLive('status', 'Servidor em execução.');
            }

            this._emitLive('internal', 'container_started');
            console.log(`[Server:${this.id}] Container iniciado. Fazendo attach...`);
            this._emitLive('status', 'Container iniciado, anexando...');
            await this._attachAfterStart(doneString || '');
            console.log(`[Server:${this.id}] Server start finalizado.`);
        } catch (error) {
            console.error(`[Server:${this.id}] Erro start:`, error);
            this._emitLive('error', `Falha ao iniciar: ${(error as any)?.message || error}`);
            if(this.container) { try { await this.container.remove({ force: true }); } catch {} }
            this.container = null;
            this.running = false;
            this.isInitializing = false;
            this.startedAt = null;
            this.stdinStream = null;
            throw error;
        }
    }

    /**
     * Anexa ao container (sem lógica de transição de estado agora).
     */
    private async _attachAfterStart(_doneString: string): Promise<void> {
        if (!this.container) return;
        const stream: any = await this.container.attach({ stream: true, stdin: true, stdout: true, stderr: true });
        this.stdinStream = stream;
        (this.container as any).stdin = stream;
        this.container.wait().then(() => {
            this.running = false;
            this.startedAt = null;
            this.stdinStream = null;
            this._emitLive('status', 'Servidor marcado como desligado.');
        }).catch(() => {});
        // Apenas repassa dados de saída como antes
        stream.on('data', (_chunk: Buffer) => { /* saída tratada nos listeners de logs/WebSocket */ });
    }

    private async _reattach(): Promise<void> {
        if (!this.container) return;
        try {
            const stream: any = await this.container.attach({ stream: true, stdin: true, stdout: true, stderr: true });
            this.stdinStream = stream;
            (this.container as any).stdin = stream;
        } catch {}
    }

    /**
     * Para, remove e recria o container.
     */
    async restart(data: StartData): Promise<void> {
        if (this.container) {
            this._emitLive('status', 'Reiniciando servidor...');
            await this.stop({ command: data.core.stopCommand });
        }
        await this.start(data);
    }

    /**
     * Força a parada imediata do container.
     */
    async kill(): Promise<void> {
        if (!this.container) return;
        this._emitLive('status', 'Forçando parada (kill)...');
        try { await this.container.kill(); } catch { }
    }

    /**
     * Para o container de forma "graciosa".
     */
    async stop(data: StopData): Promise<void> {
        if (!this.container) return;
        this._emitLive('status', 'Parando servidor...');
        try { await this.sendCommand({command: data.command}) } catch (e) {
            this._emitLive('error', 'Falha stop gracioso, aplicando kill.');
            await this.kill();
        }
    }

    /**
     * Retorna o estado atual do servidor (apenas 'running' ou 'stopped').
     */
    async getStatus(): Promise<"running" | "stopped"> {
        if (!this.container) {
            this.running = false;
            return "stopped";
        }
        try {
            const inspectData = await this.container.inspect();
            const status = inspectData.State.Status;
            if (status === 'running') {
                if (!this.running) {
                    // sincroniza caso reinício do painel
                    this.running = true;
                    if(!this.startedAt && inspectData.State?.StartedAt) {
                        const startedDate = new Date(inspectData.State.StartedAt).getTime();
                        this.startedAt = !isNaN(startedDate) ? startedDate : Date.now();
                    }
                }
                return 'running';
            }
            this.running = false;
            return 'stopped';
        } catch {
            this.running = false;
            this.container = null;
            return 'stopped';
        }
    }

    getStartedAt(): number | null { return this.startedAt; }
    getUptimeMs(): number { return this.startedAt ? Date.now() - this.startedAt : 0; }

    // --- Métodos e Propriedades Estáticas ---
    static servers: Server[] = [];

    /**
     * Prepara o ambiente para um novo servidor, criando seu diretório de arquivos.
     */
    static async create(id: string): Promise<void> {
        const serverPath = `${BASE_SERVER_PATH}/${id}`;
        try { await fs.mkdir(serverPath, { recursive: true }); } catch (error) {
            throw new Error(`Falha ao criar o diretório para o servidor ${id} em ${serverPath}: ${error}`);
        }
        Server.servers.push(new Server(id));
    }

    static getServer(uuid: string): Server | null {
        return Server.servers.find(server => server.id === uuid) || null;
    }

    /**
     * Sincroniza o estado com os containers Docker existentes na inicialização.
     */
    static async start(): Promise<void> {
        const serversFromDB = await ServerModel.getAll();
        const allContainers = await docker.listContainers({ all: true });

        for (const serverData of serversFromDB) {
            const server = new Server(serverData.serverId);
            const containerName = `/${CONTAINER_NAME_PREFIX}${server.id}`;
            const existingContainer = allContainers.find(c => c.Names.includes(containerName));

            if (existingContainer) {
                server.container = docker.getContainer(existingContainer.Id);
                if (existingContainer.State === 'running') {
                    server.running = true;
                    try {
                        const inspect = await server.container.inspect();
                        if (inspect?.State?.StartedAt) {
                            const startedDate = new Date(inspect.State.StartedAt).getTime();
                            server.startedAt = !isNaN(startedDate) ? startedDate : Date.now();
                        } else {
                            server.startedAt = Date.now();
                        }
                    } catch { server.startedAt = Date.now(); }
                    await server._reattach();
                }
            }

            Server.servers.push(server);
        }
    }

    addLiveListener(fn: (entry: { category: string; message: string; timestamp: number }) => void): () => void {
        this.liveListeners.add(fn);
        return () => this.liveListeners.delete(fn);
    }

    private _emitLive(category: string, message: string) {
        const entry = { category, message, timestamp: Date.now() };
        for(const l of this.liveListeners) { try { l(entry); } catch {} }
    }

    async streamDockerLogs(tail: number, onLine: (line: string) => void): Promise<() => void> {
        if(!this.container) throw new Error('Container inexistente');
        let isTty = false;
        try { const inspect = await this.container.inspect(); isTty = !!inspect.Config?.Tty; } catch {}
        const logStream: any = await this.container.logs({
            follow: true,
            stdout: true,
            stderr: true,
            tail: isNaN(tail) ? 200 : tail
        });
        let closed = false;
        const cleanup = () => {
            if(closed) return; closed = true;
            try { logStream.destroy(); } catch {}
            try { stdout?.destroy?.(); } catch {}
            try { stderr?.destroy?.(); } catch {}
        };
        let stdout: PassThrough | undefined;
        let stderr: PassThrough | undefined;
        const handleChunk = (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            const lines = text.split(/\r?\n/);
            for(const l of lines) { if(!l) continue; try { onLine(l); } catch {} }
        };
        if(isTty) {
            logStream.on('data', handleChunk);
            logStream.on('error', () => cleanup());
            logStream.on('end', () => cleanup());
        } else {
            stdout = new PassThrough();
            stderr = new PassThrough();
            try { (docker as any).modem.demuxStream(logStream, stdout, stderr); } catch { logStream.on('data', handleChunk); }
            stdout.on('data', handleChunk);
            stderr.on('data', handleChunk);
            logStream.on('error', () => cleanup());
            stdout.on('error', () => cleanup());
            stderr.on('error', () => cleanup());
            logStream.on('end', () => cleanup());
        }
        return cleanup;
    }
}
