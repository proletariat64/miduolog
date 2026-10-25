import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PaperImports, imageType} from './paper-import.mjs';
import {ReviewService} from './review-service.mjs';
import {IntakeService} from './intake-service.mjs';
import {createIntakeHandler} from './intake-http.mjs';

const appDir = dirname(fileURLToPath(import.meta.url));
function json(res, status, data) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) throw new Error('图片过大，请使用15MB以下的图片');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function uploadedBytes(input) {
  if (typeof input.base64 !== 'string') throw new Error('缺少图片文件');
  return Buffer.from(input.base64, 'base64');
}

/** Production and HTTP tests use the same routing and domain modules. */
export async function createNotebook({db, client, dataDir, shutdownTimeoutMs = 3000}) {
  db.exec('PRAGMA journal_mode=WAL');
  const imports = await PaperImports.open({db, client, dataDir});
  const intake = await IntakeService.open({db, client, dataDir});
  const intakeHandle = createIntakeHandler(intake);
  const review = new ReviewService({db, client, dataDir, imageType, catalog: intake});
  let closing = false, closePromise;
  const requests = new Set();
  async function handle(req, res) {
    try {
      if (closing) { json(res, 503, {error: '本机服务正在关闭，请稍后重试'}); return; }
      const port = server.address()?.port;
      const origin = 'http://127.0.0.1:' + port;
      if (req.headers.host !== '127.0.0.1:' + port) {
        json(res, 403, {error: '仅允许本机地址访问'}); return;
      }
      const url = new URL(req.url, origin), path = url.pathname;
      if (req.method !== 'GET' && ((req.headers.origin && req.headers.origin !== origin) || req.headers['x-mido-client'] !== 'desktop')) {
        json(res, 403, {error: '请求来源不匹配'}); return;
      }
      if (path.startsWith('/api/review/')) { await review.handle(req, res, path, {body, json}); return; }
      if (await intakeHandle(req, res, url)) return;
      if (req.method === 'GET' && path === '/api/status') {
        const account = await client.request('account/read', {refreshToken: false});
        json(res, 200, {loggedIn: !!account.account, authType: account.account?.type || null, busy: imports.busy}); return;
      }
      if (req.method === 'GET' && path === '/api/questions') {
        json(res, 200, imports.questions(url.searchParams.get('importId') || undefined)); return;
      }
      if (req.method === 'GET' && path === '/api/imports') { json(res, 200, imports.list()); return; }
      if (req.method === 'POST' && path === '/api/import/check') {
        const input = await body(req);
        json(res, 200, imports.inspect(uploadedBytes(input))); return;
      }
      if (req.method === 'POST' && path === '/api/import') {
        const input = await body(req);
        const result = await imports.submit({bytes: uploadedBytes(input), name: input.name});
        json(res, result.state === 'completed' ? 200 : 202, result); return;
      }
      const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
      if (req.method === 'GET' && jobMatch) {
        const status = imports.get(jobMatch[1]);
        json(res, status ? 200 : 404, status || {error: '找不到本次导入任务'}); return;
      }
      const qMatch = path.match(/^\/api\/questions\/([a-f0-9-]+)$/);
      if (req.method === 'PATCH' && qMatch) {
        const previous = db.prepare('SELECT * FROM questions WHERE id=?').get(qMatch[1]);
        if (!previous) { json(res, 404, {error: '题目不存在'}); return; }
        const input = await body(req), content = JSON.parse(previous.content);
        for (const key of ['question', 'studentAnswer', 'subject', 'knowledgePoint', 'observedError', 'possibleCause']) {
          if (typeof input[key] === 'string') content[key] = input[key].slice(0, 30000);
        }
        if (['pending', 'confirmed', 'disputed'].includes(input.causeStatus)) content.causeStatus = input.causeStatus;
        const state = input.state === 'library' ? 'library' : previous.state;
        if (!content.question.trim()) { json(res, 400, {error: '题目不能为空'}); return; }
        db.prepare('UPDATE questions SET state=?,content=? WHERE id=?').run(state, JSON.stringify(content), previous.id);
        intake.syncLegacyQuestion(previous.id);
        json(res, 200, {ok: true}); return;
      }
      const imageMatch = path.match(/^\/images\/([a-f0-9-]+)$/);
      if (req.method === 'GET' && imageMatch) {
        const original = await imports.original(imageMatch[1]);
        if (!original) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, {'Content-Type': original.contentType, 'X-Content-Type-Options': 'nosniff'});
        res.end(original.bytes); return;
      }
      const assets = {'/': 'index.html', '/index.html': 'index.html', '/client.js': 'client.js', '/review-client.js': 'review-client.js', '/styles.css': 'styles.css'};
      if (req.method === 'GET' && assets[path]) {
        const file = assets[path], bytes = await readFile(resolve(appDir, file));
        const contentType = {'.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'}[file.slice(file.lastIndexOf('.'))] || 'text/html; charset=utf-8';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        });
        res.end(bytes); return;
      }
      json(res, 404, {error: '不存在的地址'});
    } catch (error) {
      if (res.headersSent) res.destroy();
      else json(res, 500, {error: error.message});
    }
  }
  const server = http.createServer((req, res) => {
    const work = handle(req, res);
    requests.add(work);
    work.then(() => requests.delete(work), () => requests.delete(work));
  });
  return {
    server, imports, review, intake,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const drained = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
        const importsDone = imports.close();
        const intakeDone = intake.close();
        client.close();
        const timer = setTimeout(() => server.closeAllConnections(), shutdownTimeoutMs);
        try { await drained; } finally { clearTimeout(timer); }
        // Closed sockets can still have file writes in flight; finish handlers
        // before the caller closes their shared SQLite connection.
        await Promise.allSettled([...requests]);
        await Promise.all([importsDone, intakeDone, review.idle()]);
      })();
      return closePromise;
    },
  };
}
