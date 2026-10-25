import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, readFile, writeFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {testDirectory, png} from './helpers.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/verification/verify-architecture-data.mjs', import.meta.url));

test('snapshot and verification preserve file-backed WAL rows and image digests', async t => {
  let db;
  t.after(() => db?.close());
  const cwd = await testDirectory(t);
  await mkdir(join(cwd, 'data/images'), {recursive: true});
  await writeFile(join(cwd, 'data/images/paper.png'), png('snapshot'));
  const path = join(cwd, 'data/notebook.sqlite');
  db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE imports(id TEXT,state TEXT);
    CREATE TABLE questions(id TEXT,content TEXT);
    CREATE TABLE review_sessions(id TEXT);
    CREATE TABLE review_items(id TEXT,state TEXT,answer TEXT);
    CREATE TABLE review_disputes(itemId TEXT);
    INSERT INTO imports VALUES ('paper','completed');
    INSERT INTO questions VALUES ('question','original content');
    INSERT INTO review_items VALUES ('answer','graded','saved answer');`);
  assert.ok((await stat(path + '-wal')).size > 32, 'committed rows must still be in WAL');
  const snapshot = await run(process.execPath, [script, '--snapshot'], {cwd, timeout: 10000});
  const {backupPath} = JSON.parse(snapshot.stdout);
  const copied = new DatabaseSync(backupPath, {readOnly: true});
  assert.equal(copied.prepare('SELECT answer FROM review_items').get().answer, 'saved answer'); copied.close();
  const result = await run(process.execPath, [script], {cwd, timeout: 10000});
  assert.match(result.stdout, /PASS/);
  const baseline = JSON.parse(await readFile(join(cwd, '.scratch/mistake-notebook/architecture/baseline.json'), 'utf8'));
  assert.equal(baseline.rows.questions[0].content, 'original content');
});


test('upgrade preservation check detects changed original intake attempts and compound-key source relations', async t => {
  let db; t.after(() => db?.close());
  const cwd = await testDirectory(t);
  await mkdir(join(cwd, 'data'), {recursive: true});
  db = new DatabaseSync(join(cwd, 'data/notebook.sqlite'));
  db.exec(`CREATE TABLE imports(id TEXT,state TEXT); CREATE TABLE questions(id TEXT,content TEXT);
    CREATE TABLE review_sessions(id TEXT); CREATE TABLE review_items(id TEXT,state TEXT,answer TEXT); CREATE TABLE review_disputes(itemId TEXT);
    CREATE TABLE intake_attempts(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE intake_batch_photos(batchId TEXT,photoId TEXT,position INTEGER,PRIMARY KEY(batchId,photoId));
    INSERT INTO intake_attempts VALUES ('attempt','original answer and teacher evidence');
    INSERT INTO intake_batch_photos VALUES ('batch','photo-a',0),('batch','photo-b',1);`);
  await run(process.execPath, [script, '--snapshot'], {cwd, timeout: 10000});
  assert.match((await run(process.execPath, [script], {cwd, timeout: 10000})).stdout, /PASS/);
  db.exec("UPDATE intake_attempts SET data='overwritten answer' WHERE id='attempt'");
  await assert.rejects(run(process.execPath, [script], {cwd, timeout: 10000}), /intake_attempts/);
  db.exec("UPDATE intake_attempts SET data='original answer and teacher evidence' WHERE id='attempt'; UPDATE intake_batch_photos SET position=9 WHERE photoId='photo-b'");
  await assert.rejects(run(process.execPath, [script], {cwd, timeout: 10000}), /intake_batch_photos/);
});


test('snapshot refuses active intake work and also supports a standalone intake database', async t => {
  let db; t.after(() => db?.close());
  const cwd = await testDirectory(t);
  await mkdir(join(cwd, 'data'), {recursive: true});
  db = new DatabaseSync(join(cwd, 'data/notebook.sqlite'));
  db.exec(`CREATE TABLE intake_photos(id TEXT,state TEXT); CREATE TABLE intake_batches(id TEXT,state TEXT);
    INSERT INTO intake_photos VALUES ('photo','processing'); INSERT INTO intake_batches VALUES ('batch','completed');`);
  await assert.rejects(run(process.execPath, [script, '--snapshot'], {cwd, timeout: 10000}), /仍有处理中的/);
  db.exec("UPDATE intake_photos SET state='completed'; UPDATE intake_batches SET state='processing'");
  await assert.rejects(run(process.execPath, [script, '--snapshot'], {cwd, timeout: 10000}), /仍有处理中的/);
  db.exec("UPDATE intake_batches SET state='completed'");
  const snapshot = await run(process.execPath, [script, '--snapshot'], {cwd, timeout: 10000});
  assert.ok(JSON.parse(snapshot.stdout).backupPath);
  assert.match((await run(process.execPath, [script], {cwd, timeout: 10000})).stdout, /PASS/);
});


test('upgrade preservation detects removal of an original all-null column', async t => {
  let db; t.after(() => db?.close()); const cwd = await testDirectory(t);
  await mkdir(join(cwd, 'data'), {recursive: true}); db = new DatabaseSync(join(cwd, 'data/notebook.sqlite'));
  db.exec("CREATE TABLE preserved(id TEXT,nullable TEXT); INSERT INTO preserved VALUES ('one',NULL)");
  await run(process.execPath, [script, '--snapshot'], {cwd, timeout: 10000});
  db.exec('ALTER TABLE preserved DROP COLUMN nullable');
  await assert.rejects(run(process.execPath, [script], {cwd, timeout: 10000}), /nullable/);
});


test('upgrade preservation detects schema loss in an empty original table', async t => {
  let db; t.after(() => db?.close()); const cwd = await testDirectory(t);
  await mkdir(join(cwd, 'data'), {recursive: true}); db = new DatabaseSync(join(cwd, 'data/notebook.sqlite'));
  db.exec('CREATE TABLE empty_records(id TEXT,original_field TEXT)');
  await run(process.execPath, [script, '--snapshot'], {cwd, timeout: 10000});
  db.exec('ALTER TABLE empty_records DROP COLUMN original_field');
  await assert.rejects(run(process.execPath, [script], {cwd, timeout: 10000}), /original_field/);
});
