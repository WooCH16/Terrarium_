// 이슈 #28: 기계가 읽는 한국어 문자열은 operator/protocol.mjs에만 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from '../operator/protocol.mjs';
import { publicOkOf, difficultyOf } from '../operator/runners.mjs';

const dirs = ['../operator/', '../'].map((d) => fileURLToPath(new URL(d, import.meta.url)));
// 주석을 뺀 코드에서 찾는다(주석의 설명 글은 괜찮다).
const code = (text) => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');

const TOKENS = [P.REPORT_HEAD, P.VERDICT_HEAD, P.CHECK_HEAD, `${P.ALLOWED_COMMIT}:`, `${P.REVIEWER_MODEL}:`, P.ACTUAL_WORKER_MODEL, ...P.REPORT_SECTIONS.filter((s) => s !== '근거 위치'), P.RESULT_FIELDS[2]];
const LABEL_LITERALS = [...P.STATES, P.CANCEL_LABEL].map((s) => `'${s}'`);
// 라벨 글자 대신 run-worker의 결과 JSON status('완료'·'막힘')는 다른 약속이라 라벨 검사에서 뺀다.
const LABEL_EXEMPT = new Set(['run-worker.mjs', 'protocol.mjs']);

test('#28: 프로토콜 표지는 protocol.mjs 밖의 코드에 글자로 나오지 않는다', () => {
  const found = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.mjs') && n !== 'protocol.mjs')) {
      const text = code(readFileSync(`${dir}/${name}`, 'utf8'));
      for (const t of TOKENS) if (text.includes(t)) found.push(`${name}: ${t}`);
      if (!LABEL_EXEMPT.has(name)) for (const t of LABEL_LITERALS) if (text.includes(t)) found.push(`${name}: ${t}`);
    }
  }
  assert.deepEqual(found, []);
});

test('#28: 줄 읽기는 예전과 같다(공개 가능, 난이도, 허용된 커밋)', () => {
  assert.equal(publicOkOf('- 공개 가능: 예'), true);
  assert.equal(publicOkOf('공개 가능: `예`'), true);
  assert.equal(publicOkOf('- 공개 가능: 아니오'), false);
  assert.equal(publicOkOf('- 공개 가능: 예\n- 공개 가능: 예'), false);
  assert.equal(difficultyOf('- 난이도: 쉬움 (Jev 라우팅, 쉬움 0.99)'), '쉬움');
  assert.equal(difficultyOf('난이도:\t어려움'), '어려움');
  assert.equal(difficultyOf('- 난이도: 보통'), null);
  assert.equal(P.ALLOWED_COMMIT_LINE.exec(`허용된 커밋: ${'a'.repeat(40)}`)[1], 'a'.repeat(40));
  assert.equal(P.ALLOWED_COMMIT_LINE.test('허용된 커밋: abc'), false);
  assert.equal(P.LABEL.막힘, '막힘');
  assert.ok(Object.isFrozen(P.LABEL));
});
