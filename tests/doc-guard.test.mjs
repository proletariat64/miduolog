import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditRepository} from '../scripts/checks/doc-guard.mjs';
import {checkWorkingTree} from '../scripts/checks/doc-guard.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {testDirectory} from './helpers.mjs';

const policy = JSON.parse(readFileSync(new URL('../config/doc-guard.json', import.meta.url), 'utf8'));
function fixture() {
  const files = Object.fromEntries(policy.required.map(file => [file, '# Title\n']));
  files['docs/index.md'] += policy.required.map(file => `[doc](../${file})`).join('\n');
  files['package.json'] = JSON.stringify({scripts: {'docs:check': 'node scripts/checks/doc-guard.mjs'}});
  files['scripts/checks/doc-guard.mjs'] = '';
  return files;
}
function audit(files) {
  return auditRepository({files: Object.keys(files), read: file => files[file], policy});
}

test('valid structure, reference links, encoded filenames and external links pass', () => {
  const files = fixture();
  files['README.md'] += '\n[guide][g]\n\n[g]: docs/%67lossary.md "Glossary"\n\n[web](https://example.org)\n';
  files['README.md'] += '\n```sh\nnpm run docs:check\n```\n';
  files['scripts/operations/backup-database.mjs'] = '';
  files['config/vision-requirements.txt'] = 'Pillow==12.1.1';
  assert.deepEqual(audit(files), []);
});

test('old locations, misnamed files, private data and copy suffixes fail', () => {
  for (const path of ['GLOSSARY.md', 'scripts/import-paper.mjs', 'docs/Bad_Name.md', 'data/private.sqlite', 'docs/design-final.md', 'docs/design-2026-10-25.md']) {
    const files = fixture();
    files[path] = '# Title\n';
    assert.ok(audit(files).some(error => error.startsWith(path + ':')), path);
  }
});

test('renamed targets, casing, ignored reports and path escapes fail', () => {
  for (const href of ['docs/deleted.md', 'docs/Glossary.md', '.scratch/report.md', '../outside.md', 'C:/private.md', 'docs/%ZZ.md']) {
    const files = fixture();
    files['README.md'] += `\n[broken](${href})\n`;
    assert.ok(audit(files).some(error => error.startsWith('README.md:')), href);
  }
});

test('unlinked documents and missing required documents fail', () => {
  const files = fixture();
  files['docs/orphan.md'] = '# Orphan\n';
  delete files['docs/glossary.md'];
  const errors = audit(files);
  assert.ok(errors.some(error => error.includes('未从 docs/index.md')));
  assert.ok(errors.some(error => error.includes('缺少必需文档')));
});

test('unknown npm commands and moved script paths fail in inline and fenced examples', () => {
  const files = fixture();
  files['README.md'] += '\n`npm run missing`\n```sh\nnode scripts/moved.mjs\n```\n';
  files['README.md'] += '\n`app/deleted.mjs`\n';
  files['README.md'] += '\n`GLOSSARY.md`\n';
  const errors = audit(files);
  assert.ok(errors.some(error => error.includes('npm script 不存在：missing')));
  assert.ok(errors.some(error => error.includes('scripts/moved.mjs')));
  assert.ok(errors.some(error => error.includes('app/deleted.mjs')));
  assert.ok(errors.some(error => error.includes('GLOSSARY.md')));
});

test('code examples are not mistaken for live Markdown links', () => {
  const files = fixture();
  files['README.md'] += '\n```md\n[example](missing.md)\n```\n';
  files['README.md'] += '\nSyntax example: `[label][reference]`.\n';
  files['README.md'] += '\n- Syntax example: `[label][reference]`.\n';
  assert.deepEqual(audit(files), []);
});

test('working tree includes new files, skips ignored data, and rejects force-tracked data', async t => {
  const root = await testDirectory(t);
  const files = fixture();
  files['config/doc-guard.json'] = JSON.stringify(policy);
  files['.gitignore'] = 'data/\n.scratch/\n';
  files['data/private.sqlite'] = 'not a database';
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, content);
  }
  execFileSync('git', ['init', '--quiet', root]);
  assert.deepEqual(checkWorkingTree(root), []);
  await writeFile(join(root, 'docs', 'orphan.md'), '# Orphan\n');
  assert.ok(checkWorkingTree(root).some(error => error.includes('未从 docs/index.md')));
  execFileSync('git', ['add', '--force', 'data/private.sqlite'], {cwd: root});
  assert.ok(checkWorkingTree(root).some(error => error.startsWith('data/private.sqlite:')));
});

test('reference link targets and HTML links are checked', () => {
  for (const text of ['[x][ref]\n\n[ref]: missing.md', '<a href="missing.md">x</a>', '[x][undefined]']) {
    const files = fixture();
    files['README.md'] += '\n' + text + '\n';
    assert.ok(audit(files).some(error => error.startsWith('README.md:')), text);
  }
});

test('relative repository-root links work at root and in nested documents', () => {
  const files = fixture();
  files['README.md'] += '\n[root](./)\n';
  files['docs/index.md'] += '\n[root](../)\n';
  assert.deepEqual(audit(files), []);
});

test('npm script names are compared in full, including dots and quoted names', () => {
  const files = fixture();
  files['package.json'] = JSON.stringify({scripts: {'test.unit': 'node --test', 'test unit': 'node --test'}});
  files['README.md'] += '\n```sh\nnpm run test.unit\nnpm run "test unit"\n```\n';
  files['README.md'] += '\n```sh\n(npm run test.unit)\nnpm run test.unit>check.log\nnpm run test.unit<input.txt\n```\n';
  assert.deepEqual(audit(files), []);
  files['README.md'] += '\n`npm run test.unit.missing`\n';
  assert.ok(audit(files).some(error => error.includes('npm script 不存在：test.unit.missing')));
});
