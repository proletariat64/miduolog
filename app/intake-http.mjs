import http from 'node:http';
import {receiveIntakeUpload} from './intake-upload.mjs';
import {IntakeService} from './intake-service.mjs';

export function intakeJson(res, status, data) { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(data)); }
export async function intakeBody(req, maximum = 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req.iterator({destroyOnReturn: false})) { size += chunk.length; if (size > maximum) { req.resume(); throw Object.assign(new Error('上传批次过大'), {status: 413}); } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('请求不是有效 JSON'), {status: 400}); }
}
export function createIntakeHandler(intake) {
  let uploading = false; const waiting = [];
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/intake/')) return false;
    const path = url.pathname, json = data => { const missing = data === null || data === undefined; return intakeJson(res, missing ? 404 : 200, missing ? {error: '记录不存在'} : data); };
    try {
      const match = path.match(/^\/api\/intake\/(batches|photos|decisions|fragments|questions|attempts|materials)(?:\/([^/]+))?(?:\/(retry|image|link|split|merge|attempts))?$/);
      if (!match) { intakeJson(res, 404, {error: '接口不存在'}); return true; }
      const [, resource, id, action] = match, method = req.method;
      if (resource === 'batches') {
        if (method === 'POST' && !id) {
          if (uploading) {
            if (waiting.length >= 2) { req.resume(); intakeJson(res, 429, {error: '正在保存其他照片，请稍后重试本批'}); return true; }
            await new Promise(resolve => waiting.push(resolve));
          }
          uploading = true; let staged;
          try {
            if (req.aborted) throw new Error('上传已中断');
            const multipart = /^multipart\/form-data(?:;|$)/i.test(req.headers['content-type'] || '');
            if (multipart) staged = await receiveIntakeUpload(req, intake.dataDir);
            const input = staged ? staged.input : await intakeBody(req, 24 * 1024 * 1024);
            const batch = await intake.submit(input, {staged: !!staged});
            if (staged) { await staged.cleanup(); staged = null; }
            intakeJson(res, 202, batch);
          } finally { try { if (staged) await staged.cleanup(); } finally { const next = waiting.shift(); if (next) next(); else uploading = false; } }
          return true;
        }
        if (method === 'GET' && !action) { json(id ? intake.batch(id) : intake.batches()); return true; }
        if (method === 'POST' && action === 'retry') { json(await intake.retry(id)); return true; }
      }
      if (resource === 'photos' && method === 'GET' && (!action || action === 'image')) {
        if (action === 'image') {
          const preview = url.searchParams.get('preview') === '1';
          const original = await intake.original(id, {preview}); if (!original) { json(null); return true; }
          res.writeHead(200, {'Content-Type': original.contentType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': preview ? 'private, max-age=86400' : 'no-store'}); res.end(original.bytes);
        } else json(intake.photo(id)); return true;
      }
      if (resource === 'decisions' && id && !action && method === 'POST') { json(intake.resolveDecision(id, await intakeBody(req))); return true; }
      if (resource === 'fragments' && action === 'link' && method === 'POST') { json(intake.linkFragment(id, await intakeBody(req))); return true; }
      if (resource === 'questions') {
        if (method === 'GET' && !action) { json(id ? intake.store.question(id, true) : intake.store.listQuestions({status: url.searchParams.get('status'), tag: url.searchParams.get('tag'), batchId: url.searchParams.get('batchId'), includeRemoved: url.searchParams.get('includeRemoved') === '1'})); return true; }
        if (method === 'POST' && !id) { json(intake.createQuestion(await intakeBody(req))); return true; }
        if (method === 'POST' && action === 'split') { json(intake.split(id, await intakeBody(req, 24 * 1024 * 1024))); return true; }
        if (method === 'POST' && action === 'merge') { json(intake.merge(id, await intakeBody(req))); return true; }
        if (method === 'POST' && action === 'attempts') { json(intake.appendAttempt(id, await intakeBody(req))); return true; }
        if (method === 'PATCH' && id && !action) { json(intake.store.updateQuestion(id, await intakeBody(req))); return true; }
        if (method === 'DELETE' && id && !action) { json(intake.store.remove(id)); return true; }
      }
      if (resource === 'attempts' && method === 'PATCH' && id && !action) { json(intake.store.updateAttempt(id, await intakeBody(req))); return true; }
      if (resource === 'materials') {
        if (method === 'GET' && !action) { json(id ? intake.store.material(id) : intake.store.materials()); return true; }
        if (method === 'PATCH' && id && !action) { json(intake.store.updateMaterial(id, await intakeBody(req))); return true; }
      }
      intakeJson(res, 405, {error: '不支持的操作'});
    } catch (e) { intakeJson(res, e.status || (e.errcode ? 500 : 400), {error: e.message}); }
    return true;
  };
}
export async function createIntakeServer(options) {
  const intake = await IntakeService.open(options), handle = createIntakeHandler(intake), requests = new Set(); let closing = false;
  const server = http.createServer((req, res) => {
    const work = (async () => {
      const origin = 'http://127.0.0.1:' + server.address().port;
      if (closing) { intakeJson(res, 503, {error: '录入服务正在关闭'}); return; }
      if (req.headers.host !== new URL(origin).host || (req.method !== 'GET' && ((req.headers.origin && req.headers.origin !== origin) || req.headers['x-mido-client'] !== 'desktop'))) { intakeJson(res, 403, {error: '仅允许本机同源请求'}); return; }
      if (!await handle(req, res, new URL(req.url, origin))) intakeJson(res, 404, {error: '接口不存在'});
    })().catch(e => { if (!res.headersSent) intakeJson(res, 500, {error: e.message}); else res.destroy(); });
    requests.add(work); work.finally(() => requests.delete(work));
  });
  let closePromise;
  return {server, intake, close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => { const stopped = server.listening ? new Promise(r => server.close(r)) : Promise.resolve(); options.client.close?.(); const pending = intake.close(); const timer = setTimeout(() => server.closeAllConnections(), 3000); await stopped; clearTimeout(timer); await Promise.allSettled([...requests]); await pending; })();
    return closePromise;
  }};
}
