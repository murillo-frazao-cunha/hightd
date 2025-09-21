import { Server as SSHServer } from 'ssh2';
import { generateKeyPairSync } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import Server, { BASE_SERVER_PATH } from './Server';
import { VerifySFTP } from './RemoteConnect';

// Enum local de códigos SFTP (ssh2-streams)
const SFTP_CODE = {
    OK: 0,
    EOF: 1,
    NO_SUCH_FILE: 2,
    PERMISSION_DENIED: 3,
    FAILURE: 4,
    BAD_MESSAGE: 5,
    NO_CONNECTION: 6,
    CONNECTION_LOST: 7,
    OP_UNSUPPORTED: 8
} as const;

const log = (...a: any[]) => console.log('[SFTP]', ...a);

/**
 * Inicia um servidor SFTP simples para acesso aos diretórios dos servidores.
 * Usuário de login esperado: <username>_<serverId>
 * A senha será validada via API remota (VerifySFTP).
 */
export function startSFTP(port: number) {
    log('Inicializando SFTP na porta', port);
    const KEY_PATH = path.join(BASE_SERVER_PATH, 'sftp_host_key.pem');
    let hostKey: string;
    if (fs.existsSync(KEY_PATH)) {
        try {
            hostKey = fs.readFileSync(KEY_PATH, 'utf8');
            log('Chave host SFTP carregada do disco');
        } catch (e:any) {
            log('Falha ao ler chave existente, gerando nova', e?.message||e);
            const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
            hostKey = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
            try { fs.writeFileSync(KEY_PATH, hostKey, { encoding: 'utf8', flag: 'w' }); } catch {}
        }
    } else {
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        hostKey = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
        try { fs.writeFileSync(KEY_PATH, hostKey, { encoding: 'utf8', flag: 'w' }); log('Chave host SFTP criada e salva'); } catch (e:any) {
            log('Falha ao salvar chave host SFTP', e?.message||e);
        }
    }

    const ssh = new SSHServer({ hostKeys: [hostKey] }, (client) => {
        log('Nova conexão TCP recebida de cliente');
        let serverObj: Server | null = null;
        let rootDir: string = '';
        let usernameBase: string = '';

        client.on('authentication', async (ctx) => {
            log('Autenticação iniciada', { method: ctx.method, username: ctx.username });
            if (ctx.method === 'none') {
                log('Método none recebido - solicitando password');
                return ctx.reject(['password']); // permite tentativa de senha (FileZilla faz probes)
            }
            if (ctx.method !== 'password') {
                log('Método não suportado', ctx.method);
                return ctx.reject(['password']);
            }
            const rawUser = ctx.username || '';
            const parts = rawUser.split('_');
            log('Username split', { rawUser, parts });
            if (parts.length < 2) {
                log('Rejeitado: username sem serverId. Formato esperado <user>_<serverId>');
                return ctx.reject();
            }
            usernameBase = parts.slice(0, -1).join("_");
            const serverId = parts.pop() || 'a'; // suporta underscores adicionais no ID
            // Nova lógica: tentar match exato e depois por prefixo
            serverObj = Server.getServer(serverId);
            if (!serverObj) {
                const matches = (Server as any).servers?.filter((s: Server) => s.id.startsWith(serverId)) || [];
                if (matches.length === 1) {
                    serverObj = matches[0];
                    // @ts-ignore
                    log('Match por prefixo encontrado', { prefix: serverId, escolhido: serverObj.id });
                } else if (matches.length > 1) {
                    log('Ambiguidade: múltiplos servidores para prefixo', { prefix: serverId, candidatos: matches.map((m: Server)=>m.id) });
                    return ctx.reject();
                }
            }
            if (!serverObj) {
                log('Rejeitado: servidor não encontrado (exato ou prefixo)', serverId);
                return ctx.reject();
            }
            try {
                log('Chamando VerifySFTP', { usernameBase, serverId, passLen: (ctx.password as string)?.length });
                const ok = await VerifySFTP(usernameBase, ctx.password as string, serverObj);
                log('Resultado VerifySFTP', ok);
                if (!ok) {
                    log('Rejeitado: VerifySFTP retornou false');
                    return ctx.reject();
                }
                rootDir = path.join(BASE_SERVER_PATH, serverObj.id);
                log('Autenticação aceita', { rootDir });
                return ctx.accept();
            } catch (e: any) {
                log('Erro VerifySFTP', e?.message || e);
                return ctx.reject();
            }
        });

        client.on('ready', () => {
            // Garantia para o type checker: 'ready' só acontece após autenticação aceita
            if (!serverObj) {
                log('Evento ready sem serverObj (estado inconsistente). Encerrando.');
                try { client.end(); } catch {}
                return;
            }
            log('Cliente autenticado e pronto', { usernameBase, server: serverObj.id });
            client.on('session', (accept) => {
                log('Session aberta');
                const session = accept();
                session.on('sftp', (acceptSftp) => {
                    log('Canal SFTP aceito');
                    const sftpStream = acceptSftp();

                    const isOsAbsolute = (p: string) => /^(?:[a-zA-Z]:\\|\\\\|[a-zA-Z]:\/)/.test(p);
                    const toVirtual = (abs: string) => {
                        if (abs === rootDir) return '/';
                        if (abs.startsWith(rootDir + path.sep)) {
                            const rel = abs.slice(rootDir.length + 1).replace(/\\/g,'/');
                            return '/' + rel;
                        }
                        return '/';
                    };

                    const normalize = (p: string) => {
                        if (!p || p === '.' || p === '/') return rootDir;
                        if (p === rootDir || p === rootDir + path.sep || p === rootDir + path.sep + '.' ) return rootDir;
                        // Paths que começam com '/' tratamos como virtuais relativas ao root
                        if (p.startsWith('/')) {
                            const relPart = p.replace(/^\/+/, '');
                            if (!relPart) return rootDir;
                            const rel = path.normalize(path.join(rootDir, relPart));
                            if (!rel.startsWith(rootDir)) throw new Error('Path fora do sandbox');
                            return rel;
                        }
                        // Caminho absoluto do SO (drive etc.)
                        if (isOsAbsolute(p) || path.isAbsolute(p)) {
                            const abs = path.normalize(p);
                            if (!abs.startsWith(rootDir)) throw new Error('Path fora do sandbox');
                            return abs;
                        }
                        // Caminho relativo
                        const rel = path.normalize(path.join(rootDir, p.replace(/^\/+/, '')));
                        if (!rel.startsWith(rootDir)) throw new Error('Path fora do sandbox');
                        return rel;
                    };

                    sftpStream.on('REALPATH', (reqid, givenPath) => {
                        log('REALPATH', givenPath);
                        try {
                            const full = normalize(givenPath);
                            let st: fs.Stats | null = null;
                            try { st = fs.statSync(full); } catch {}
                            const virt = toVirtual(full);
                            const longname = st ? formatLongname(virt === '/' ? '.' : virt.slice(1), st) : virt;
                            sftpStream.name(reqid, [{ filename: virt, longname, attrs: st ? statsToAttrs(st) : {} as any }]);
                        } catch (e:any) { log('REALPATH erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });

                    // Novo: FSTAT para alguns clientes determinarem tipo corretamente
                    // (FileZilla pode chamar em certos fluxos)
                    sftpStream.on('FSTAT', async (reqid, handle) => {
                        log('FSTAT');
                        const h = fileHandles.get(handle.toString('hex'));
                        if (!h) return sftpStream.status(reqid, SFTP_CODE.FAILURE);
                        try {
                            const st = await h.fd.stat();
                            sftpStream.attrs(reqid, statsToAttrs(st));
                        } catch (e:any) { log('FSTAT erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });

                    sftpStream.on('STAT', async (reqid, givenPath) => {
                        log('STAT', givenPath);
                        try {
                            const st = await fsp.stat(normalize(givenPath));
                            sftpStream.attrs(reqid, statsToAttrs(st));
                        } catch (e:any) { log('STAT erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });
                    sftpStream.on('LSTAT', async (reqid, givenPath) => {
                        log('LSTAT', givenPath);
                        try { const st = await fsp.lstat(normalize(givenPath)); sftpStream.attrs(reqid, statsToAttrs(st)); }
                        catch (e:any) { log('LSTAT erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });

                    sftpStream.on('OPENDIR', async (reqid, givenPath) => {
                        log('OPENDIR', givenPath);
                        try {
                            const dirPath = normalize(givenPath);
                            const entries = await fsp.readdir(dirPath, { withFileTypes: true });
                            const handle = Buffer.from(Math.random().toString(36).slice(2));
                            dirHandles.set(handle.toString('hex'), { path: dirPath, entries, sent: false });
                            sftpStream.handle(reqid, handle);
                        } catch (e:any) { log('OPENDIR erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });

                    sftpStream.on('READDIR', (reqid, handle) => {
                        log('READDIR');
                        const key = handle.toString('hex');
                        const d = dirHandles.get(key);
                        if (!d) { log('READDIR handle inválido'); return sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                        if (d.sent) return sftpStream.status(reqid, SFTP_CODE.EOF);
                        d.sent = true;
                        const list = d.entries.map(ent => {
                            const p = path.join(d.path, ent.name);
                            let st: fs.Stats | null = null;
                            try { st = fs.statSync(p); } catch {}
                            return {
                                filename: ent.name,
                                longname: st ? formatLongname(ent.name, st) : ent.name,
                                attrs: st ? statsToAttrs(st) : {} as any
                            };
                        });
                        sftpStream.name(reqid, list);
                    });

                    sftpStream.on('OPEN', async (reqid, filename, flags, attrs) => {
                        log('OPEN', filename, flags);
                        try {
                            const p = normalize(filename);
                            const mode = flagsToFsFlags(flags);
                            await fsp.mkdir(path.dirname(p), { recursive: true });
                            const fd = await fsp.open(p, mode.includes('w') ? 'w+' : 'r');
                            const handle = Buffer.from(Math.random().toString(36).slice(2));
                            fileHandles.set(handle.toString('hex'), { fd });
                            sftpStream.handle(reqid, handle);
                        } catch (e:any) { log('OPEN erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });

                    sftpStream.on('READ', async (reqid, handle, offset, length) => {
                        log('READ', { offset, length });
                        const h = fileHandles.get(handle.toString('hex'));
                        if (!h) { log('READ handle inválido'); return sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                        try {
                            const buf = Buffer.alloc(length);
                            const { bytesRead } = await h.fd.read(buf, 0, length, offset);
                            sftpStream.data(reqid, buf.subarray(0, bytesRead));
                        } catch (e:any) { log('READ erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });

                    sftpStream.on('WRITE', async (reqid, handle, offset, data) => {
                        log('WRITE', { offset, len: data.length });
                        const h = fileHandles.get(handle.toString('hex'));
                        if (!h) { log('WRITE handle inválido'); return sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                        try {
                            await h.fd.write(data, 0, data.length, offset);
                            sftpStream.status(reqid, SFTP_CODE.OK);
                        } catch (e:any) { log('WRITE erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });

                    sftpStream.on('CLOSE', async (reqid, handle) => {
                        log('CLOSE');
                        const key = handle.toString('hex');
                        const fh = fileHandles.get(key);
                        if (fh) {
                            try { await fh.fd.close(); } catch {}
                            fileHandles.delete(key);
                            return sftpStream.status(reqid, SFTP_CODE.OK);
                        }
                        if (dirHandles.has(key)) {
                            dirHandles.delete(key);
                            return sftpStream.status(reqid, SFTP_CODE.OK);
                        }
                        sftpStream.status(reqid, SFTP_CODE.FAILURE);
                    });

                    sftpStream.on('REMOVE', async (reqid, pth) => {
                        log('REMOVE', pth);
                        try { await fsp.unlink(normalize(pth)); sftpStream.status(reqid, SFTP_CODE.OK); }
                        catch (e:any) { log('REMOVE erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });
                    sftpStream.on('MKDIR', async (reqid, pth) => {
                        log('MKDIR', pth);
                        try { await fsp.mkdir(normalize(pth), { recursive: true }); sftpStream.status(reqid, SFTP_CODE.OK); }
                        catch (e:any) { log('MKDIR erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });
                    sftpStream.on('RMDIR', async (reqid, pth) => {
                        log('RMDIR', pth);
                        try { await fsp.rmdir(normalize(pth)); sftpStream.status(reqid, SFTP_CODE.OK); }
                        catch (e:any) { log('RMDIR erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });
                    sftpStream.on('RENAME', async (reqid, oldPath, newPath) => {
                        log('RENAME', { oldPath, newPath });
                        try { await fsp.rename(normalize(oldPath), normalize(newPath)); sftpStream.status(reqid, SFTP_CODE.OK); }
                        catch (e:any) { log('RENAME erro', e?.message||e); sftpStream.status(reqid, SFTP_CODE.FAILURE); }
                    });
                });
            });
        });

        client.on('end', () => log('Cliente encerrou conexão'));
        client.on('close', () => log('Conexão fechada'));
        client.on('error', (e: Error) => {
            log('Erro cliente', e.message);
        });
    });

    ssh.on('error', (e: Error) => log('Erro servidor', e.message));
    ssh.listen(port, '0.0.0.0', () => {
        log(`Servidor SFTP escutando em 0.0.0.0:${port}`);
    });
}

// --- HELPERS ---
function statsToAttrs(st: fs.Stats) {
    return {
        mode: st.mode, // inclui bits do tipo (S_IFDIR etc.)
        uid: (st as any).uid ?? 0,
        gid: (st as any).gid ?? 0,
        size: st.size,
        atime: Math.floor(st.atimeMs / 1000),
        mtime: Math.floor(st.mtimeMs / 1000),
        ctime: Math.floor(st.ctimeMs / 1000)
    } as any;
}

function formatLongname(name: string, st: fs.Stats): string {
    // tipo
    let typeChar = '-';
    if (st.isDirectory()) typeChar = 'd';
    else if (st.isSymbolicLink()) typeChar = 'l';
    // permissões básicas (se não quiser granular, usa 755 p/ dir, 644 p/ file)
    const perm = st.isDirectory() ? 'rwxr-xr-x' : 'rw-r--r--';
    const nlink = 1;
    const owner = 'owner';
    const group = 'group';
    const size = st.size.toString().padStart(6, ' ');
    const d = new Date(st.mtimeMs);
    const month = d.toLocaleString('en-US', { month: 'short' });
    const day = d.getDate().toString().padStart(2, ' ');
    const timeOrYear = d.getFullYear().toString();
    return `${typeChar}${perm} ${nlink} ${owner} ${group} ${size} ${month} ${day} ${timeOrYear} ${name}`;
}

function flagsToFsFlags(flags: number): string {
    // Simplificação: se incluir WRITE flag (0x0002) tratamos como leitura+escrita
    const SSH2_FXF_WRITE = 0x0002;
    const SSH2_FXF_CREAT = 0x0008;
    if (flags & SSH2_FXF_WRITE || flags & SSH2_FXF_CREAT) return 'w+';
    return 'r';
}

// Armazena handles simples
const fileHandles = new Map<string, { fd: fsp.FileHandle }>();
const dirHandles = new Map<string, { path: string; entries: fs.Dirent[]; sent: boolean }>();
