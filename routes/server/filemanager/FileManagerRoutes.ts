import { FastifyReply, FastifyRequest } from "fastify";
import fs from 'fs/promises';
import path from 'path';
import { hasPermission } from "../../../libs/RemoteConnect";
import Server, { BASE_SERVER_PATH } from "../../../libs/Server";
import config from '../../../config.json';
import AdmZip from 'adm-zip';
import tar from 'tar'; // adicionada dependência para .tar.gz

interface CommonBody {
    token: string;
    userUuid: string;
    serverId: string;
}

function validateAuth(body: any): { ok: boolean; message?: string } {
    if(!body?.token) return { ok: false, message: 'token é obrigatório' };
    if(body.token !== config.token) return { ok: false, message: 'token inválido' };
    if(!body.serverId) return { ok: false, message: 'serverId é obrigatório' };
    if(!body.userUuid) return { ok: false, message: 'userUuid é obrigatório' };
    return { ok: true };
}

function sanitizeRelative(p?: string): string {
    if(!p || p === '/' || p === '.') return '';
    // remove \ inicial, espaços extras
    let rel = p.replace(/^[\\/]+/, '').trim();
    // bloqueia path traversal
    if(rel.split(/[/\\]/).some(seg => seg === '..')) throw new Error('Caminho não permitido');
    return rel.replace(/\\/g, '/');
}

function resolveServerPath(serverId: string, rel: string): string {
    const base = path.join(BASE_SERVER_PATH, serverId);
    const abs = path.resolve(base, rel);
    if(!abs.startsWith(path.resolve(base))) throw new Error('Fora do diretório do servidor');
    return abs;
}

async function ensurePermission(body: CommonBody) {
    const server = Server.getServer(body.serverId);
    if(!server) throw new Error('Servidor não encontrado');
    const perm = await hasPermission(body.userUuid, server);
    if(!perm) throw new Error('Sem permissão');
    return server;
}

async function handleList(body: any, reply: FastifyReply) {
    const rel = sanitizeRelative(body.path);
    const dirAbs = resolveServerPath(body.serverId, rel);
    let entries;
    try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
        return reply.code(404).send({ error: 'Diretório não encontrado' });
    }
    const out = await Promise.all(entries.map(async (e) => {
        const full = path.join(dirAbs, e.name);
        let stat; try { stat = await fs.stat(full); } catch { return null; }
        return {
            name: e.name,
            type: e.isDirectory() ? 'folder' : 'file',
            size: e.isDirectory() ? null : stat.size,
            lastModified: stat.mtimeMs,
            path: (rel ? rel + '/' : '') + e.name
        };
    }));
    return reply.send({ path: '/' + rel, items: out.filter(Boolean) });
}

async function handleRead(body: any, reply: FastifyReply) {
    if(!body.path) return reply.code(400).send({ error: 'path é obrigatório' });
    const rel = sanitizeRelative(body.path);
    const fileAbs = resolveServerPath(body.serverId, rel);
    let stat;
    try { stat = await fs.stat(fileAbs); } catch { return reply.code(404).send({ error: 'Arquivo não existe' }); }
    if(stat.isDirectory()) return reply.code(400).send({ error: 'path é diretório' });
    if(stat.size > 2 * 1024 * 1024) return reply.code(413).send({ error: 'Arquivo muito grande (>2MB) para leitura inline' });
    const content = await fs.readFile(fileAbs, 'utf8');
    return reply.send({ path: '/' + rel, size: stat.size, lastModified: stat.mtimeMs, content });
}

async function handleWrite(body: any, reply: FastifyReply) {
    if(!body.path) return reply.code(400).send({ error: 'path é obrigatório' });
    if(typeof body.content !== 'string') return reply.code(400).send({ error: 'content é obrigatório' });
    const rel = sanitizeRelative(body.path);
    const fileAbs = resolveServerPath(body.serverId, rel);
    await fs.mkdir(path.dirname(fileAbs), { recursive: true });
    await fs.writeFile(fileAbs, body.content, 'utf8');
    return reply.send({ status: 'ok' });
}

