import {execFileSync} from 'node:child_process';
import {readFileSync, existsSync, lstatSync} from 'node:fs';
import {posix, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {marked} from 'marked';

// Pass an explicit file inventory so ignored data is never traversed or read.
export function auditRepository({files, read, policy}) {
  const errors = [];
  const inventory = new Set(files);
  const allowed = policy.paths.map(pattern => new RegExp(pattern));
  const packageJson = JSON.parse(read('package.json'));
  const edges = new Map();
  const report = (file, message) => errors.push(`${file}: ${message}`);
  for (const file of files) {
    if (!allowed.some(pattern => pattern.test(file))) report(file, '目录或文件名不符合组织规则');
    if (/(?:^|[-/])(final|new|old|backup|v\d+|\d{8}|\d{4}-\d{2}-\d{2})(?=(?:\.test)?\.[^.]+$)/.test(file)) {
      report(file, '使用职责名称，副本和临时版本放入 .scratch/');
    }
  }
  for (const file of policy.required) {
    if (!inventory.has(file)) report(file, '缺少必需文档');
  }
  function checkTarget(file, href, base = posix.dirname(file)) {
    if (/^(?:https?:|mailto:)/i.test(href) || href.startsWith('#')) return;
    let decoded;
    try { decoded = decodeURIComponent(href.split(/[?#]/)[0]); }
    catch { report(file, `无效链接编码：${href}`); return; }
    if (!decoded || /^[a-z][a-z0-9+.-]*:|^[/\\]/i.test(decoded) || decoded.includes('\\')) {
      report(file, `请使用仓库内相对链接：${href}`); return;
    }
    const target = posix.normalize(posix.join(base, decoded));
    if (target === '.' || target === './') return;
    const directory = target.replace(/\/$/, '') + '/';
    if (target.startsWith('../') || (!inventory.has(target) && !files.some(path => path.startsWith(directory)))) {
      report(file, `链接或路径不存在（含大小写或被忽略）：${href}`); return;
    }
    if (inventory.has(target) && target.endsWith('.md')) edges.get(file)?.add(target);
  }
  function checkCommands(file, text) {
    for (const match of text.matchAll(/\bnpm\s+run\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|()<>`]+))/g)) {
      const name = match[1] ?? match[2] ?? match[3];
      if (!Object.hasOwn(packageJson.scripts ?? {}, name)) report(file, `npm script 不存在：${name}`);
    }
    for (const match of text.matchAll(/\b(?:node|python|python3)\s+((?:scripts|app)\/[^\s`'";]+)/g)) {
      checkTarget(file, match[1], '.');
    }
  }
  for (const file of files.filter(path => path.endsWith('.md'))) {
    const source = read(file);
    const tokens = marked.lexer(source);
    if (!tokens.some(token => token.type === 'heading' && token.depth === 1)) report(file, '缺少一级标题');
    edges.set(file, new Set());
    marked.walkTokens(tokens, token => {
      if (token.type === 'link' || token.type === 'image') checkTarget(file, token.href);
      if (token.type === 'code' || token.type === 'codespan') {
        checkCommands(file, token.text);
        if (token.type === 'codespan' && /^(?:(app|scripts|tests|config|prototypes|docs)\/[^\s]+\.[a-z]+|[A-Z]+\.md)$/.test(token.text)) {
          checkTarget(file, token.text, '.');
        }
      }
      if (token.type === 'html') {
        for (const match of token.text.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/g)) checkTarget(file, match[1]);
      }
      // Missing reference definitions remain text; code spans are not links.
      if (token.type === 'text' && !token.tokens?.length && /\[[^\]]+\]\[[^\]]*\]/.test(token.raw)) {
        const refs = [...token.raw.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)];
        for (const [, label, reference] of refs) {
          const key = (reference || label).replace(/\s+/g, ' ').toLowerCase();
          if (!tokens.links[key]) report(file, `未定义的引用链接：${reference || label}`);
        }
      }
    });
  }
  const reachable = new Set();
  function visit(file) {
    if (reachable.has(file)) return;
    reachable.add(file);
    for (const target of edges.get(file) ?? []) visit(target);
  }
  visit('docs/index.md');
  for (const file of files.filter(path => path.startsWith('docs/') && path.endsWith('.md'))) {
    if (!reachable.has(file)) report(file, '未从 docs/index.md 导航到此文档');
  }
  for (const command of Object.values(packageJson.scripts ?? {})) checkCommands('package.json', command);
  return errors;
}

export function checkWorkingTree(root) {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd: root, encoding: 'utf8'});
  const files = [...new Set(listed.split('\0').filter(Boolean))].filter(file => existsSync(resolve(root, file)));
  const symlinks = files.filter(file => lstatSync(resolve(root, file)).isSymbolicLink());
  if (symlinks.length) return symlinks.map(file => `${file}: 检查范围只接受普通仓库文件`);
  const read = file => readFileSync(resolve(root, file), 'utf8');
  return auditRepository({files, read, policy: JSON.parse(read('config/doc-guard.json'))});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkWorkingTree(process.cwd());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Doc guard passed: layout, names, documentation links and commands.');
}
