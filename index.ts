//configurar dotenv
import Fastify from 'fastify'
import {SuperORM} from "./database/SQLite";
import {ServerModel} from "./database/model/ServerModel";
import {handleRequest} from "./routes/RouteConfig";
import Server from "./libs/Server"
import config from "./config.json";
import websocket from '@fastify/websocket';
import {hasPermission} from './libs/RemoteConnect';
import { startSFTP } from './libs/SFTP';

async function main() {
    const orm = new SuperORM('database.sqlite');
    await orm.init(ServerModel);

    const fastify = Fastify({
        logger: false
    })

    await fastify.register(require('@fastify/cors'), {
        // opções do plugin
    })
    await fastify.register(websocket);

    // Rota WebSocket deve vir ANTES da rota coringa '*'
    const PREFIX_LABEL = 'container@hightd ~';
    fastify.get('/api/v1/servers/console', { websocket: true }, (connection: any, req: any) => {
        const sock: any = (connection && connection.socket) ? connection.socket : connection;
        if(!sock || typeof sock.send !== 'function') {
            console.error('[WS][console] Socket inválido');
            return;
        }
        const startedAt = Date.now();
        let serverId: string | undefined;
        let userUuid: string | undefined;
        let logStreamCleanup: (()=>void) | null = null;
        let streamStarted = false;
        let liveUnsub: (()=>void) | null = null;
        let statusMonitor: NodeJS.Timeout | null = null;

        const colorForCategory = (category: string): string => {
            switch(category) {
                case 'error': return '\x1b[31m';
                case 'pull': return '\x1b[36m';
                case 'status': return '';
                case 'command': return '';
                case 'warn': return '\x1b[33m';
                default: return ''; // log / outros
            }
        };
        const PREFIX_COLOR = '\x1b[36;1m'; // turquesa brilhante
        const RESET = '\x1b[0m';
        const buildColoredLine = (category: string, message: string): string => {
            if(category === 'log' || category === 'internal') {
                return message;
            }
            const catColor = colorForCategory(category);
            const prefixColored = `${PREFIX_COLOR}${PREFIX_LABEL}${RESET}`;
            const msgColored = catColor ? `${catColor}${message}${RESET}` : message;
            return `${prefixColored} ${msgColored}`;
        };
        const sendStructured = (category: string, message: string, timestamp?: number) => {
            if (category === 'internal') return;
            const ts = timestamp || Date.now();
            const line = buildColoredLine(category, message);
            const prefixOut = category === 'log' ? '' : PREFIX_LABEL;
            try { sock.send(JSON.stringify({ type: 'line', prefix: prefixOut, category, message, timestamp: ts, line })); } catch {}
        };
        const log = (phase: string, msg: string, extra?: any) => {
            const meta = `[WS][console][${phase}]` + (serverId?`[server=${serverId}]`:'') + (userUuid?`[user=${userUuid}]`:'');
            if(extra!==undefined) console.log(meta, msg, extra); else console.log(meta, msg);
        };
        const beginStream = async (server: Server, tail: number) => {
            if(streamStarted) {
                log('stream-debug', 'beginStream ignorado, stream já ativo.');
                return;
            }
            if(!server.container) {
                log('stream-debug', 'beginStream adiado, container ainda não existe.');
                sendStructured('status', 'Aguardando container ser criado...');
                return;
            }

            streamStarted = true; // Otimisticamente define como true para evitar chamadas duplas
            log('stream-lifecycle', 'Iniciando tentativa de stream...');
            try {
                const cleanup = await server.streamDockerLogs(tail, rawLine => {
                    if(rawLine) sendStructured('log', rawLine);
                });
                logStreamCleanup = cleanup;
                log('stream-lifecycle','STREAM ATIVO.');
            } catch(e:any) {
                streamStarted = false; // Falhou, reseta a flag para permitir nova tentativa
                const msg = e?.message || String(e);
                log('stream-error',`Falha ao iniciar stream: ${msg}`);
                sendStructured('error', `Falha ao iniciar stream de logs: ${msg}`);
            }
        };

        const cleanupResources = () => {
            if (statusMonitor) clearInterval(statusMonitor);
            if (logStreamCleanup) logStreamCleanup();
            if (liveUnsub) liveUnsub();
            statusMonitor = null;
            logStreamCleanup = null;
            liveUnsub = null;
            streamStarted = false;
        };

        try {
            const q = req.query as any;
            serverId = q?.serverId;
            userUuid = q?.userUuid;
            const tailReq = parseInt(q?.tail,10);
            const tail = isNaN(tailReq) ? 200 : Math.min(Math.max(tailReq,0),1000);

            if(!serverId || !userUuid) {
                sendStructured('error','Parâmetros ausentes');
                return sock.close();
            }
            const server = Server.getServer(serverId);
            if(!server) {
                sendStructured('error','Servidor não encontrado');
                return sock.close();
            }

            hasPermission(userUuid, server).then(async perm => {
                if(!perm) {
                    sendStructured('error','Sem permissão');
                    return sock.close();
                }

                log('init', `Conectando ao servidor ${serverId}`);

                // Listener apenas para repassar mensagens, sem lógica de controle.
                liveUnsub = server.addLiveListener(ev => {
                    sendStructured(ev.category, ev.message, ev.timestamp);
                });

                // --- LÓGICA DE SUPERVISÃO ATIVA ---
                let lastStatus = 'unknown';

                // Verificação inicial imediata
                const initialStatus = await server.getStatus();
                log('monitor', `Status inicial detectado: ${initialStatus}`);
                lastStatus = initialStatus;
                if (initialStatus !== 'stopped' && !streamStarted) {
                    await beginStream(server, tail);
                } else if (initialStatus === 'stopped') {
                    sendStructured('status','Servidor marcado como desligado');
                }

                // Monitoramento contínuo
                statusMonitor = setInterval(async () => {
                    if (!server) return;
                    const currentStatus = await server.getStatus();

                    if (currentStatus !== lastStatus) {
                        log('monitor', `Status mudou de '${lastStatus}' para '${currentStatus}'`);

                        if (currentStatus === 'stopped') {
                            if (streamStarted) {
                                log('monitor', 'Servidor parou, limpando stream existente.');
                                if (logStreamCleanup) logStreamCleanup();
                                logStreamCleanup = null;
                                streamStarted = false;
                            }
                        } else { // running
                            if (!streamStarted) {
                                log('monitor', 'Servidor iniciou, tentando conectar stream.');
                                await beginStream(server, tail);
                            }
                        }
                        lastStatus = currentStatus;
                    }
                }, 2000); // Verifica a cada 2 segundos


                // Heartbeat
                let alive = true; sock.on?.('pong',()=> alive = true);
                const hb = setInterval(()=>{
                    if(!alive) {
                        clearInterval(hb);
                        cleanupResources();
                        try { sock.terminate?.(); } catch {};
                        return;
                    }
                    alive = false; try { sock.ping?.(); } catch {}
                },15000);

                // Mensagens (comando)
                sock.on('message', async (raw: any) => {
                    try {
                        const msg = JSON.parse(raw.toString());
                        if(msg.type === 'command' && typeof msg.command === 'string') {
                            await server.sendCommand(msg.command);
                        }
                    } catch { sendStructured('error','JSON inválido'); }
                });

                sock.on('close', () => {
                    cleanupResources();
                    clearInterval(hb);
                    log('close','Conexão encerrada.',{durMs:Date.now()-startedAt});
                });
                sock.on('error', (er:any)=> log('socket-error','erro', er?.message||er));

            }).catch(e=>{
                log('perm-error','falha perm', e);
                sendStructured('error','Falha na verificação de permissão');
                sock.close();
            });
        } catch(e:any) {
            log('fatal','exceção no setup', e?.message||e);
            sendStructured('error','Erro interno no servidor de console');
            sock.close();
        }
    });

    const universalHandler = async (request: any, reply: any) => {
        return handleRequest(request, reply);
    };
    const methods = ['GET','POST','PUT','DELETE','PATCH'];
    for (const m of methods) {
        fastify.route({ method: m as any, url: '*', handler: universalHandler });
    }

    try {
        await fastify.listen({ port: config.port })
        startSFTP(config.sftp);
        await Server.start()
    } catch (err) {
        fastify.log.error(err)
        process.exit(1)
    }
}

main().catch(console.error);
