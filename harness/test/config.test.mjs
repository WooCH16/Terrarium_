import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCoordinatorConfig, CoordinatorConfigError, DEFAULT_COORDINATOR_CONFIG } from '../config.mjs';
import { ADVICE_LIMIT } from '../operator/run-reviewer.mjs';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(join(harnessDir, p), 'utf8'));
const base = () => readJson('coordinator.config.json');
function write(obj) {
  const file = join(mkdtempSync(join(tmpdir(), 'coordcfg-')), 'c.json');
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}
const rejects = (obj, re) => assert.throws(() => loadCoordinatorConfig(write(obj)), (e) => e instanceof CoordinatorConfigError && (!re || re.test(e.message)));

// docs/01-overview.md 8절의 시작값(측정하지 않은 값). 코디네이터가 쓰는 것만 이 파일에 있다.
test('8절 수치(코디네이터가 쓰는 값)가 설정 파일 한 곳에 있다', () => {
  const c = loadCoordinatorConfig(DEFAULT_COORDINATOR_CONFIG);
  assert.equal(c.reworkLimitPerIssue, 2);
  assert.equal(c.blockedIssuesReportThreshold, 3);
  assert.equal(c.cancelledIssuesCleanupThreshold, 8);
  assert.equal(c.preferenceProposalAtRepeat, 3);
  assert.equal(c.advisorRevisionAfterReject, 1); // 소유자 결정 8-2: 판정은 첫 제출 + 수정 1회
  assert.deepEqual(c.lightCheck, { maxFiles: 3, maxReads: 3 });
  assert.equal(c.researchRetry, 1);
  assert.deepEqual(c.researchResult, { maxLines: 50, maxTokens: 2000 });
  assert.deepEqual(c.bigToolOutput, { lines: 50, tokens: 2000 });
  assert.equal(c.recentContextPercent, 10);
  assert.equal(c.preserveListPercent, 5);
  assert.equal(c.noResponseMinutes, 30); // 소유자 결정 3-3(이슈 #2)
});

test('오퍼레이터 쪽 값(워커 재시도 2, 세션 재시작 1)과 재작업 한도가 어긋나지 않는다', () => {
  const op = readJson('operator/operator.config.json');
  assert.equal(op.workerRetries, 2);
  assert.equal(op.sessionRestarts, 1);
  assert.equal(op.rejectLimit, loadCoordinatorConfig().reworkLimitPerIssue);
});

test('워커 모델 허용 값은 claude, gemini, muse이고 codex가 없다', () => {
  const c = loadCoordinatorConfig();
  assert.deepEqual(c.workerModels, ['claude', 'gemini', 'muse']);
  assert.ok(!c.workerModels.includes('codex'));
});

test('오퍼레이터 설정과 코디네이터 규칙의 모델 목록이 허용 값 안에 있고 codex가 없다', () => {
  const allowed = loadCoordinatorConfig().workerModels;
  const op = readJson('operator/operator.config.json');
  const used = [...op.allowedModels, ...Object.keys(op.runners), ...Object.keys(op.fallback), ...Object.values(op.fallback)];
  for (const m of used) assert.ok(allowed.includes(m), `operator.config.json의 ${m}`);
  const line = readFileSync(join(harnessDir, 'coordinator', 'AGENT.md'), 'utf8').split(/\r?\n/).find((l) => l.startsWith('- 워커 모델:'));
  assert.ok(line, 'coordinator.md의 워커 모델 줄');
  assert.ok(!/codex/.test(line), line);
  for (const m of allowed) assert.ok(line.includes(`\`${m}\``), `${m}가 coordinator.md 워커 모델 줄에 있어야 한다`);
});

test('codex를 넣으면 거부한다', () => {
  rejects({ ...base(), workerModels: ['claude', 'codex'] }, /codex/);
  rejects({ ...base(), workerModels: ['claude', 'ghost'] }, /허용되지 않는/);
});

test('workerModels 모양 오류는 거부한다', () => {
  rejects({ ...base(), workerModels: 'claude' });
  rejects({ ...base(), workerModels: ['claude', 'claude'] }, /두 번/);
  rejects({ ...base(), workerModels: [''] });
});

test('필수 키 누락, 알 수 없는 키, 정수가 아닌 값, 0 이하는 거부한다', () => {
  for (const k of Object.keys(base())) {
    const c = base();
    delete c[k];
    rejects(c, /필수 키/);
  }
  rejects({ ...base(), extra: 1 }, /알 수 없는 키/);
  rejects({ ...base(), reworkLimitPerIssue: 0 }, /1 이상의 정수/);
  rejects({ ...base(), reworkLimitPerIssue: 1.5 }, /1 이상의 정수/);
  rejects({ ...base(), reworkLimitPerIssue: '2' }, /1 이상의 정수/);
  rejects({ ...base(), lightCheck: { maxFiles: 3 } }, /필수 키/);
  rejects({ ...base(), lightCheck: { maxFiles: 3, maxReads: -1 } }, /1 이상의 정수/);
  rejects({ ...base(), researchResult: [] }, /객체/);
});

test('파일이 없거나 JSON이 깨지거나 최상위가 객체가 아니면 거부한다', () => {
  assert.throws(() => loadCoordinatorConfig(join(tmpdir(), 'nope-coordcfg.json')), CoordinatorConfigError);
  rejects('{ broken');
  rejects([]);
});

test('조언 판정 한도: 규칙의 "거부 후 수정" 횟수 + 첫 제출 = run-reviewer의 판정 횟수(소유자 결정 8-2)', () => {
  assert.equal(loadCoordinatorConfig(DEFAULT_COORDINATOR_CONFIG).advisorRevisionAfterReject + 1, ADVICE_LIMIT);
});
