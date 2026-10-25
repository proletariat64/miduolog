import {spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {codexExecutable} from '../../app/codex-runtime.mjs';
import {ensureLocalDirectory, prepareEnvironment, validPort} from '../lib/worktree-environment.mjs';

export function parseOptions(args) {
  const options = {coreOnly: false};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--core-only') options.coreOnly = true;
    else if (args[i] === '--port') options.port = validPort(args[++i]);
    else if (args[i] === '--help') options.help = true;
    else throw new Error(`未知参数：${args[i]}`);
  }
  return options;
}

// Only these fixed commands use cmd.exe on Windows; no user text enters a shell.
export function runCommand(command, args, {cwd, capture = false} = {}) {
  let executable = command;
  let arguments_ = args;
  if (process.platform === 'win32' && ['npm', 'ocr'].includes(command)) {
    const allowed = command === 'npm' ? ['--version', 'ci --include=dev', 'run check'] : ['--version'];
    if (!allowed.includes(args.join(' '))) throw new Error('不支持的 Windows 工具参数');
    executable = process.env.ComSpec || 'cmd.exe';
    arguments_ = ['/d', '/s', '/c', `${command} ${args.join(' ')}`];
  }
  const result = spawnSync(executable, arguments_, {cwd, windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit'});
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败：${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  return result.stdout?.trim() || '';
}

export async function bootstrap(root, options, {run = runCommand, log = console.log, available} = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请先安装 Node.js 24 或以上');
  const invoke = (command, args, capture = false) => run(command, args, {cwd: root, capture});
  log('1/5 检查 Git、Node 和开发工具');
  const gitRoot = invoke('git', ['rev-parse', '--show-toplevel'], true);
  if (resolve(gitRoot) !== resolve(root)) throw new Error('初始化入口必须属于当前 worktree 根目录');
  invoke('npm', ['--version']);
  // git check-ignore exits nonzero when any requested path is not ignored.
  for (const path of ['data/probe', 'samples/probe', '.scratch/probe', '.code-review-graph/probe', 'node_modules/probe']) {
    invoke('git', ['check-ignore', '--quiet', path]);
  }
  if (!options.coreOnly) {
    invoke(codexExecutable(), ['--version']);
    invoke(codexExecutable(), ['login', 'status']);
    invoke('ocr', ['--version']);
    invoke('code-review-graph', ['--version']);
    invoke(process.platform === 'win32' ? 'python' : 'python3', ['--version']);
  }
  log('2/5 准备隔离目录和开发端口');
  const config = await prepareEnvironment(root, {port: options.port, available});
  await ensureLocalDirectory(root, 'node_modules');
  log('3/5 按锁文件安装开发依赖');
  invoke('npm', ['ci', '--include=dev']);
  if (!options.coreOnly) {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const venv = '.scratch/worktree/venv';
    await ensureLocalDirectory(root, venv);
    const venvPython = join(root, venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    invoke(python, ['-m', 'venv', venv]);
    invoke(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', 'config/vision-requirements.txt']);
    log('4/5 构建当前 worktree 的本地图谱');
    invoke('code-review-graph', ['build', '--repo', '.']);
  } else log('4/5 core-only：跳过模型工具、Python 和图谱准备');
  log('5/5 执行 lint、doc guard 和隔离测试');
  invoke('npm', ['run', 'check']);
  log(`初始化成功。运行 npm run dev，开发地址：http://127.0.0.1:${config.port}/`);
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log('npm run bootstrap -- [--core-only] [--port 4320]\n完整环境需要本机已安装并登录 Codex、OCR、code-review-graph 和 Python；不调用模型。');
    else await bootstrap(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), options);
  } catch (error) {
    console.error(`初始化未完成：${error.message}\n修复后可重复执行；环境准备见 docs/worktrees.md。`);
    process.exitCode = 1;
  }
}
