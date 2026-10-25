import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureLocalDirectory, readEnvironment, validPort} from '../lib/worktree-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
await ensureLocalDirectory(root, '.scratch/worktree');
await ensureLocalDirectory(root, 'data');
const config = await readEnvironment(root);
if (!config) throw new Error('请先执行 npm run bootstrap');
process.env.MIDO_PORT = String(validPort(process.env.MIDO_PORT || config.port));
// Import in-process: server shutdown and Ctrl+C continue to use the existing handlers.
await import('../../app/server.mjs');
