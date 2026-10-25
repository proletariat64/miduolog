import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {mkdir, readFile, writeFile, lstat, realpath} from 'node:fs/promises';
import {join, resolve} from 'node:path';

export const environmentPath = '.scratch/worktree/environment.json';

export function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须是 1024–65535 的整数');
  return port;
}

export async function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

// Refuse linked local directories, which would silently share another worktree's data.
export async function ensureLocalDirectory(root, relative) {
  let current = await realpath(root);
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error('本地目录必须位于 worktree 内');
    current = join(current, part);
    await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`本地目录不能是链接或普通文件：${current}`);
  }
}

export async function readEnvironment(root) {
  const filename = join(root, environmentPath);
  try {
    if ((await lstat(filename)).isSymbolicLink()) throw new Error('worktree 环境配置不能是链接');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    if (config.version !== 1) throw new Error('不支持的 worktree 环境配置版本');
    validPort(config.port);
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function localServiceUrl(root, override = process.env.MIDO_URL, portOverride = process.env.MIDO_PORT) {
  if (override) return override;
  if (portOverride) return `http://127.0.0.1:${validPort(portOverride)}`;
  const config = await readEnvironment(root);
  return `http://127.0.0.1:${config?.port ?? 4318}`;
}

export async function prepareEnvironment(root, {port, available = portAvailable} = {}) {
  for (const directory of ['data', 'samples/papers', '.scratch/worktree', '.scratch/local-ci', '.code-review-graph']) {
    await ensureLocalDirectory(root, directory);
  }
  const previous = await readEnvironment(root);
  if (previous && port === undefined) return previous;
  let selected;
  if (port !== undefined) {
    selected = validPort(port);
    if (previous?.port !== selected && !await available(selected)) throw new Error(`端口 ${selected} 已占用，请另选 --port`);
  } else {
    const seed = createHash('sha256').update(resolve(root)).digest().readUInt32BE(0) % 20000;
    for (let offset = 0; offset < 100; offset++) {
      const candidate = 10000 + (seed + offset) % 20000;
      if (await available(candidate)) { selected = candidate; break; }
    }
    if (!selected) throw new Error('未找到可用开发端口，请指定 --port');
  }
  const config = {version: 1, port: selected};
  await writeFile(join(root, environmentPath), JSON.stringify(config, null, 2) + '\n', {flag: previous ? 'w' : 'wx'});
  return config;
}
