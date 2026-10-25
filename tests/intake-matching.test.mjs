import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {describeImage, photoCandidates, questionCandidates} from '../app/intake-matching.mjs';

test('question candidates find same problem with layout and question-number differences', () => {
  const original = {subject: '数学', question: '第 1 题：一根绳子长 12 米，用去 3 米，还剩多少米？'};
  const records = [{id: 'same', content: {...original, question: '8、一根绳子长12米，\n用去3米，还剩多少米？'}}];
  assert.deepEqual(questionCandidates(original, records), [{id: 'same', score: 1, kind: 'exact'}]);
});

test('shared reading material and diagram evidence are part of the problem identity', () => {
  const question = {subject: '语文', question: '根据文章内容，概括作者的心情。', sharedMaterial: '雨停了，孩子终于找到了回家的路。'};
  assert.deepEqual(questionCandidates(question, [{id: 'other-passage', content: {...question, sharedMaterial: '告别故乡后，孩子望着远处的山。'}}]), []);
  const geometry = {subject: '数学', question: '如图，求阴影部分的面积。', diagramDescription: '正方形内有三角形阴影'};
  const matches = questionCandidates(geometry, [{id: 'drawing', content: geometry}]);
  assert.equal(matches[0]?.kind, 'similar', 'a text description does not establish identical diagram pixels');
});

async function worksheet() {
  const width = 320, height = 440, pixels = Buffer.alloc(width * height * 3, 250);
  for (let y = 35; y < 400; y++) {
    for (let x = 25; x < 290; x++) {
      const row = Math.floor((y - 35) / 29);
      if ((y - 35) % 29 < 3 && x < 100 + (row * 43) % 185) {
        const offset = (y * width + x) * 3;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 30;
      }
    }
  }
  return sharp(pixels, {raw: {width, height, channels: 3}}).png().toBuffer();
}

test('local photo candidates recognize a resized JPEG and compressed WebP of a real PNG', async () => {
  const original = await worksheet();
  const description = await describeImage(original);
  assert.equal(description.width, 320);
  assert.equal(description.height, 440);
  const records = [{id: 'original', ...description}];
  for (const bytes of [await sharp(original).resize(160).jpeg({quality: 70}).toBuffer(), await sharp(original).resize(480).webp({quality: 65}).toBuffer()]) {
    const candidates = photoCandidates(await describeImage(bytes), records);
    assert.equal(candidates[0]?.id, 'original');
    assert.equal(candidates[0]?.kind, 'similar', 'perceptual matching must never report exact byte equality');
    assert.ok(candidates[0].score > 0.9);
  }
});

test('a likely single OCR character error gives a suggestion rather than exact equality', () => {
  const question = {subject: '数学', question: '一根绳子长12米，用去3米以后，剩下的绳子长度是多少米？'};
  const records = [{id: 'ocr', content: {...question, question: '一根绳予长12米，用去3米以后，剩下的绳子长度是多少米？'}}];
  assert.equal(questionCandidates(question, records)[0]?.kind, 'similar');
});

test('changed values, units, requested quantities, conditions and choices are different problems', () => {
  const original = {subject: '数学', question: '一根绳子长12米，用去3米以后，剩下的绳子长度是多少米？'};
  for (const question of [original.question.replace('12', '13'), original.question.replaceAll('米', '厘米'), original.question.replace('长度', '周长')]) {
    assert.deepEqual(questionCandidates(original, [{id: 'variant', content: {...original, question}}]), []);
  }
  const condition = {subject: '数学', question: '长方形的一条边为8米，另一条边为5米，求长方形的面积是多少？'};
  assert.deepEqual(questionCandidates(condition, [{id: 'condition', content: {...condition, question: condition.question.replaceAll('长方形', '正方形')}}]), []);
  const choice = {subject: '数学', question: '从下列选项中选择正确答案。A.9 B.10 C.11 D.12'};
  assert.deepEqual(questionCandidates(choice, [{id: 'choices', content: {...choice, question: choice.question.replace('A.9 B.10', 'A.10 B.9')}}]), []);
});

test('invalid or non-informative images and malformed candidate data are safely ignored', async () => {
  assert.equal(await describeImage(Buffer.from('not an image')), null);
  assert.equal(await describeImage('photo.png'), null);
  assert.equal(await describeImage(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), null);
  const blank = await describeImage(await sharp({create: {width: 100, height: 120, channels: 3, background: 'white'}}).png().toBuffer());
  assert.deepEqual(photoCandidates(blank, [{id: 'blank', ...blank}]), []);
  assert.deepEqual(photoCandidates(blank, null), []);
  assert.deepEqual(questionCandidates({}, null), []);
  assert.deepEqual(questionCandidates({question: '计算 1.5 × 2。'}, [{id: 'other', content: {question: '计算 5 × 2。'}}]), []);
});

