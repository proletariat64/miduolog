import busboy from 'busboy';
import {createWriteStream} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {Transform} from 'node:stream';
import {finished, pipeline} from 'node:stream/promises';
import {imageType} from './paper-import.mjs';

const maxFile = 15 * 1024 * 1024;
const invalid = message => Object.assign(new Error(message), {status: 413});
// Busboy applies backpressure while each part is published to private staging.
// No request-wide Buffer, base64 string or in-memory FormData is constructed.
export async function receiveIntakeUpload(req, dataDir) {
  const directory = await mkdtemp(join(dataDir, 'upload-')), writes = [], files = [];
  let parser, failure, requestId, total = 0;
  const cleanup = () => rm(directory, {recursive: true, force: true});
  const fail = message => { failure ||= invalid(message); };
  const aborted = () => parser?.destroy(new Error('上传已中断'));
  const count = chunk => { total += chunk.length; if (total > 30 * maxFile + 1024 * 1024) fail('上传批次过大'); };
  try {
    parser = busboy({headers: req.headers, defParamCharset: 'utf8', highWaterMark: 65536, fileHwm: 65536,
      limits: {files: 30, fileSize: maxFile + 1, fields: 1, fieldSize: 200, fieldNameSize: 100, parts: 32, headerPairs: 20}});
    parser.on('field', (name, value, info) => { if (name !== 'requestId' || info.valueTruncated || requestId !== undefined) fail('上传请求编号无效'); else requestId = value; });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit']) parser.on(event, () => fail('一次最多30张照片，每张不超过15MB'));
    parser.on('file', (field, source, info) => {
      const file = {name: info.filename, file: join(directory, randomUUID()), size: 0}, hash = createHash('sha256');
      let header = Buffer.alloc(0);
      files.push(file);
      if (field !== 'photos') fail('图片字段无效');
      source.on('limit', () => fail('每张照片不能超过15MB'));
      const inspect = new Transform({transform(chunk, encoding, done) {
        file.size += chunk.length; hash.update(chunk);
        if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
        done(null, chunk);
      }});
      writes.push(pipeline(source, inspect, createWriteStream(file.file, {flags: 'wx'})).then(() => {
        file.hash = hash.digest('hex'); file.type = imageType(header);
        if (file.size > maxFile) fail('每张照片不能超过15MB');
      }).catch(error => { failure ||= error; parser.destroy(error); }));
    });
    req.on('aborted', aborted); req.on('error', aborted); req.on('data', count);
    const completed = finished(parser); req.pipe(parser); await completed; await Promise.all(writes);
    if (failure) throw failure;
    return {input: {requestId, files}, cleanup};
  } catch (error) {
    req.unpipe(parser); req.resume(); await Promise.allSettled(writes); await cleanup(); throw error;
  } finally { req.off('aborted', aborted); req.off('error', aborted); req.off('data', count); }
}
