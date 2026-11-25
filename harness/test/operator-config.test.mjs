import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOperatorConfig, ConfigError } from '../operator/config.mjs';

const defaultFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'operator', 'operator.config.json');
const base = () => JSON.parse(readFileSync(defaultFile, 'utf8'));

function write(obj) {
  const file = join(mkdtempSync(join(tmpdir(), 'opcfg-')), 'c.json');
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}

test('기본 파일을 읽는다', () => {
  const c = loadOperatorConfig(defaultFile);
  assert.deepEqual(c.allowedModels, ['claude', 'gemini', 'muse']);
  assert.equal(c.workerRetries, 2);
  assert.equal(c.rejectLimit, 5); // 결정 8-44: 스스로 고치는 재작업은 5번까지
  assert.equal(c.noReportRetries, 2); // 소유자 결정 2-4·8-4: 결과 없음은 2회 다시 시킨다
  assert.equal(c.sessionRestarts, 1);
  assert.equal(c.ci.mergeQueue, 'local');
});

test('파일이 없으면 ConfigError', () => {
  assert.throws(() => loadOperatorConfig(join(tmpdir(), 'nope-opcfg.json')), ConfigError);
});

test('fallback이 허용 목록에 없으면 ConfigError', () => {
  const c = base();
  c.fallback.muse = 'codex';
  assert.throws(() => loadOperatorConfig(write(c)), (e) => e instanceof ConfigError && e.message.includes('허용 목록'));
});

test('허용된 모델에 runners 항목이 없으면 ConfigError', () => {
  const c = base();
  delete c.runners.claude;
  assert.throws(() => loadOperatorConfig(write(c)), ConfigError);
});

test('workerRetries가 정수가 아니면 ConfigError', () => {
  const c = base();
  c.workerRetries = 1.5;
  assert.throws(() => loadOperatorConfig(write(c)), ConfigError);
});

test('JSON이 깨지면 ConfigError', () => {
  assert.throws(() => loadOperatorConfig(write('{ broken')), ConfigError);
});

const rejects = (mutate) => {
  const c = base();
  const out = mutate(c);
  assert.throws(() => loadOperatorConfig(write(out === undefined ? c : out)), ConfigError);
};

test('필수 키가 빠지면 ConfigError', () => {
  for (const k of ['allowedModels', 'runners', 'fallback', 'workerRetries', 'rejectLimit', 'noReportRetries', 'sessionRestarts', 'ci', 'jev']) {
    rejects((c) => { delete c[k]; });
  }
  for (const k of ['mergeQueue', 'cacheKey', 'excludeTests']) {
    rejects((c) => { delete c.ci[k]; });
  }
});

test('알 수 없는 키는 ConfigError', () => {
  rejects((c) => { c.workerRetry = 3; });
  rejects((c) => { c.ci.extra = 1; });
});

test('최상위가 객체가 아니면 ConfigError', () => {
  rejects(() => 'null');
  rejects(() => '[]');
});

test('allowedModels가 문자열 배열이 아니면 ConfigError', () => {
  rejects((c) => { c.allowedModels = 'claude'; });
  rejects((c) => { c.allowedModels = [1]; });
});

test('fallback이 null이면 ConfigError', () => {
  rejects((c) => { c.fallback = null; });
});

test('runners 형식이 틀리면 ConfigError', () => {
  rejects((c) => { c.runners = null; });
  rejects((c) => { c.runners.claude = { command: 'claude' }; });
});

test('음수 정수는 ConfigError', () => {
  rejects((c) => { c.workerRetries = -1; });
  rejects((c) => { c.rejectLimit = -5; });
  rejects((c) => { c.noReportRetries = 1.5; });
  rejects((c) => { c.sessionRestarts = -1; });
});

test('ci.mergeQueue가 잘못되면 ConfigError', () => {
  rejects((c) => { c.ci.mergeQueue = 'remote'; });
});

test('ci.cacheKey, ci.excludeTests가 문자열 배열이 아니면 ConfigError', () => {
  rejects((c) => { c.ci.cacheKey = 'a'; });
  rejects((c) => { c.ci.excludeTests = [1]; });
});

