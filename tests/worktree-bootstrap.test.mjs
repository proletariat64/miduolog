import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {testDirectory} from './helpers.mjs';
import {bootstrap, parseOptions} from '../scripts/operations/bootstrap-worktree.mjs';
import {prepareEnvironment, readEnvironment, environmentPath, localServiceUrl} from '../scripts/lib/worktree-environment.mjs';

test('bootstrap options reject invalid ports and unknown flags', () => {
  assert.deepEqual(parseOptions(['--core-only', '--port', '4320']), {coreOnly: true, port: 4320});
  for (const args of [['--port'], ['--port', 'abc'], ['--port', '80'], ['--port', '65536'], ['--unknown']]) {
    assert.throws(() => parseOptions(args));
  }
});

test('repeat setup preserves data and port; independent worktrees keep separate configuration', async t => {
  const first = await testDirectory(t);
  const second = await testDirectory(t);
  await prepareEnvironment(first, {port: 4320, available: async () => true});
  await writeFile(join(first, 'data', 'notebook.sqlite'), 'existing database');
  await prepareEnvironment(first, {available: async () => { throw new Error('must not reassign'); }});
  await prepareEnvironment(second, {port: 4321, available: async () => true});
  assert.equal((await readEnvironment(first)).port, 4320);
  assert.equal((await readEnvironment(second)).port, 4321);
  assert.equal(await readFile(join(first, 'data', 'notebook.sqlite'), 'utf8'), 'existing database');
});

test('busy requested ports and malformed saved configurations fail without replacement', async t => {
  const root = await testDirectory(t);
  await assert.rejects(prepareEnvironment(root, {port: 4320, available: async () => false}), /已占用/);
  await writeFile(join(root, environmentPath), 'broken');
  await assert.rejects(prepareEnvironment(root), SyntaxError);
  assert.equal(await readFile(join(root, environmentPath), 'utf8'), 'broken');
});

test('automatic selection advances past busy ports', async t => {
  const root = await testDirectory(t);
  const attempted = [];
  const config = await prepareEnvironment(root, {available: async port => {
    attempted.push(port);
    return attempted.length === 2;
  }});
  assert.equal(config.port, attempted[1]);
  assert.notEqual(attempted[0], attempted[1]);
});

test('maintenance commands follow the worktree port and support explicit overrides', async t => {
  const root = await testDirectory(t);
  assert.equal(await localServiceUrl(root, ''), 'http://127.0.0.1:4318');
  await prepareEnvironment(root, {port: 4325, available: async () => true});
  assert.equal(await localServiceUrl(root, ''), 'http://127.0.0.1:4325');
  assert.equal(await localServiceUrl(root, 'http://127.0.0.1:4330'), 'http://127.0.0.1:4330');
});

test('setup refuses linked data directories instead of sharing another checkout', async t => {
  const root = await testDirectory(t);
  const shared = await testDirectory(t);
  await mkdir(join(shared, 'data'));
  await symlink(join(shared, 'data'), join(root, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareEnvironment(root), /不能是链接/);
});

test('core bootstrap installs dev dependencies and checks, without model or graph commands', async t => {
  const root = await testDirectory(t);
  const calls = [];
  const config = await bootstrap(root, {coreOnly: true, port: 4320}, {
    available: async () => true, log: () => {},
    run: (command, args) => { calls.push([command, ...args]); return command === 'git' && args[0] === 'rev-parse' ? root : ''; },
  });
  assert.equal(config.port, 4320);
  assert.deepEqual(calls.filter(call => call[0] === 'npm'), [['npm', '--version'], ['npm', 'ci', '--include=dev'], ['npm', 'run', 'check']]);
  assert.ok(calls.every(call => ['git', 'npm'].includes(call[0])));
});

test('failed install stops initialization before checks or a success message', async t => {
  const root = await testDirectory(t);
  const logs = [];
  const calls = [];
  await assert.rejects(bootstrap(root, {coreOnly: true, port: 4320}, {
    available: async () => true, log: line => logs.push(line),
    run: (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'ci') throw new Error('install failed');
      return args[0] === 'rev-parse' ? root : '';
    },
  }), /install failed/);
  assert.ok(!calls.some(call => call.includes('check')));
  assert.ok(!logs.some(line => line.includes('初始化成功')));
});

test('full bootstrap prepares vision dependencies and graph without inference calls', async t => {
  const root = await testDirectory(t);
  const calls = [];
  await bootstrap(root, {coreOnly: false, port: 4320}, {
    available: async () => true, log: () => {},
    run: (command, args) => { calls.push([command, ...args]); return args[0] === 'rev-parse' ? root : ''; },
  });
  assert.ok(calls.some(call => call.includes('login') && call.includes('status')));
  assert.ok(calls.some(call => call.includes('config/vision-requirements.txt')));
  assert.ok(calls.some(call => call[0] === 'code-review-graph' && call[1] === 'build'));
  assert.deepEqual(calls.filter(call => call[0] === 'ocr'), [['ocr', '--version']]);
  assert.deepEqual(calls.at(-1), ['npm', 'run', 'check']);
});