async function handleRename(body: any, reply: FastifyReply) {
    if(!body.path || !body.newName) return reply.code(400).send({ error: 'path e newName são obrigatórios' });
    if(/[/\\]/.test(body.newName)) return reply.code(400).send({ error: 'newName inválido' });
    const rel = sanitizeRelative(body.path);
    const fileAbs = resolveServerPath(body.serverId, rel);
    let stat; try { stat = await fs.stat(fileAbs); } catch { return reply.code(404).send({ error: 'Origem não existe' }); }
    const newAbs = path.join(path.dirname(fileAbs), body.newName);
    try { await fs.rename(fileAbs, newAbs); } catch { return reply.code(500).send({ error: 'Falha ao renomear' }); }
    return reply.send({ status: 'ok', oldPath: '/' + rel, newPath: '/' + sanitizeRelative(path.relative(path.join(BASE_SERVER_PATH, body.serverId), newAbs)) });
}

async function handleDownload(body: any, reply: FastifyReply) {
    if(!body.path) return reply.code(400).send({ error: 'path é obrigatório' });
    const rel = sanitizeRelative(body.path);
    const fileAbs = resolveServerPath(body.serverId, rel);
    let stat; try { stat = await fs.stat(fileAbs); } catch { return reply.code(404).send({ error: 'Arquivo não existe' }); }
    if(stat.isDirectory()) return reply.code(400).send({ error: 'Não é arquivo' });
    const buff = await fs.readFile(fileAbs);
    // devolve base64
    return reply.send({ fileName: path.basename(fileAbs), size: stat.size, base64: buff.toString('base64') });
}

async function handleMass(body: any, reply: FastifyReply) {
    const { paths, action } = body;
    if(!Array.isArray(paths) || paths.length === 0) return reply.code(400).send({ error: 'paths vazio' });
    if(action !== 'delete' && action !== 'archive') return reply.code(400).send({ error: 'action inválido' });
    const results: any[] = [];
    const baseRoot = path.join(BASE_SERVER_PATH, body.serverId);
    if(action === 'delete') {
        for(const p of paths) {
            try {
                const rel = sanitizeRelative(p);
                const abs = resolveServerPath(body.serverId, rel);
                await fs.rm(abs, { recursive: true, force: true });
                results.push({ path: '/' + rel, status: 'deleted' });
            } catch(e:any) {
                results.push({ path: p, status: 'error', error: e.message });
            }
        }
        return reply.send({ status: 'ok', results });
    }
    // archive
    const zipName = body.archiveName && typeof body.archiveName === 'string' ? body.archiveName.replace(/\.zip$/i,'') : 'archive-' + Date.now();
    const finalZipAbs = path.join(baseRoot, zipName + '.zip');
    const zip = new AdmZip();
    for(const p of paths) {
        try {
            const rel = sanitizeRelative(p);
            const abs = resolveServerPath(body.serverId, rel);
            const st = await fs.stat(abs);
            if(st.isDirectory()) {
                zip.addLocalFolder(abs, rel);
            } else {
                zip.addLocalFile(abs, rel);
            }
            results.push({ path: '/' + rel, status: 'added' });
        } catch(e:any) {
            results.push({ path: p, status: 'error', error: e.message });
        }
    }
    zip.writeZip(finalZipAbs);
    return reply.send({ status: 'ok', archive: '/' + sanitizeRelative(path.relative(baseRoot, finalZipAbs)), results });
}

// === NOVOS HANDLERS ===
async function handleMkdir(body: any, reply: FastifyReply) {
    if(!body.path) return reply.code(400).send({ error: 'path é obrigatório' });
    const rel = sanitizeRelative(body.path);
    if(!rel) return reply.code(400).send({ error: 'Não pode criar raiz' });
    const abs = resolveServerPath(body.serverId, rel);
    try {
        await fs.mkdir(abs, { recursive: true });
    } catch(e:any) {
        return reply.code(500).send({ error: 'Falha ao criar diretório', detail: e.message });
    }
    return reply.send({ status: 'ok', path: '/' + rel });
}

