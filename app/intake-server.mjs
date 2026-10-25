import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {CodexClient} from './codex-client.mjs';
import {createIntakeServer} from './intake-http.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, process.env.MIDO_INTAKE_DATA || 'data');
await mkdir(dataDir, {recursive: true});
const db = new DatabaseSync(resolve(dataDir, 'notebook.sqlite'));
db.exec('PRAGMA journal_mode=WAL');
const service = await createIntakeServer({db, client: new CodexClient(), dataDir});
const port = Number(process.env.MIDO_INTAKE_PORT || 4319);
service.server.listen(port, '127.0.0.1', () => console.log('录入服务：http://127.0.0.1:' + port));
let stopping = false;
async function close() { if (stopping) return; stopping = true; try { await service.close(); } finally { db.close(); } }
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