test('structured shared materials, options and missing diagram evidence cannot establish exact duplicates', () => {
  const problem = {subject: '语文', question: '下面这段文字表达了什么情感？', sharedMaterial: {text: '作者期待久别重逢。'}};
  assert.deepEqual(questionCandidates(problem, [{id: 'different', content: {...problem, sharedMaterial: {text: '作者对远行感到忧伤。'}}}]), []);
  const selected = {subject: '语文', question: '下列词语中选择表示方向的一项。', options: ['北', '天气']};
  assert.deepEqual(questionCandidates(selected, [{id: 'option', content: {...selected, options: ['天气', '北']}}]), []);
  const drawing = {subject: '数学', question: '如图，求阴影面积。'};
  assert.equal(questionCandidates(drawing, [{id: 'unknown-diagram', content: drawing}])[0].kind, 'similar');
});

test('numbered calculation items retain their decimal values when stripping the item number', () => {
  const value = {subject: '数学', question: '1. 1.5 × 2 = ?'};
  assert.equal(questionCandidates(value, [{id: 'same', content: {...value, question: '（8）1.5 × 2 = ?'}}])[0]?.kind, 'exact');
  assert.deepEqual(questionCandidates({subject: '数学', question: '1.5 × 2 = ?'}, [{id: 'different', content: {subject: '数学', question: '5 × 2 = ?'}}]), []);
});

test('photo suggestions never claim exact equality, mutate input or exceed a bounded deterministic list', async () => {
  const image = await worksheet();
  const marked = await sharp(image).composite([{input: Buffer.from('<svg width="320" height="440"><path d="M240 200l15 20 35-40" stroke="red" fill="none" stroke-width="4"/></svg>')}]).png().toBuffer();
  const description = await describeImage(marked), reference = await describeImage(image);
  const records = Object.freeze(Array.from({length: 30}, (_, i) => Object.freeze({id: String(i).padStart(2, '0'), ...reference})));
  const before = JSON.stringify(records);
  const suggestions = photoCandidates(Object.freeze(description), records);
  assert.equal(suggestions.length, 20);
  assert.equal(suggestions.every(item => item.kind === 'similar'), true);
  assert.deepEqual(suggestions.map(item => item.id), Array.from({length: 20}, (_, i) => String(i).padStart(2, '0')));
  assert.equal(JSON.stringify(records), before);
  const negative = await describeImage(await sharp(image).negate().png().toBuffer());
  assert.deepEqual(photoCandidates(negative, [{id: 'different', ...reference}]), []);
});

test('spaces separating English words or numbers are not erased into another problem', () => {
  const spaced = {subject: '其他', question: 'Choose the correct phrase: a part.'};
  const joined = {subject: '其他', question: 'Choose the correct phrase: apart.'};
  assert.notEqual(questionCandidates(spaced, [{id: 'joined', content: joined}])[0]?.kind, 'exact');
  assert.deepEqual(questionCandidates({subject: '数学', question: '排列这些数：1 2 3'}, [{id: 'joined', content: {subject: '数学', question: '排列这些数：123'}}]), []);
});


test('printed pages with a common layout but different question or answer content do not block intake', async () => {
  const page = async rows => sharp(Buffer.from('<svg width="1400" height="1100"><rect width="100%" height="100%" fill="white"/>' + rows.map((text, i) => '<text x="60" y="' + (100 + i * 80) + '" font-family="Arial" font-size="32">' + text + '</text>').join('') + '</svg>')).png().toBuffer();
  const original = await page(['Math Practice B / MIDO-97531 / Questions', '1. Calculate: 9 + 4 = ( ).', '2. Calculate: 10 - 6 = ( ).', 'Questions only. Answers are on a separate sheet.']);
  const different = await page(['Math Practice C / MIDO-13579 / Answer Sheet', '1. Student answer: A', '2. Student answer: B', 'Answers only. No questions are shown.']);
  const description = await describeImage(original);
  assert.deepEqual(photoCandidates(await describeImage(different), [{id: 'different-content', ...description}]), []);
  for (const encoded of [await sharp(original).resize(700).jpeg({quality: 70}).toBuffer(), await sharp(original).resize(1800).webp({quality: 65}).toBuffer()]) assert.equal(photoCandidates(await describeImage(encoded), [{id: 'same', ...description}])[0]?.id, 'same');
});


test('photo candidate scans reject distant layouts before loading ink and reuse the input thumbnail', async () => {
  const description = await describeImage(await worksheet()); let inputReads = 0, unrelatedReads = 0;
  const input = {...description, get ink() { inputReads++; return description.ink; }};
  const distant = {...description, id: 'other-layout', dhash: (BigInt('0x' + description.dhash) ^ ((1n << 256n) - 1n)).toString(16).padStart(64, '0'), get ink() { unrelatedReads++; return description.ink; }};
  const records = [distant, ...Array.from({length: 100}, (_, i) => ({id: String(i), ...description}))];
  assert.equal(photoCandidates(input, records).length, 20);
  assert.equal(unrelatedReads, 0); assert.equal(inputReads, 1);
});