async function handleMove(body: any, reply: FastifyReply) {
    const { from, to } = body;
    if(!from || !to) return reply.code(400).send({ error: 'from e to são obrigatórios' });
    const relFrom = sanitizeRelative(from);
    const relToRaw = sanitizeRelative(to);
    const absFrom = resolveServerPath(body.serverId, relFrom);
    let statFrom;
    try { statFrom = await fs.stat(absFrom); } catch { return reply.code(404).send({ error: 'origem não existe' }); }
    let finalRelTo = relToRaw;
    const absToCandidate = resolveServerPath(body.serverId, relToRaw);
    let statTo: any = null;
    try { statTo = await fs.stat(absToCandidate); } catch { statTo = null; }
    if(statTo && statTo.isDirectory()) {
        // mover para dentro mantendo nome
        finalRelTo = (relToRaw ? relToRaw + '/' : '') + path.basename(relFrom);
    } else {
        // se termina com / tratar como pasta destino
        if(/\/$/.test(to)) {
            finalRelTo = relToRaw.replace(/\/$/, '') + '/' + path.basename(relFrom);
        }
    }
    const absTo = resolveServerPath(body.serverId, finalRelTo);
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    try {
        await fs.rename(absFrom, absTo);
    } catch(e:any) {
        return reply.code(500).send({ error: 'Falha ao mover', detail: e.message });
    }
    return reply.send({ status: 'ok', from: '/' + relFrom, to: '/' + finalRelTo, type: statFrom.isDirectory() ? 'folder' : 'file' });
}

