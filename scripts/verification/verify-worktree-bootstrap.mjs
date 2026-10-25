import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {ensureLocalDirectory, environmentPath} from '../lib/worktree-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--full')) throw new Error('仅支持 --full 参数');
await ensureLocalDirectory(root, '.scratch');
const directory = await mkdtemp(join(root, '.scratch', 'bootstrap-smoke-'));
let registered = false;
let server;
let exited;
function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {cwd: directory, stdio: 'inherit', windowsHide: true});
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.status}`);
}
try {
  const added = spawnSync('git', ['worktree', 'add', '--detach', directory, 'HEAD'], {cwd: root, stdio: 'inherit', windowsHide: true});
  if (added.error || added.status !== 0) throw new Error('无法创建验证 worktree');
  registered = true;
  run(process.execPath, ['scripts/operations/bootstrap-worktree.mjs', ...(args.includes('--full') ? [] : ['--core-only'])]);
  const first = JSON.parse(await readFile(join(directory, environmentPath), 'utf8'));
  await writeFile(join(directory, 'data', 'preservation-probe.txt'), 'preserved');
  run(process.execPath, ['scripts/operations/bootstrap-worktree.mjs', '--core-only']);
  assert.deepEqual(JSON.parse(await readFile(join(directory, environmentPath), 'utf8')), first);
  assert.equal(await readFile(join(directory, 'data', 'preservation-probe.txt'), 'utf8'), 'preserved');
  const env = {...process.env};
  delete env.MIDO_PORT;
  server = spawn(process.execPath, ['scripts/operations/start-dev.mjs'], {cwd: directory, env, stdio: 'inherit', windowsHide: true});
  exited = once(server, 'exit');
  // Observe spawn errors immediately rather than creating an unhandled rejection.
  void exited.catch(() => {});
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${first.port}/api/questions`, {signal: AbortSignal.timeout(1000)});
      if (response.ok) {
        assert.deepEqual(await response.json(), []);
        ready = true;
        break;
      }
    } catch (error) {
      if (error.name === 'AssertionError') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, '新 worktree 的独立应用应可启动且为空库');
  console.log('PASS: fresh worktree bootstrap, repeat setup, preserved data and isolated development server.');
} finally {
  if (server && server.exitCode === null) { server.kill(); await exited; }
  if (registered) {
    // Only remove the exact disposable checkout created above, within this repo's ignored scratch directory.
    assert.equal(dirname(directory), join(root, '.scratch'));
    const removed = spawnSync('git', ['worktree', 'remove', '--force', directory], {cwd: root, stdio: 'inherit', windowsHide: true});
    if (removed.error || removed.status !== 0) {
      console.error(`验证 worktree 清理失败：${directory}`);
      process.exitCode = 1;
    }
  }
}
