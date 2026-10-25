import {randomUUID} from 'node:crypto';
import {writeFile, rename, rm} from 'node:fs/promises';

// Publish complete bytes in one rename; a failed write never truncates an original.
export async function writeImage(path, bytes, files = {writeFile, rename, rm}) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await files.writeFile(temporary, bytes, {flag: 'wx'});
    await files.rename(temporary, path);
  } finally {
    await files.rm(temporary, {force: true});
  }
}
