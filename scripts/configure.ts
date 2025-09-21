#!/usr/bin/env ts-node
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

interface Args {
  remote: string;
  uuid: string;
  token: string;
  port?: number;
  sftp?: number;
  path?: string;
  help?: boolean;
  ssl?: boolean;
  cert?: string;
  key?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { remote: '', uuid: '', token: '' } as any;
  for (const a of argv.slice(2)) {
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    switch (key) {
      case 'remote': args.remote = value; break;
      case 'uuid': args.uuid = value; break;
      case 'token': args.token = value; break;
      case 'port': args.port = Number(value); break;
      case 'sftp': args.sftp = Number(value); break;
      case 'path': args.path = value; break;
      case 'ssl': args.ssl = /^(1|true|yes)$/i.test(value); break;
      case 'cert': args.cert = value; break;
      case 'key': args.key = value; break;
    }
  }
  return args;
}

function showHelp() {
  console.log(`Uso: npm run configure -- --remote=URL --uuid=UUID --token=TOKEN [--port=NUM] [--sftp=NUM] [--path=/etc/xyz] [--ssl=true] [--cert=/caminho/cert.pem] [--key=/caminho/key.pem]\n` +
`Se --port/--sftp não forem passados, o script tenta POST {remote}/api/nodes/helper/fetch-ports { uuid, token } esperando { port, sftp, ssl }.`);
}

async function fetchRemote(remote: string, uuid: string, token: string): Promise<{port?: number; sftp?: number; ssl?: boolean}> {
  const base = remote.replace(/\/$/, '') + '/api/nodes/helper';
  try {
    const resp = await axios.post(base + '/fetch-ports', { uuid, token });
    const { port, sftp, ssl } = resp.data || {};
    const out: {port?: number; sftp?: number; ssl?: boolean} = {};
    if (typeof port === 'number') out.port = port;
    if (typeof sftp === 'number') out.sftp = sftp;
    if (typeof ssl === 'boolean') out.ssl = ssl;
    return out;
  } catch (e: any) {
    console.warn('Falha ao buscar dados remotos:', e?.message);
    return {};
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { showHelp(); process.exit(0); }
  if (!args.remote || !args.uuid || !args.token) {
    console.error('Erro: --remote, --uuid e --token são obrigatórios. Use --help para ajuda.');
    process.exit(1);
  }

  let fetched: {port?: number; sftp?: number; ssl?: boolean} = {};
  if (!args.port || !args.sftp || args.ssl === undefined) {
    fetched = await fetchRemote(args.remote, args.uuid, args.token);
  }
  if (!args.port && fetched.port) args.port = fetched.port;
  if (!args.sftp && fetched.sftp) args.sftp = fetched.sftp;
  if (args.ssl === undefined && fetched.ssl !== undefined) args.ssl = fetched.ssl;

  if (!args.port || !args.sftp) {
    console.warn('Portas não definidas (faltou --port/--sftp e fetch remoto falhou). Usando defaults 8080/2022.');
    if (!args.port) args.port = 8080;
    if (!args.sftp) args.sftp = 2022;
  }
  if (args.ssl === undefined) args.ssl = false;

  const configPath = path.resolve(process.cwd(), 'config.json');
  let existing: any = {};
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    existing = JSON.parse(raw);
  } catch { /* ignora, vamos criar */ }

  const newConfig = {
    uuid: args.uuid,
    port: args.port,
    sftp: args.sftp,
    remote: args.remote.replace(/\/$/, ''),
    token: args.token,
    path: args.path || existing.path || '/etc/enderd',
    ssl: !!args.ssl,
    certPath: args.cert || existing.certPath || '/etc/enderd/certs/cert.pem',
    keyPath: args.key || existing.keyPath || '/etc/enderd/certs/key.pem'
  };

  if (newConfig.ssl) {
    // Aviso rápido se cert/key aparentam não existir (best-effort)
    await Promise.all(['certPath','keyPath'].map(async k => {
      const p = (newConfig as any)[k];
      try { await fs.access(p); } catch { console.warn(`Aviso: arquivo ${p} não encontrado agora (verificado best-effort).`); }
    }));
  }

  await fs.writeFile(configPath, JSON.stringify(newConfig, null, 2) + '\n', 'utf8');
  console.log('Concluído.');
}

main().catch(e => { console.error('Falha inesperada:', e); process.exit(1); });
