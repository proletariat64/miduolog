function unfinished(message) {
  const error = new Error(message);
  error.unfinished = true;
  return error;
}

export async function waitForImport(readStatus, {timeoutMs = 480000, pollMs = 2500,
  now = Date.now, onProgress = () => {}} = {}) {
  let deadline = now() + timeoutMs, processing = false, last = '';
  while (true) {
    let status;
    try { status = await readStatus(); }
    catch (error) {
      if (error.status === 404) throw error;
      if (now() > deadline) throw unfinished('暂时无法确认任务结果，任务仍保留；不重复上传');
      onProgress('进度暂不可读，后台可能仍在处理；不重复上传。');
      await new Promise(resolve => setTimeout(resolve, pollMs));
      continue;
    }
    if (status.message !== last) { onProgress(status.message); last = status.message; }
    if (status.state === 'completed') return status;
    if (status.state === 'failed') throw new Error(status.message || '识别失败');
    if (status.stage === 'processing' && !processing) { processing = true; deadline = now() + timeoutMs; }
    if (now() > deadline) throw unfinished(processing
      ? '本次识别等待超过8分钟，结果尚未确认；不重复上传'
      : '仍在排队，任务尚未完成；不重复上传');
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