async function handleUpload(body: any, reply: FastifyReply) {
    const { path: upPath, contentBase64, content } = body;
    if(!upPath) return reply.code(400).send({ error: 'path é obrigatório' });
    const rel = sanitizeRelative(upPath);
    if(!rel || /\/$/.test(upPath)) return reply.code(400).send({ error: 'path deve incluir nome do arquivo' });
    if(!contentBase64 && typeof content !== 'string') return reply.code(400).send({ error: 'contentBase64 ou content requerido' });
    let buffer: Buffer;
    try {
        if(contentBase64) {
            buffer = Buffer.from(String(contentBase64), 'base64');
        } else {
            buffer = Buffer.from(String(content), 'utf8');
        }
    } catch {
        return reply.code(400).send({ error: 'Conteúdo inválido' });
    }
    const MAX_BYTES = 25 * 1024 * 1024; // 25MB
    if(buffer.length > MAX_BYTES) return reply.code(413).send({ error: 'Arquivo excede 25MB' });
    const abs = resolveServerPath(body.serverId, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    try { await fs.writeFile(abs, buffer); } catch(e:any) { return reply.code(500).send({ error: 'Falha ao salvar', detail: e.message }); }
    return reply.send({ status: 'ok', path: '/' + rel, size: buffer.length });
}

// === NOVO HANDLER: UNARCHIVE ===
function sanitizeArchiveEntry(p: string): string {
    // remove drive letters / inicial
    let clean = p.replace(/^([A-Za-z]:)?[\\/]+/, '');
    clean = clean.replace(/\\/g,'/');
    const parts = clean.split('/').filter(seg => seg && seg !== '.');
    if(parts.some(seg => seg === '..')) throw new Error('Entrada de arquivo inválida em archive');
    return parts.join('/');
}

function deriveArchiveBase(name: string): string {
    const lower = name.toLowerCase();
    if(lower.endsWith('.tar.gz')) return name.slice(0, -7);
    if(lower.endsWith('.tgz')) return name.slice(0, -4);
    if(lower.endsWith('.zip') || lower.endsWith('.rar') || lower.endsWith('.tar')) return name.replace(/\.(zip|rar|tar)$/i, '');
    return name.replace(/\.[^.]+$/, '');
}

async function handleUnarchive(body: any, reply: FastifyReply) {
    const { path: archivePath, destination } = body;
    if(!archivePath) return reply.code(400).send({ error: 'path é obrigatório' });
    const relArchive = sanitizeRelative(archivePath);
    const absArchive = resolveServerPath(body.serverId, relArchive);
    let stat; try { stat = await fs.stat(absArchive); } catch { return reply.code(404).send({ error: 'Arquivo não existe' }); }
    if(stat.isDirectory()) return reply.code(400).send({ error: 'path aponta para diretório' });

    const lower = relArchive.toLowerCase();
    const isZip = lower.endsWith('.zip');
    const isRar = lower.endsWith('.rar');
    const isTarGz = lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
    if(!isZip && !isRar && !isTarGz) return reply.code(400).send({ error: 'Formato não suportado (use .zip, .rar ou .tar.gz/.tgz)' });

    // nome base do arquivo (sem extensões) para comparação de flatten
    const archiveBaseName = deriveArchiveBase(path.basename(relArchive));

    // destino relativo
    let destRel: string;
    const userProvidedDestination = !!destination;
    if(destination) {
        destRel = sanitizeRelative(destination);
    } else {
        destRel = archiveBaseName;
        destRel = sanitizeRelative(destRel);
    }
    const destAbs = resolveServerPath(body.serverId, destRel || '');
    try { await fs.mkdir(destAbs, { recursive: true }); } catch {}

    // Determina se precisamos achatar (flatten) o primeiro diretório raiz quando o usuário forneceu destination.
    // Critério: todos os entries estão dentro de uma única pasta cujo nome == archiveBaseName.
    let flatten = false; // será true para zip/tar/rar se condição atendida
    let rootCandidate = '';

    const results: any[] = [];
    try {
        if(isZip) {
            const zip = new AdmZip(absArchive);
            const entries = zip.getEntries();
            if(userProvidedDestination) {
                const names = entries.map(e => (e.entryName || '').replace(/\\/g,'/')).filter(Boolean);
                if(names.length) {
                    const firstTop = names[0].split('/')[0];
                    if(firstTop && names.every(n => n === firstTop || n.startsWith(firstTop + '/')) && firstTop === archiveBaseName) {
                        flatten = true;
                        rootCandidate = firstTop;
                    }
                }
            }
            for(const entry of entries) {
                try {
                    let entryName = sanitizeArchiveEntry(entry.entryName || '');
                    if(!entryName) continue; // ignora root
                    if(flatten) {
                        if(entryName === rootCandidate) continue; // pasta raiz descartada
                        if(entryName.startsWith(rootCandidate + '/')) entryName = entryName.substring(rootCandidate.length + 1);
                        if(!entryName) continue; // tudo dentro apenas de root
                    }
                    const finalAbs = path.join(destAbs, entryName);
                    if(!finalAbs.startsWith(path.resolve(destAbs))) throw new Error('Path fora do destino');
                    const entryIsDir = (entry as any).isDirectory === true || (typeof (entry as any).isDirectory === 'function' && (entry as any).isDirectory());
                    if(entryIsDir) {
                        await fs.mkdir(finalAbs, { recursive: true });
                    } else {
                        await fs.mkdir(path.dirname(finalAbs), { recursive: true });
                        const data = entry.getData();
                        await fs.writeFile(finalAbs, data);
                    }
                    const relOut = sanitizeRelative(path.relative(path.join(BASE_SERVER_PATH, body.serverId), finalAbs));
                    results.push({ path: '/' + relOut, status: 'ok' });
                } catch(e:any) {
                    results.push({ entry: entry.entryName, status: 'error', error: e.message });
                }
            }
        } else if(isTarGz) {
            let stripComponents = 0;
            if(userProvidedDestination) {
                // analisar lista para decidir flatten
                const collected: string[] = [];
                await tar.list({ file: absArchive, gzip: true, onentry: (e:any)=> { collected.push((e.path || '').replace(/\\/g,'/')); } });
                if(collected.length) {
                    const firstTop = collected[0].split('/')[0];
                    if(firstTop && collected.every(n => n === firstTop || n.startsWith(firstTop + '/')) && firstTop === archiveBaseName) {
                        flatten = true; rootCandidate = firstTop; stripComponents = 1;
                    }
                }
            }
            await tar.x({
                file: absArchive,
                cwd: destAbs,
                gzip: true,
                strip: stripComponents,
                filter: (p) => {
                    try { sanitizeArchiveEntry(p); return true; } catch { return false; }
                },
                onentry: (entry: any) => {
                    try {
                        const clean = sanitizeArchiveEntry(entry.path || entry.header?.path || '');
                        if(!clean) return; // root
                        results.push({ path: '/' + sanitizeRelative(path.join(destRel, clean).replace(/\\/g,'/')), status: 'ok' });
                    } catch(e:any) {
                        results.push({ entry: entry.path, status: 'error', error: e.message });
                    }
                }
            });
        } else if(isRar) {
            let createExtractorFromFile: any;
            try { ({ createExtractorFromFile } = require('node-unrar-js')); } catch {
                return reply.code(500).send({ error: 'Suporte a RAR indisponível (dependência)' });
            }
            const extractor = await createExtractorFromFile({ filepath: absArchive });
            const extracted = extractor.extract({ files: ['*'] });
            if(userProvidedDestination) {
                const names = extracted.files.map((f:any)=> (f.fileHeader?.name || '').replace(/\\/g,'/')).filter(Boolean);
                if(names.length) {
                    const firstTop = names[0].split('/')[0];
                    if(firstTop && names.every((n: string) => n === firstTop || n.startsWith(firstTop + '/')) && firstTop === archiveBaseName) {
                        flatten = true; rootCandidate = firstTop;
                    }
                }
            }
            for(const file of extracted.files) {
                try {
                    const header = file.fileHeader;
                    if(!header) continue;
                    let name = sanitizeArchiveEntry(header.name || '');
                    if(!name) continue;
                    if(flatten) {
                        if(name === rootCandidate) continue; // descarta pasta raiz
                        if(name.startsWith(rootCandidate + '/')) name = name.substring(rootCandidate.length + 1);
                        if(!name) continue;
                    }
                    const finalAbs = path.join(destAbs, name);
                    if(!finalAbs.startsWith(path.resolve(destAbs))) throw new Error('Path fora do destino');
                    if(header.flags && header.flags.directory) {
                        await fs.mkdir(finalAbs, { recursive: true });
                    } else if(file.extraction) {
                        await fs.mkdir(path.dirname(finalAbs), { recursive: true });
                        await fs.writeFile(finalAbs, Buffer.from(file.extraction));
                    }
                    const relOut = sanitizeRelative(path.relative(path.join(BASE_SERVER_PATH, body.serverId), finalAbs));
                    results.push({ path: '/' + relOut, status: 'ok' });
                } catch(e:any) {
                    results.push({ entry: file?.fileHeader?.name, status: 'error', error: e.message });
                }
            }
        }
    } catch(e:any) {
        return reply.code(500).send({ error: 'Falha ao descompactar', detail: e.message });
    }

    return reply.send({ status: 'ok', archive: '/' + relArchive, destination: '/' + (destRel || ''), flattened: flatten, results });
}

export async function interpretFileManager(request: FastifyRequest, reply: FastifyReply, subPath: string) {
    const body: any = request.body || {};
    const auth = validateAuth(body);
    if(!auth.ok) return reply.code(400).send({ error: auth.message });

    try { await ensurePermission(body); } catch(e:any) { return reply.code(403).send({ error: e.message }); }

    // subPath exemplos: "list", "read", "write", "rename", "download", "mass"
    switch (subPath) {
        case 'list': return handleList(body, reply);
        case 'read': return handleRead(body, reply);
        case 'write': return handleWrite(body, reply);
        case 'rename': return handleRename(body, reply);
        case 'download': return handleDownload(body, reply);
        case 'mass': return handleMass(body, reply);
        case 'mkdir': return handleMkdir(body, reply);
        case 'move': return handleMove(body, reply);
        case 'upload': return handleUpload(body, reply);
        case 'unarchive': return handleUnarchive(body, reply); // novo
        default:
            return reply.code(404).send({ error: 'ação filemanager desconhecida' });
    }
}
