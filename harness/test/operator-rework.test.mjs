import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { main as runOperator } from '../operator/run-operator.mjs';
import { main as enqueueMain } from '../operator/merge-adapter-enqueue.mjs';
import { main as reflectMain } from '../operator/run-reflect.mjs';
import { collectAllowed, parseDependsOn } from '../operator/merge-adapter.mjs';
import { workerTypeOf } from '../operator/run-reviewer.mjs';

// 소유자 결정 2-3(반영 없이 새 하달로 재작업), 2-1(한도 초과는 막힘으로 모아 보고), 2-4(결과 없음 재하달), 5-3(실제 워커 모델로 리뷰어 순환).
// 실제 모델·gh는 부르지 않는다(세션과 gh는 주입한 가짜).
const here = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const realHarness = dirname(here).replace(/\\/g, '/');
const T = { timeout: 120000 };
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 잠긴 파일은 무시 */ } } });
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();

const OK_TEST = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const T0 = '2026-01-01T00:00:00Z';
let seq = 0;
const cm = (body) => ({ id: ++seq, author: { login: 'rev' }, body, url: `https://github.com/o/r/issues/1#issuecomment-${1000 + seq}`, createdAt: new Date(Date.parse(T0) + seq * 1000).toISOString(), updatedAt: new Date(Date.parse(T0) + seq * 1000).toISOString() });
const reportOf = (sha, extra = '') => cm(`## 결과 보고서\n커밋 해시: ${sha}\n${extra}`);
const allowOf = (sha) => cm(`## 리뷰어 판정: 허용\n\n허용된 커밋: ${sha}\n이유`);

// 실행 폴더(harness.json), 하네스 폴더(실제 문서·설정 복사), 대상 저장소(main에 통과하는 시험 하나).
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'rework-')).replace(/\\/g, '/');
  made.push(base);
  const run = `${base}/run`;
  const memo = `${base}/memo`;
  mkdirSync(`${run}/handoffs`, { recursive: true });
  mkdirSync(`${memo}/test`, { recursive: true });
  git(memo, 'init', '-q', '-b', 'main');
  git(memo, 'config', 'user.name', 't');
  git(memo, 'config', 'user.email', 't@t');
  git(memo, 'config', 'core.autocrlf', 'false');
  writeFileSync(`${memo}/test/ok.test.mjs`, OK_TEST);
  writeFileSync(`${memo}/README.md`, 'base\n');
  git(memo, 'add', '-A');
  git(memo, 'commit', '-q', '-m', 'base');
  writeFileSync(`${run}/harness.json`, JSON.stringify({ harnessDir: realHarness, targetProject: memo, designatedRepo: 'o/r', issuesClone: `${base}/issues`, worktrees: `${run}/worktrees` }));
  return { base, run, memo };
}

function branch(f, name, file, text) {
  git(f.memo, 'checkout', '-q', '-b', name, 'main');
  writeFileSync(`${f.memo}/${file}`, text);
  git(f.memo, 'add', '-A');
  git(f.memo, 'commit', '-q', '-m', `work ${name}`);
  const sha = git(f.memo, 'rev-parse', 'HEAD');
  git(f.memo, 'checkout', '-q', 'main');
  return sha;
}

// 상태 라벨과 댓글을 기억하는 가짜 이슈 저장소. run-operator와 합치기 스크립트가 같이 쓴다.
function fakeRepo(init) {
  const issues = new Map(Object.entries(init).map(([n, v]) => [Number(n), { label: v.label ?? null, comments: v.comments ?? [], body: v.body ?? '## 목표\nx\n\n## 의존하는 이슈\n없음\n' }]));
  const sets = [];
  const url = (n) => `https://github.com/o/r/issues/${n}`;
  return {
    issues, sets,
    // run-operator 쪽
    fetchIssue: async (n) => ({ state: issues.get(n).label ?? '라벨 없음', url: url(n) }),
    setState: async (n, s) => { sets.push([n, s]); issues.get(n).label = s; },
    countReports: async (n) => issues.get(n).comments.filter((c) => c.body.startsWith('## 결과 보고서')).length,
    fetchDependsOn: async (n) => parseDependsOn(issues.get(n).body) ?? [],
    // 합치기 스크립트 쪽
    fetchIssueData: async (n) => { const i = issues.get(n); return { number: n, state: 'OPEN', url: url(n), labels: i.label ? [{ name: i.label }] : [], body: i.body, comments: i.comments }; },
  };
}

