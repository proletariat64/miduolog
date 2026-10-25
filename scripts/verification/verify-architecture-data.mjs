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
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
const tableName = name => '"' + name.replaceAll('"', '""') + '"';
const rowsOf = (connection, table) => connection.prepare('SELECT * FROM ' + tableName(table)).all();
const activeCount = (table, states) => tables.includes(table) ? db.prepare('SELECT count(*) AS n FROM ' + tableName(table) + ' WHERE state IN (' + states.map(() => '?').join(',') + ')').get(...states).n : 0;
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
    const imports = activeCount('imports', ['saving', 'queued', 'processing']);
    const reviews = activeCount('review_items', ['grading', 'hinting']);
    const intake = activeCount('intake_photos', ['saving', 'queued', 'processing']) + activeCount('intake_batches', ['processing']);
    if (imports || reviews || intake) throw new Error('仍有处理中的导入、录入或批阅，请完成后再切换版本');
    const rows = Object.fromEntries(tables.map(table => [table, rowsOf(db, table)]));
    const columns = Object.fromEntries(tables.map(table => [table, db.prepare('PRAGMA table_info(' + tableName(table) + ')').all().map(column => column.name)]));
    const backupDir = resolve('data/backups'); await mkdir(backupDir, {recursive: true});
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, 'before-architecture-' + stamp + '.sqlite');
    await backup(db, backupPath);
    const check = new DatabaseSync(backupPath, {readOnly: true});
    for (const table of tables) assert.equal(rowsOf(check, table).length, rows[table].length, table + ' backup row count changed');
    check.close();
    await mkdir(reportDir, {recursive: true});
    await writeFile(reportPath, JSON.stringify({createdAt: new Date().toISOString(), backupPath, rows, columns, images: await imageDigests()}, null, 2), 'utf8');
    console.log(JSON.stringify({backupPath, counts: Object.fromEntries(tables.map(t => [t, rows[t].length]))}));
  } else {
    const baseline = JSON.parse(await readFile(reportPath, 'utf8'));
    for (const [table, previous] of Object.entries(baseline.rows)) {
      const current = rowsOf(db, table);
      assert.equal(current.length, previous.length, table + ' row count changed');
      // Compare a multiset of the original fields. This also covers compound
      // keys and permits a migration to add columns without losing old values.
      const columns = baseline.columns?.[table] || Object.keys(previous[0] || {});
      const currentColumns = new Set(db.prepare('PRAGMA table_info(' + tableName(table) + ')').all().map(column => column.name));
      for (const column of columns) assert.ok(currentColumns.has(column), table + ' original column missing: ' + column);
      const records = values => values.map(row => JSON.stringify(columns.map(key => row[key]))).sort();
      assert.deepEqual(records(current), records(previous), table + ' original records changed');
    }
    assert.deepEqual(await imageDigests(), baseline.images, 'Original or sample images changed');
    console.log('PASS：快照中的数据库各表记录及原字段完全保留；原图、作答图片和试卷样本内容一致。');
    console.log('快照：' + baseline.backupPath);
  }
} finally {
  if (reservation) { if (reservation.isTransaction) reservation.exec('ROLLBACK'); reservation.close(); }
  db.close();
}