test('runners의 선택 키(cli, via, modelId, temporary)를 검사한다', () => {
  const c = loadOperatorConfig(defaultFile);
  // 이슈 #26(소유자 결정): 세 모델 모두 Pi로 띄운다. 임시 표시(F5·F6)는 없앴다.
  assert.deepEqual(['claude', 'gemini', 'muse'].map((m) => [c.runners[m].cli, c.runners[m].via, c.runners[m].temporary ?? null]), [['pi', 'pi', null], ['pi', 'pi', null], ['pi', 'pi', null]]);
  assert.deepEqual(['claude', 'gemini', 'muse'].map((m) => c.runners[m].modelId), ['anthropic/claude-sonnet-5-5', 'google/gemini-4-hydrogen:medium', 'meta/muse-spark-1.3-contributor']);
  assert.deepEqual(c.runners.gemini.secretEnv, ['GEMINI_API_KEY']);
  // 소유자 결정 8-16: claude는 난이도별로 haiku(쉬움)·sonnet(어려움). 난이도를 모르면 기본 modelId(sonnet).
  assert.deepEqual(c.runners.claude.tiers, { 쉬움: 'anthropic/claude-haiku-5-5', 어려움: 'anthropic/claude-sonnet-5-5' });
  assert.deepEqual(Object.keys(c.jev.routing.difficulty), ['쉬움', '어려움']);
  rejects((x) => { x.runners.claude.tiers = { 보통: 'a' }; });
  rejects((x) => { x.runners.claude.tiers = {}; });
  rejects((x) => { x.runners.claude.modelId = 'not-in-command'; });
  rejects((x) => { delete x.jev.routing.difficulty; });
  rejects((x) => { x.runners.gemini.secretEnv = ['gemini_key']; });
  rejects((x) => { x.runners.gemini.secretEnv = 'GEMINI_API_KEY'; });
  rejects((x) => { x.runners.muse.cli = 'codex'; });
  rejects((x) => { x.runners.muse.via = 'direct2'; });
  rejects((x) => { x.runners.muse.modelId = ''; });
  rejects((x) => { x.runners.muse.extra = 1; });
});

test('실행 폴더의 operator.local.json은 runners.<모델>.publicOnly만 덮어쓴다(소유자 결정 8-6, ADR 0007)', async () => {
  const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const { fileURLToPath: f2p } = await import('node:url');
  const real = f2p(new URL('../operator/operator.config.json', import.meta.url));
  const run = mkdtempSync(`${td()}/local-cfg-`).replace(/\\/g, '/');
  assert.equal(loadOperatorConfig(real, { run }).runners.muse.publicOnly, true, '로컬 설정이 없으면 공개 기본값');
  wf(`${run}/operator.local.json`, JSON.stringify({ runners: { muse: { publicOnly: false } } }));
  assert.equal(loadOperatorConfig(real, { run }).runners.muse.publicOnly, false);
  assert.equal(loadOperatorConfig(real).runners.muse.publicOnly, true, '실행 폴더를 주지 않으면 로컬 설정을 보지 않는다');
  for (const bad of [{ runners: { muse: { command: ['x'] } } }, { runners: { ghost: { publicOnly: false } } }, { rejectLimit: 9 }, { runners: { muse: { publicOnly: 'no' } } }, []]) {
    wf(`${run}/operator.local.json`, JSON.stringify(bad));
    assert.throws(() => loadOperatorConfig(real, { run }), ConfigError, JSON.stringify(bad));
  }
  wf(`${run}/operator.local.json`, '{ broken');
  assert.throws(() => loadOperatorConfig(real, { run }), ConfigError);
});

// 이슈 #44: Jev 설정
test('#44: jev 블록 — 기본값은 고정 버전 ID와 0.7/0.3, 라우팅 설명은 워커 모델·유형마다 있다', () => {
  const c = loadOperatorConfig(defaultFile);
  assert.equal(c.jev.model, 'jev-1.14.0');
  assert.equal(c.jev.yes, 0.7);
  assert.equal(c.jev.no, 0.3);
  assert.deepEqual(Object.keys(c.jev.routing.workerModels), c.allowedModels);
  assert.deepEqual(Object.keys(c.jev.routing.types), ['작업', '조사']);
  assert.ok(!c.allowedModels.includes('jev'), 'Jev는 워커가 아니다');
});

test('#44: jev 블록 오류는 ConfigError', () => {
  rejects((c) => { c.jev.endpoint = 'http://api.typesafe.ai/v1/systemone'; });
  rejects((c) => { c.jev.model = ''; });
  rejects((c) => { c.jev.timeoutMs = 0; });
  rejects((c) => { c.jev.yes = 0.3; c.jev.no = 0.7; });
  rejects((c) => { c.jev.yes = 1; });
  rejects((c) => { c.jev.extra = 1; });
  rejects((c) => { c.jev.routing.workerModels = {}; });
  rejects((c) => { c.jev.routing.workerModels.codex = 'x'; });
  rejects((c) => { c.jev.routing.types.작업 = ' '; });
  rejects((c) => { delete c.jev.routing.types; });
});

test('#44: 라우팅 설명이 없는 허용 모델은 라우팅 보기에서 빠질 뿐 설정 오류가 아니다', () => {
  const c = base();
  delete c.jev.routing.workerModels.muse;
  assert.deepEqual(Object.keys(loadOperatorConfig(write(c)).jev.routing.workerModels), ['claude', 'gemini']);
});