const collector = () => { const out = []; const err = []; return { out, err, deps: { write: (l) => out.push(l), writeErr: (l) => err.push(l) } }; };
const env = (f) => ({ ...process.env, HARNESS_RUN_DIR: f.run });
const passAll = async () => ({ ok: true, code: 0, timedOut: false, overCap: false });

async function dispatch(f, repo, issues, launched) {
  const c = collector();
  const code = await runOperator(['--issues', issues.join(',')], { HARNESS_RUN_DIR: f.run }, {
    ...c.deps, ...repo,
    launchSession: async (o) => { launched.push({ handoff: o.handoff, issues: o.issues, prompt: o.prompt }); return { code: 0, timedOut: false }; },
  });
  return { code, lines: c.out.join('\n').split('\n') };
}

test('재작업(2-3): 허용됐지만 반영하지 않은 이슈를 새 하달로 다시 하달하면 받아들여 처리하고, 앞선 하달의 반영은 새 결과를 섞지 않는다', T, async () => {
  const f = fixture();
  // 하달 h1: 이슈 7, 8이 허용됐고 아직 반영하지 않았다.
  mkdirSync(`${f.run}/handoffs/h1`);
  const s7 = branch(f, 'h1/issue-7', 'feature7.txt', 'old\n');
  const s8 = branch(f, 'h1/issue-8', 'feature8.txt', 'eight\n');
  const repo = fakeRepo({
    7: { label: '허용됨', comments: [reportOf(s7), allowOf(s7)] },
    8: { label: '허용됨', comments: [reportOf(s8), allowOf(s8)] },
  });

  // 코디네이터가 7을 다시 하달한다(대조 미충족). 반영 없이 새 하달 h2가 시작되고 7은 진행중으로 돌아간다.
  const launched = [];
  const d = await dispatch(f, repo, [7], launched);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].handoff, 'h2');
  assert.deepEqual(launched[0].issues, [7]);
  assert.deepEqual(repo.sets, [[7, '진행중']]);
  assert.equal(d.code, 0);
  assert.deepEqual(d.lines, ['#7 | 진행중 | https://github.com/o/r/issues/7']);

  // 세션 안에서 워커가 h2/issue-7을 만들었다고 보고 합친다: 허용됨이 아니므로 건너뛰지 않고 리뷰대기가 된다.
  const r7 = branch(f, 'h2/issue-7', 'feature7.txt', 'new\n');
  const e = collector();
  const ecode = await enqueueMain(['--handoff', 'h2'], env(f), { ...e.deps, runTests: passAll, fetchIssueData: repo.fetchIssueData, setState: repo.setState });
  assert.equal(ecode, 0, e.err.join());
  assert.deepEqual(e.out, ['#7 | 리뷰대기 | https://github.com/o/r/issues/7']);
  assert.equal(git(f.memo, 'rev-parse', 'refs/heads/integration/h2^2'), r7);

  // 아직 새 보고서도 판정도 없을 때 h2를 반영하면: 가장 최근 허용은 h1의 옛 결과이므로 h2에서는 반영하지 않는다(무결성 오류로 멈추지 않는다).
  const early = collector();
  const earlyCode = await reflectMain(['--handoff', 'h2'], env(f), { ...early.deps, runTests: passAll, fetchIssueData: repo.fetchIssueData, setState: repo.setState });
  assert.equal(earlyCode, 1, early.err.join());
  assert.deepEqual(early.out, ['#7 | 보류 | https://github.com/o/r/issues/7']);
  assert.equal(existsSync(`${f.memo}/feature7.txt`), false);

  // 새 보고서가 올라왔고 판정은 아직이다. 이때 h1을 반영해도 7의 옛 결과는 들어가지 않고 8만 들어간다(무결성 오류로 멈추지 않는다).
  repo.issues.get(7).comments.push(reportOf(r7));
  const mainBefore = git(f.memo, 'rev-parse', 'refs/heads/main');
  const c1 = collector();
  const code1 = await reflectMain(['--handoff', 'h1'], env(f), { ...c1.deps, runTests: passAll, fetchIssueData: repo.fetchIssueData, setState: repo.setState });
  assert.equal(code1, 1, c1.err.join());
  assert.deepEqual(c1.out.join('\n').split('\n'), ['#7 | 보류 | https://github.com/o/r/issues/7', '#8 | 반영됨 | https://github.com/o/r/issues/8']);
  assert.notEqual(git(f.memo, 'rev-parse', 'refs/heads/main'), mainBefore);
  assert.equal(existsSync(`${f.memo}/feature8.txt`), true);
  assert.equal(existsSync(`${f.memo}/feature7.txt`), false, '대체된 옛 결과는 반영하지 않는다');
  // 새 보고서 뒤, 판정 전에 h2를 반영해도 들어가지 않는다(허용 판정 뒤의 새 보고서).
  const mid = collector();
  const midCode = await reflectMain(['--handoff', 'h2'], env(f), { ...mid.deps, runTests: passAll, fetchIssueData: repo.fetchIssueData, setState: repo.setState });
  assert.equal(midCode, 1, mid.err.join());
  assert.equal(existsSync(`${f.memo}/feature7.txt`), false);

  // h2의 판정이 허용이면 h2 반영으로 새 결과가 들어간다.
  repo.issues.get(7).comments.push(allowOf(r7));
  repo.issues.get(7).label = '허용됨';
  const c2 = collector();
  const code2 = await reflectMain(['--handoff', 'h2'], env(f), { ...c2.deps, runTests: passAll, fetchIssueData: repo.fetchIssueData, setState: repo.setState });
  assert.equal(code2, 0, c2.err.join());
  assert.deepEqual(c2.out, ['#7 | 반영됨 | https://github.com/o/r/issues/7']);
  assert.equal(git(f.memo, 'show', 'refs/heads/main:feature7.txt'), 'new');

  // h2 판정 뒤에 h1을 다시 반영해도 7의 옛 결과는 들어가지 않는다(더 뒤의 하달에 같은 이슈 브랜치가 있다).
  const c3 = collector();
  const code3 = await reflectMain(['--handoff', 'h1'], env(f), { ...c3.deps, runTests: passAll, fetchIssueData: repo.fetchIssueData, setState: repo.setState });
  assert.notEqual(code3, 2, c3.err.join());
  assert.equal(git(f.memo, 'show', 'refs/heads/main:feature7.txt'), 'new');
});

