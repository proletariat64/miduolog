import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {CodexClient} from './codex-client.mjs';
import {createNotebook} from './http-app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, 'data');
await mkdir(dataDir, {recursive: true});
const db = new DatabaseSync(resolve(dataDir, 'notebook.sqlite'));
const client = new CodexClient();
const notebook = await createNotebook({db, client, dataDir});
const port = Number(process.env.MIDO_PORT || 4318);
notebook.server.listen(port, '127.0.0.1', () => console.log('米多错题本已启动：http://127.0.0.1:' + port));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { await notebook.close(); } finally { db.close(); }
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
