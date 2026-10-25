import sharp from 'sharp';

function clean(value) {
  if (typeof value !== 'string') return '';
  // Keep boundaries between Latin words and separate numbers; line wrapping
  // elsewhere is layout. NFC avoids changing mathematical superscript values.
  return value.normalize('NFC').replace(/(?<=[A-Za-z0-9])\s+(?=[A-Za-z0-9])/gu, '\u001f')
    .replace(/\s+/gu, '').split('\u001f').join(' ');
}
function evidence(value) {
  if (value == null) return '';
  return typeof value === 'string' ? clean(value) : JSON.stringify(value);
}
function questionText(content) {
  if (typeof content?.question !== 'string') return '';
  const withoutNumber = content.question.normalize('NFC').trim()
    .replace(/^第\s*[0-9一二三四五六七八九十百\s]+题\s*[：:、.]?/u, '')
    .replace(/^(?:[（(]\s*\d+\s*[）)]|\d+\s*[、．]|\d+\.(?!\d))\s*[：:]?/u, '');
  return clean(withoutNumber);
}
function pairs(text) {
  const characters = Array.from(text);
  return new Set(characters.slice(1).map((character, index) => characters[index] + character));
}
function textSimilarity(left, right) {
  if (left === right) return 1;
  const a = pairs(left), b = pairs(right);
  let common = 0;
  for (const pair of a) if (b.has(pair)) common++;
  return a.size + b.size ? 2 * common / (a.size + b.size) : 0;
}

// Protect common mathematical changes before approximate text matching. This is
// deliberately conservative; arbitrary semantic equivalence is not inferred.
function meaningTokens(text) {
  return JSON.stringify([
    text.match(/[-−+]?\d+(?:\.\d+)?|[零〇一二三四五六七八九十百千万亿两]+/gu) || [],
    text.match(/(?:平方|立方)?(?:千米|厘米|毫米|分米|米|公顷|亩|千克|毫克|克|吨|小时|分钟|分|秒|毫升|升|元|角|%|％|cm|mm|km|kg|ml|m|g|L)/gu) || [],
    text.match(/表面积|周长|面积|体积|长度|宽度|高度|速度|路程|时间|总价|单价|数量|平均数|中位数|众数|最大|最小|至少|至多|不超过|超过|小于|大于|等于|不少于|不大于|不小于|不能|不是|不正确|正确|错误|长方形|正方形|三角形|圆柱|圆锥|圆形|平行|垂直/gu) || [],
    text.match(/<=|>=|≠|≤|≥|<|>|=|\+|-|−|×|÷/gu) || [],
  ]);
}

// Candidate suggestions only: no user data or original answers are changed.
export function questionCandidates(content, records = []) {
  const question = questionText(content);
  if (!question || !Array.isArray(records)) return [];
  return records.flatMap(record => {
    const other = record?.content, candidate = questionText(other);
    if (!candidate || clean(content.subject) !== clean(other?.subject) || evidence(content.sharedMaterial) !== evidence(other?.sharedMaterial) || evidence(content.options) !== evidence(other?.options)) return [];
    if (meaningTokens(question) !== meaningTokens(candidate)) return [];
    const score = textSimilarity(question, candidate);
    if (score < 0.88) return [];
    const uncertainDiagram = content.diagramDescription || other.diagramDescription || /如图|下图|图中|图形/u.test(question + candidate);
    return [{id: record.id, score, kind: question === candidate && !uncertainDiagram ? 'exact' : 'similar'}];
  }).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))).slice(0, 20);
}
// Local pixels only. At most 40M input pixels and 15MiB compressed bytes.
export async function describeImage(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 15 * 1024 * 1024) return null;
  try {
    const image = sharp(Buffer.from(bytes), {limitInputPixels: 40_000_000, failOn: 'warning'});
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format)) return null;
    const rotated = [5, 6, 7, 8].includes(metadata.orientation);
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    const pixels = await image.rotate().flatten({background: '#ffffff'}).greyscale()
      .resize(17, 16, {fit: 'fill'}).raw().toBuffer();
    let hash = 0n;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      hash = (hash << 1n) | BigInt(pixels[y * 17 + x] > pixels[y * 17 + x + 1] + 2 ? 1 : 0);
    }
    return {width, height, dhash: hash.toString(16).padStart(64, '0')};
  } catch { return null; }
}

function validPhoto(description) {
  return description && Number.isFinite(description.width) && description.width > 0 &&
    Number.isFinite(description.height) && description.height > 0 && typeof description.dhash === 'string' && /^[0-9a-f]{64}$/u.test(description.dhash) && !/^(?:0{64}|f{64})$/u.test(description.dhash);
}

// 256-bit dHash distance <=20, aspect ratio within 3%. Always a warning, never equality.
export function photoCandidates(description, records = []) {
  if (!validPhoto(description) || !Array.isArray(records)) return [];
  return records.filter(validPhoto).flatMap(record => {
    const aspectDifference = Math.abs((description.width / description.height) / (record.width / record.height) - 1);
    if (aspectDifference > 0.03) return [];
    let different = BigInt('0x' + description.dhash) ^ BigInt('0x' + record.dhash), distance = 0;
    while (different) { different &= different - 1n; distance++; }
    return distance <= 20 ? [{id: record.id, score: 1 - distance / 256, kind: 'similar'}] : [];
  }).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))).slice(0, 20);
}