test('재작업 한도: 결과 보고서가 rejectLimit+1(3)개면 다시 하달해도 거부목록으로 두고 세션에 넘기지 않는다(모아서 보고, 종료 코드 1)', T, async () => {
  const f = fixture();
  const sha = 'a'.repeat(40);
  const repo = fakeRepo({
    7: { label: '미완료', comments: [reportOf(sha), reportOf(sha), reportOf(sha)] }, // 첫 결과 + 재작업 2회
    8: { label: '미완료', comments: [reportOf(sha), reportOf(sha)] }, // 첫 결과 + 재작업 1회: 한 번 더 할 수 있다
  });
  const launched = [];
  const d = await dispatch(f, repo, [7, 8], launched);
  assert.equal(d.code, 1);
  assert.deepEqual(d.lines, ['#7 | 거부목록 | https://github.com/o/r/issues/7', '#8 | 미완료 | https://github.com/o/r/issues/8']);
  assert.deepEqual(launched.map((l) => l.issues), [[8]], '한도를 넘은 이슈는 세션에 넘기지 않는다');
  assert.ok(!/#7/.test(launched[0].prompt.split('\n').find((l) => l.startsWith('- 이슈:'))), '세션 프롬프트의 이슈 목록에도 없다');
  assert.deepEqual(repo.sets, [[7, '거부목록']]);
});

test('재작업 한도: 모든 이슈가 한도를 넘으면 세션을 띄우지 않고 거부목록만 보고한다', T, async () => {
  const f = fixture();
  const sha = 'b'.repeat(40);
  const repo = fakeRepo({ 9: { label: '허용됨', comments: [reportOf(sha), allowOf(sha), reportOf(sha), reportOf(sha)] } });
  const launched = [];
  const d = await dispatch(f, repo, [9], launched);
  assert.equal(d.code, 1);
  assert.deepEqual(d.lines, ['#9 | 거부목록 | https://github.com/o/r/issues/9']);
  assert.deepEqual(launched, []);
  assert.equal(repo.issues.get(9).label, '거부목록');
});

test('결과 없음 재하달(2-4): 보고서 없이 보류된 이슈는 다시 하달하면 진행중으로 돌아가고 재작업 한도에 세지 않는다', T, async () => {
  const f = fixture();
  const sha = 'c'.repeat(40);
  const repo = fakeRepo({
    7: { label: '보류', comments: [] },
    8: { label: '보류', comments: [reportOf(sha), reportOf(sha), reportOf(sha)] }, // 보고서가 이미 한도만큼 있으면 결과 없음 재하달이라도 막힌다
  });
  const launched = [];
  const d = await dispatch(f, repo, [7, 8], launched);
  assert.deepEqual(launched.map((l) => l.issues), [[7]]);
  assert.deepEqual(repo.sets, [[7, '진행중'], [8, '거부목록']]);
  assert.equal(d.code, 1);
});

test('--handoff 재시작은 재작업이 아니다: 상태를 되돌리지 않고 한도도 보지 않는다', T, async () => {
  const f = fixture();
  mkdirSync(`${f.run}/handoffs/h1`);
  const sha = 'd'.repeat(40);
  const repo = fakeRepo({ 7: { label: '허용됨', comments: [reportOf(sha), reportOf(sha), reportOf(sha)] } });
  const launched = [];
  const c = collector();
  const code = await runOperator(['--issues', '7', '--handoff', 'h1'], { HARNESS_RUN_DIR: f.run }, {
    ...c.deps, ...repo, launchSession: async (o) => { launched.push(o.issues); return { code: 0, timedOut: false }; },
  });
  assert.equal(code, 0, c.out.join());
  assert.deepEqual(launched, [[7]]);
  assert.deepEqual(repo.sets, []);
});

test('반영됨·거부목록 이슈는 새 하달에서도 상태를 바꾸지 않는다', T, async () => {
  const f = fixture();
  const repo = fakeRepo({ 7: { label: '반영됨' }, 8: { label: '거부목록' } });
  const launched = [];
  await dispatch(f, repo, [7, 8], launched);
  assert.deepEqual(repo.sets, []);
});

test('collectAllowed: 허용 판정 뒤에 새 결과 보고서가 있으면(재작업 중) 그 판정으로 반영하지 않는다', () => {
  const sha = 'e'.repeat(40);
  const base = { number: 7, labels: [], body: '## 의존하는 이슈\n없음\n' };
  const first = reportOf(sha); // 댓글 시각 순서: 보고서 → 허용 → 새 보고서
  const allow = allowOf(sha);
  allow.url = 'https://github.com/o/r/issues/7#issuecomment-1';
  const later = reportOf('f'.repeat(40));
  assert.equal(collectAllowed([{ ...base, comments: [first, allow] }]).length, 1);
  assert.deepEqual(collectAllowed([{ ...base, comments: [first, allow, later] }]), []);
});

test('리뷰어 순환(5-3): 결과 보고서의 `실제 워커 모델:` 줄을 이슈 본문의 `워커 모델:`보다 먼저 쓴다', () => {
  const body = '## 목표\nx\n- 워커 모델: claude\n';
  const rep = (extra) => [{ body: `## 결과 보고서\n커밋 해시: ${'a'.repeat(40)}\n${extra}` }];
  assert.equal(workerTypeOf(body), 'claude');
  assert.equal(workerTypeOf(body, []), 'claude', '보고서가 없으면 본문 값');
  assert.equal(workerTypeOf(body, rep('- 모델: claude → claude')), 'claude', '줄이 없으면 본문 값');
  assert.equal(workerTypeOf(body, rep('- 모델: claude → gemini (claude CLI 없음)\n- 실제 워커 모델: gemini')), 'gemini');
  assert.equal(workerTypeOf(body, rep('실제 워커 모델: `muse`')), 'muse');
  // 가장 최근 보고서만 본다.
  assert.equal(workerTypeOf(body, [...rep('- 실제 워커 모델: gemini'), { body: `## 결과 보고서\n커밋 해시: ${'b'.repeat(40)}\n` }]), 'claude');
  // 줄이 있는데 잘못됐으면 본문으로 물러서지 않고 null(코드 2로 멈춘다).
  assert.equal(workerTypeOf(body, rep('- 실제 워커 모델: codex')), null);
  assert.equal(workerTypeOf(body, rep('- 실제 워커 모델: gemini\n- 실제 워커 모델: muse')), null);
});

const dependsBody = (...nums) => `## 목표\nx\n\n## 의존하는 이슈\n${nums.map((n) => `#${n}`).join(', ')}\n`;
const noReportOf = (f) => (existsSync(`${f.run}/handoffs/no-report.json`) ? JSON.parse(readFileSync(`${f.run}/handoffs/no-report.json`, 'utf8')) : {});

test('결과 없음 한도(8-4): 보고서 없이 끝난 새 하달이 1 + 2번이면 그 실행에서 막힘, 다시 하달해도 막힘이다', T, async () => {
  const f = fixture();
  const repo = fakeRepo({ 7: { label: '진행중' } });
  const launched = [];
  const d1 = await dispatch(f, repo, [7], launched);
  assert.deepEqual([d1.code, d1.lines], [0, ['#7 | 진행중 | https://github.com/o/r/issues/7']]);
  assert.deepEqual(noReportOf(f), { 7: 1 });
  const d2 = await dispatch(f, repo, [7], launched);
  assert.equal(d2.code, 0);
  assert.deepEqual(noReportOf(f), { 7: 2 });
  const d3 = await dispatch(f, repo, [7], launched);
  assert.deepEqual([d3.code, d3.lines], [1, ['#7 | 막힘 | https://github.com/o/r/issues/7']], '2회 다시 시켜도 없으면 그 실행에서 막힘');
  assert.equal(repo.issues.get(7).label, '막힘');
  assert.equal(launched.length, 3);
  const d4 = await dispatch(f, repo, [7], launched);
  assert.deepEqual([d4.code, d4.lines], [1, ['#7 | 막힘 | https://github.com/o/r/issues/7']]);
  assert.equal(launched.length, 3, '한도를 넘긴 이슈는 세션에 넘기지 않는다');
});

test('결과 없음 한도(8-4): 보고서가 올라오면 횟수를 지우고, 세션 실패로 보류돼도 결과 없음으로 센다', T, async () => {
  const f = fixture();
  const repo = fakeRepo({ 7: { label: '진행중' } });
  const c1 = collector();
  await runOperator(['--issues', '7'], { HARNESS_RUN_DIR: f.run }, { ...c1.deps, ...repo, launchSession: async () => ({ code: 1, timedOut: false }) });
  assert.deepEqual(noReportOf(f), { 7: 1 });
  assert.equal(repo.issues.get(7).label, '보류');
  const c2 = collector();
  await runOperator(['--issues', '7'], { HARNESS_RUN_DIR: f.run }, {
    ...c2.deps, ...repo,
    launchSession: async () => { repo.issues.get(7).comments.push(reportOf('a'.repeat(40))); return { code: 0, timedOut: false }; },
  });
  assert.deepEqual(noReportOf(f), {});
});

test('결과 없음 한도(8-4): --handoff 재시작은 세지 않는다', T, async () => {
  const f = fixture();
  mkdirSync(`${f.run}/handoffs/h1`);
  const repo = fakeRepo({ 7: { label: '진행중' } });
  const c = collector();
  await runOperator(['--issues', '7', '--handoff', 'h1'], { HARNESS_RUN_DIR: f.run }, { ...c.deps, ...repo, launchSession: async () => ({ code: 0, timedOut: false }) });
  assert.deepEqual(noReportOf(f), {});
});


// 대기(8-5, 이슈 #23): "허용됐다"는 라벨이 아니라 허용 판정(collectAllowed)으로, "반영됐다"는 main의 병합 커밋으로 본다.
const land = (f, n, sha) => git(f.memo, 'merge', '-q', '--no-ff', sha, '-m', `병합: 이슈 #${n}`, '-m', `허용된 커밋: ${sha}`);

test('대기(8-5, #23): T11 모양 — 의존 이슈의 라벨은 리뷰대기, 허용 판정이 있고 main에 없으면 대기로 두고 세션에서 뺀다(결과 없음으로 세지 않는다)', T, async () => {
  const f = fixture();
  const sha = branch(f, 'h1/issue-7', 'feature7.txt', 'seven\n');
  const repo = fakeRepo({
    7: { label: '리뷰대기', comments: [reportOf(sha), allowOf(sha)] },
    8: { label: '미완료', body: dependsBody(7) },
    9: { label: '진행중' },
  });
  const launched = [];
  const d = await dispatch(f, repo, [8, 9], launched);
  assert.equal(d.code, 1);
  assert.deepEqual(d.lines, ['#8 | 대기 | https://github.com/o/r/issues/8', '#9 | 진행중 | https://github.com/o/r/issues/9']);
  assert.deepEqual(launched.map((l) => l.issues), [[9]]);
  assert.equal(repo.issues.get(8).label, '대기');
  assert.equal(repo.issues.get(7).label, '리뷰대기', '의존 이슈는 건드리지 않는다');
  assert.equal(noReportOf(f)[8], undefined);

  // 의존 이슈가 main에 반영되면(라벨은 그대로여도) 다음 새 하달에서 진행중으로 되돌려 내보낸다.
  land(f, 7, sha);
  const again = [];
  const d2 = await dispatch(f, repo, [8], again);
  assert.deepEqual(again.map((l) => l.issues), [[8]]);
  assert.deepEqual(d2.lines, ['#8 | 진행중 | https://github.com/o/r/issues/8']);
});

// 결정 8-29 단위 4로 바뀜: 전에는 허용 전(판정 없음·거부·재작업 중)인 밖의 의존을 기다리지 않고 main에서 시작했다(앞 이슈 코드 없이 시작해 run-8처럼 충돌).
// 이제는 main에 없는 밖의 의존은 허용 전이어도 대기다. 같은 --issues 안의 의존과 이미 main에 있는 의존만 기다리지 않는다.
test('대기(8-29 단위 4): 같은 --issues 안의 의존과 main에 있는 의존은 기다리지 않고, 판정이 없거나 거부된 밖의 의존은 기다린다', T, async () => {
  const f = fixture();
  const s5 = branch(f, 'h1/issue-5', 'feature5.txt', 'five\n');
  land(f, 5, s5);
  const s7 = branch(f, 'h1/issue-7', 'feature7.txt', 'seven\n');
  const s4 = 'c'.repeat(40);
  const repo = fakeRepo({
    7: { label: '리뷰대기', comments: [reportOf(s7), allowOf(s7)] },
    8: { label: '진행중', body: dependsBody(7) },
    5: { label: '리뷰대기', comments: [reportOf(s5), allowOf(s5)] },
    6: { label: '허용됨' },
    4: { label: '리뷰대기', comments: [reportOf(s4), allowOf(s4), cm('## 리뷰어 판정: 거부\n\n이유')] },
    9: { label: '진행중', body: dependsBody(4, 5, 6) },
    10: { label: '진행중', body: dependsBody(5) },
  });
  const launched = [];
  const d = await dispatch(f, repo, [7, 8, 9, 10], launched);
  assert.deepEqual(launched.map((l) => l.issues), [[7, 8, 10]]);
  assert.ok(d.lines.includes('#9 | 대기 | https://github.com/o/r/issues/9'));
});

test('대기(8-29 단위 4): 허용 판정 뒤에 새 결과 보고서가 있는(재작업 중인) 밖의 의존도 main에 없으면 기다린다', T, async () => {
  const f = fixture();
  const sha = branch(f, 'h1/issue-7', 'feature7.txt', 'seven\n');
  const repo = fakeRepo({
    7: { label: '리뷰대기', comments: [reportOf(sha), allowOf(sha), reportOf(sha)] },
    8: { label: '진행중', body: dependsBody(7) },
  });
  const launched = [];
  const d = await dispatch(f, repo, [8], launched);
  assert.deepEqual(launched, [], '모두 대기면 세션을 띄우지 않는다');
  assert.deepEqual(d.lines, ['#8 | 대기 | https://github.com/o/r/issues/8']);
});

test('대기(8-29 단위 4): 코드가 main에 오지 않는 의존(취소 라벨, 유형 조사)은 기다리지 않는다. 닫힘만으로는 빼지 않는다', T, async () => {
  const f = fixture();
  const repo = fakeRepo({
    3: { label: '취소' },
    4: { label: '진행중', body: '## 목표\n자료\n\n## 영역, 워커 모델, 유형\n- 유형: 조사 (Jev 라우팅, 확률 0.90)\n\n## 의존하는 이슈\n없음\n' },
    5: { label: '진행중' },
    8: { label: '진행중', body: dependsBody(3, 4) },
    9: { label: '진행중', body: dependsBody(5) },
  });
  const launched = [];
  await dispatch(f, repo, [8, 9], launched);
  assert.deepEqual(launched.map((l) => l.issues), [[8]], '#9는 작업 이슈 #5가 main에 없어 대기');
});
