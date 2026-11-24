// 이슈 #44: Jev 호출 모듈. 실제 API는 부르지 않는다(가짜 fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askJev, askJevWithRetry, RETRIES, findJevKey, readNoul, JevError, KEY_NAME } from '../operator/jev.mjs';

const JEV = { endpoint: 'https://api.example.test/v1/systemone', model: 'jev-1.14.0', timeoutMs: 2000, yes: 0.7, no: 0.3 };
const Q = { met: { type: 'noul', instructions: 'Is it met?' }, kind: { type: 'choice', instructions: 'Which?', criteria: { a_thing: 'A', b_thing: 'B' } } };
const OK = { model: 'jev-1.14.0', answers: { met: { type: 'noul', noul: 0.9 }, kind: { type: 'choice', choice: 'b_thing', confidence: 0.6, probabilities: { a_thing: 0.2, b_thing: 0.8 } } }, usage: { input_tokens: 10, output_tokens: 2 } };
const respond = (status, body) => async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('#44: 요청은 POST, Bearer 키, { model, state, questions }이고 응답을 그대로 돌려준다', async () => {
  let seen;
  const res = await askJev({ jev: JEV, key: 'k-123', state: { a: 1 }, questions: Q, fetchImpl: async (url, init) => { seen = { url, init }; return respond(200, OK)(); } });
  assert.equal(seen.url, JEV.endpoint);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, 'Bearer k-123');
  assert.deepEqual(JSON.parse(seen.init.body), { model: 'jev-1.14.0', state: { a: 1 }, questions: Q });
  assert.equal(res.answers.met.noul, 0.9);
  assert.equal(res.answers.kind.choice, 'b_thing');
});

test('#44: 실패는 답이 아니라 JevError다(키 없음, 429, 500, JSON 아님, 답 빠짐, 확률 범위 밖, 보기에 없는 choice, 네트워크)', async () => {
  const cases = [
    { key: '', fetchImpl: respond(200, OK) },
    { fetchImpl: respond(429, { detail: 'slow down' }), re: /429/ },
    { fetchImpl: respond(500, 'boom'), re: /500/ },
    { fetchImpl: respond(200, 'not json') },
    { fetchImpl: respond(200, { ...OK, answers: { met: OK.answers.met } }) },
    { fetchImpl: respond(200, { ...OK, answers: { ...OK.answers, met: { type: 'noul', noul: 1.5 } } }) },
    { fetchImpl: respond(200, { ...OK, answers: { ...OK.answers, kind: { ...OK.answers.kind, choice: 'c_thing' } } }) },
    { fetchImpl: respond(200, { answers: OK.answers }) },
    { fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, re: /ECONNREFUSED/ },
  ];
  for (const c of cases) {
    await assert.rejects(askJev({ jev: JEV, key: c.key ?? 'k', state: 's', questions: Q, fetchImpl: c.fetchImpl }), (e) => e instanceof JevError && (!c.re || c.re.test(e.message)));
  }
});

test('#44: 시간 제한을 넘기면 JevError(시간 초과)', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(askJev({ jev: { ...JEV, timeoutMs: 50 }, key: 'k', state: 's', questions: Q, fetchImpl: hang }), /시간 초과/);
});

test('#44: 오류 메시지에 키가 나오지 않는다', async () => {
  await assert.rejects(askJev({ jev: JEV, key: 'secret-key-value', state: 's', questions: Q, fetchImpl: respond(401, { detail: 'bad key' }) }), (e) => !e.message.includes('secret-key-value'));
});

test('#44: 키는 환경 변수, 실행 폴더 .env, 하네스 저장소 .env 순서로 찾고 출처에 값을 넣지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'jevkey-')).replace(/\\/g, '/');
  const run = `${root}/run`;
  const harnessDir = `${root}/repo/harness`;
  mkdirSync(run, { recursive: true });
  mkdirSync(harnessDir, { recursive: true });
  assert.equal(findJevKey({ env: {}, run, harnessDir }), null);
  writeFileSync(`${root}/repo/.env`, `OTHER=1\n${KEY_NAME}="from-repo"\n`);
  assert.deepEqual(findJevKey({ env: {}, run, harnessDir }), { key: 'from-repo', source: `${root}/repo/.env` });
  writeFileSync(`${run}/.env`, `${KEY_NAME}=from-run\r\n`);
  assert.equal(findJevKey({ env: {}, run, harnessDir }).key, 'from-run');
  const e = findJevKey({ env: { [KEY_NAME]: ' from-env ' }, run, harnessDir });
  assert.deepEqual(e, { key: 'from-env', source: `환경 변수 ${KEY_NAME}` });
  writeFileSync(`${run}/.env`, `${KEY_NAME}=\n`);
  assert.equal(findJevKey({ env: {}, run, harnessDir }).key, 'from-repo', '빈 값은 없는 것으로 본다');
});

test('#44: Noul은 0.7 이상 예, 0.3 이하 아니오, 사이는 애매', () => {
  const t = { yes: 0.7, no: 0.3 };
  assert.deepEqual([0.95, 0.7, 0.69, 0.5, 0.31, 0.3, 0.02].map((p) => readNoul(p, t)), ['예', '예', '애매', '애매', '애매', '아니오', '아니오']);
});

// 이슈 #25: 일시적 실패는 2회까지 다시 부른다.
const seq = (...steps) => { let i = 0; const calls = []; return { calls, fetchImpl: async (url, init) => { const s = steps[Math.min(i++, steps.length - 1)]; calls.push(i); if (s instanceof Error) throw s; return s(); } }; };
const withHeaders = (status, body, headers = {}) => async () => ({ status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) });

test('#25: 429·503·네트워크 오류는 다시 부르고, retry-after가 있으면 그 시간을 기다린다', async () => {
  assert.equal(RETRIES, 2);
  const waits = [];
  const f = seq(withHeaders(429, { detail: 'slow' }, { 'retry-after': '2' }), new Error('ECONNRESET'), respond(200, OK));
  const res = await askJevWithRetry({ jev: JEV, key: 'k', state: 's', questions: Q, fetchImpl: f.fetchImpl }, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(res.answers.met.noul, 0.9);
  assert.equal(res.attempts, 3);
  assert.deepEqual(waits, [2000, 3000]);
});

test('#25: 3번 모두 일시적 실패면 시도 횟수를 붙여 던지고, 401·422·응답 모양 오류는 다시 부르지 않는다', async () => {
  const f = seq(respond(503, 'down'));
  await assert.rejects(askJevWithRetry({ jev: JEV, key: 'k', state: 's', questions: Q, fetchImpl: f.fetchImpl }, { sleep: async () => {} }), /503.*\(3번 시도\)/);
  assert.equal(f.calls.length, 3);
  for (const step of [respond(401, { detail: 'bad key' }), respond(422, { detail: [] }), respond(200, 'not json')]) {
    const g = seq(step);
    await assert.rejects(askJevWithRetry({ jev: JEV, key: 'k', state: 's', questions: Q, fetchImpl: g.fetchImpl }, { sleep: async () => {} }), JevError);
    assert.equal(g.calls.length, 1);
  }
});
