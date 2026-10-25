// Local-only deployment snapshot and preservation check; never sends student data.
import {DatabaseSync, backup} from 'node:sqlite';
import {mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const reportDir = resolve('.scratch/mistake-notebook/architecture');
const reportPath = join(reportDir, 'baseline.json');
const db = new DatabaseSync(resolve('data/notebook.sqlite'), {readOnly: true});
// A separate write reservation keeps application writers out while the read-only
// source is backed up and the original images are hashed (including WAL mode).
const reservation = process.argv.includes('--snapshot') ? new DatabaseSync(resolve('data/notebook.sqlite')) : null;
const tables = ['imports', 'questions', 'review_sessions', 'review_items', 'review_disputes'];
async function imageDigests() {
  const images = {};
  for (const folder of ['data/images', 'data/review-images', 'samples/papers']) {
    let files;
    try { files = await readdir(folder, {withFileTypes: true}); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const file of files.filter(f => f.isFile())) {
      const path = join(folder, file.name);
      images[path] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  return images;
}
try {
  if (process.argv.includes('--snapshot')) {
    reservation.exec('BEGIN IMMEDIATE');
    const imports = db.prepare("SELECT count(*) AS n FROM imports WHERE state IN ('saving','queued','processing')").get().n;
    const reviews = db.prepare("SELECT count(*) AS n FROM review_items WHERE state IN ('grading','hinting')").get().n;
    if (imports || reviews) throw new Error('仍有处理中的导入或批阅，请完成后再切换版本');
    const rows = Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table).all()]));
    const backupDir = resolve('data/backups'); await mkdir(backupDir, {recursive: true});
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, 'before-architecture-' + stamp + '.sqlite');
    await backup(db, backupPath);
    const check = new DatabaseSync(backupPath, {readOnly: true});
    assert.equal(check.prepare('SELECT count(*) AS n FROM questions').get().n, rows.questions.length); check.close();
    await mkdir(reportDir, {recursive: true});
    await writeFile(reportPath, JSON.stringify({createdAt: new Date().toISOString(), backupPath, rows, images: await imageDigests()}, null, 2), 'utf8');
    console.log(JSON.stringify({backupPath, counts: Object.fromEntries(tables.map(t => [t, rows[t].length]))}));
  } else {
    const baseline = JSON.parse(await readFile(reportPath, 'utf8'));
    for (const table of tables) {
      const now = db.prepare('SELECT * FROM ' + table).all();
      assert.equal(now.length, baseline.rows[table].length, table + ' row count changed');
      const byId = new Map(now.map(row => [row.id || row.itemId, row]));
      for (const old of baseline.rows[table]) {
        const current = byId.get(old.id || old.itemId); assert.ok(current, table + ' row missing');
        for (const [key, value] of Object.entries(old)) assert.deepEqual(current[key], value, table + '.' + key + ' changed');
      }
    }
    assert.deepEqual(await imageDigests(), baseline.images, 'Original or sample images changed');
    console.log('PASS：旧数据库各表记录及原字段完全保留；原图、作答图片和试卷样本内容一致。');
    console.log('快照：' + baseline.backupPath);
  }
} finally {
  if (reservation) { if (reservation.isTransaction) reservation.exec('ROLLBACK'); reservation.close(); }
  db.close();
}
