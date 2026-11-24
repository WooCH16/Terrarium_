// run-reviewer(이슈 #44, ADR 0008): 리뷰어는 Jev. 실제 API는 부르지 않는다(가짜 fetch가 질문마다 확률을 돌려준다).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { main, workerTypeOf, latestReport, findIssueWorktree, readAdviceLog, MAX_ADVICE_CHARS } from '../operator/run-reviewer.mjs';
import { collectAllowed } from '../operator/merge-adapter.mjs';

const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 잠긴 파일은 무시 */ } } });
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();

const ISSUE_BODY = '## 목표\n시험\n\n## 완료 기준\n| 기준 | 확인 방법 |\n|---|---|\n| 정렬 옵션이 있다 | node --test |\n| 문서가 있다 | README를 본다 |\n\n- 워커 모델: claude (시험)\n\n## 의존하는 이슈\n없음\n';
const reportOf = (hash, evidence = '`src/sort.mjs:3`') => [
  '## 결과 보고서', `커밋 해시: ${hash}`, '', '### 기준별 충족 여부', '| 기준 | 충족 | 근거 위치 |', '|---|---|---|',
  `| 정렬 옵션이 있다 | 충족 | ${evidence} |`, '| 문서가 있다 | 충족 | `README.md` |', '', '### 변경 요약', '정렬', '', '### 사실 칸', '- 실제 워커 모델: gemini', '', '### 남은 문제', '없음', '',
].join('\n');

// 가짜 Jev: 질문 이름마다 확률. 기본은 모두 0.95. 요청은 calls에 남는다.
function fakeJev(probs = {}, { status = 200, model = 'jev-1.14.0' } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, req });
    const answers = Object.fromEntries(Object.keys(req.questions).map((n) => [n, { type: 'noul', noul: probs[n] ?? probs['*'] ?? 0.95 }]));
    const body = status === 200 ? { model, answers, usage: { input_tokens: 1, output_tokens: 1 } } : { detail: 'nope' };
    return { status, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

// 작업 폴더: 근거 파일이 든 커밋 하나가 있는 git 저장소.
function setup({ body = ISSUE_BODY, report, jev = fakeJev(), files = { 'src/sort.mjs': 'x', 'README.md': 'r' } } = {}) {
  const root = fwd(mkdtempSync(`${fwd(tmpdir())}/rr-`));
  made.push(root);
  const cwd = `${root}/target`;
  execFileSync('git', ['init', '-q', '-b', 'main', cwd]);
  for (const [f, t] of Object.entries(files)) { mkdirSync(`${cwd}/${f}`.replace(/\/[^/]+$/, ''), { recursive: true }); writeFileSync(`${cwd}/${f}`, t); }
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', 'work');
  const hash = git(cwd, 'rev-parse', 'HEAD');
  const s = { root, cwd, hash, posted: [], jev };
  s.report = report ?? reportOf(hash);
  s.comments = [{ body: s.report, createdAt: '2026-11-18T00:00:00Z' }];
  s.run = async (argv, { env = {}, deps = {} } = {}) => {
    const out = []; const err = [];
    const code = await main(argv, { HARNESS_RUN_DIR: root, ...env }, {
      write: (l) => out.push(l), writeErr: (l) => err.push(l),
      harness: { designatedRepo: 'o/r', targetProject: cwd },
      fetchIssue: async () => ({ body, comments: s.comments }),
      postComment: async (n, text) => { s.posted.push({ n, text }); return `https://github.com/o/r/issues/${n}#issuecomment-${100 + s.posted.length}`; },
      jevKey: 'test-key', fetch: s.jev.fetch, sleep: async () => {},
      ...deps,
    });
    return { code, out, err };
  };
  return s;
}

// ---------- 결과 보고서 판정 ----------
test('#44 허용: 모든 질문이 예면 허용 댓글(두 줄)과 Jev 판단 표를 남기고 stdout은 한 줄', async () => {
  const s = setup();
  const r = await s.run(['--issue', '7']);
  assert.equal(r.code, 0, r.err.join());
  assert.deepEqual(r.out, ['https://github.com/o/r/issues/7#issuecomment-101 | 리뷰어 판정: 허용 | 모델: jev (jev-1.14.0)']);
  const text = s.posted[0].text;
  assert.deepEqual(text.split('\n').slice(0, 2), ['## 리뷰어 판정: 허용', `허용된 커밋: ${s.hash}`]);
  assert.match(text, /^리뷰어 모델: jev \(jev-1\.14\.0\)$/m);
  assert.match(text, /^워커 타입: gemini$/m, '실제 워커 모델 줄을 먼저 쓴다');
  assert.match(text, /### Jev 판단/);
  assert.ok(!text.includes('test-key'), '키는 댓글에 없다');
});

test('#44 요청: 기준마다 met·evidence 두 Noul, 상태는 보고서, 모델은 설정의 고정 ID, 키는 Authorization에만', async () => {
  const s = setup();
  await s.run(['--issue', '7']);
  const [c] = s.jev.calls;
  assert.equal(c.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(c.headers.authorization, 'Bearer test-key');
  assert.equal(c.req.model, 'jev-1.14.0');
  assert.deepEqual(Object.keys(c.req.questions), ['met_1', 'evidence_1', 'met_2', 'evidence_2']);
  assert.ok(Object.values(c.req.questions).every((q) => q.type === 'noul' && q.criteria.true && q.criteria.false));
  assert.match(c.req.questions.met_1.instructions, /정렬 옵션이 있다/);
  assert.match(c.req.questions.evidence_2.instructions, /문서가 있다/);
  assert.deepEqual(c.req.state, { report: s.report });
});

test('#44 거부: 아니오나 애매(0.3~0.7)가 하나라도 있으면 거부하고 그 질문과 확률을 이유로 남긴다', async () => {
  for (const [probs, re] of [[{ met_2: 0.1 }, /아니오 \(0\.10\): 충족으로 적혔는가 — 기준 2: 문서가 있다/], [{ evidence_1: 0.5 }, /판단이 서지 않음 \(0\.50\): 근거 위치가 구체적인가 — 기준 1: 정렬 옵션이 있다/]]) {
    const s = setup({ jev: fakeJev(probs) });
    const r = await s.run(['--issue', '7']);
    assert.equal(r.code, 0, r.err.join());
    assert.match(r.out[0], /리뷰어 판정: 거부 \| 모델: jev \(jev-1\.14\.0\)$/);
    const text = s.posted[0].text;
    assert.equal(text.split('\n')[0], '## 리뷰어 판정: 거부');
    assert.match(text, re);
    assert.ok(!/^허용된 커밋:/m.test(text));
  }
});

test('#44 코드 검사: 해시 줄·칸·완료 기준 표·근거 파일에 문제가 있으면 Jev를 부르지 않고 거부한다', async () => {
  const cases = [
    [(h) => reportOf(h).replace(/커밋 해시: .*/, `커밋 해시: ${h}\n커밋 해시: ${h}`), /커밋 해시/, ISSUE_BODY],
    [(h) => reportOf(h).replace('### 남은 문제\n없음\n', ''), /`남은 문제` 칸이 없습니다/, ISSUE_BODY],
    [(h) => reportOf(h, '`src/missing.mjs:9`'), /근거 위치의 파일 `src\/missing\.mjs`가 보고서 커밋에 없습니다/, ISSUE_BODY],
    [(h) => reportOf(h), /완료 기준/, ISSUE_BODY.replace('## 완료 기준', '## 끝나는 조건')],
    [() => reportOf('d'.repeat(40)), /보고서의 커밋이 작업 폴더의 저장소에 없어/, ISSUE_BODY],
    // 실제 API 시험(#44): 기준을 바꿔 쓰면 Jev 판단이 경계(0.69~0.70)에 걸렸다. 양식대로 그대로 옮겼는지는 코드가 본다.
    [(h) => reportOf(h).replace('| 문서가 있다 |', '| 문서 있음 |'), /보고서 표에 이슈의 기준이 그대로 없습니다: 문서가 있다/, ISSUE_BODY],
  ];
  for (const [mk, re, body] of cases) {
    const jev = fakeJev();
    const s0 = setup({ jev, body });
    s0.comments = [{ body: mk(s0.hash), createdAt: '2026-11-18T00:00:00Z' }];
    const r = await s0.run(['--issue', '7']);
    assert.equal(r.code, 0, r.err.join());
    assert.match(r.out[0], /리뷰어 판정: 거부 \| 모델: jev \(호출 안 함: 코드 검사에서 거부\)/);
    assert.match(s0.posted[0].text, re);
    assert.equal(jev.calls.length, 0, 'Jev를 부르지 않는다');
  }
});

test('#44 Jev 실패는 판정이 아니다: 429·500은 종료 코드 6, 댓글 없음. 키가 없으면 종료 코드 2', async () => {
  for (const status of [429, 500]) {
    const s = setup({ jev: fakeJev({}, { status }) });
    const r = await s.run(['--issue', '7']);
    assert.equal(r.code, 6);
    assert.match(r.err[0], new RegExp(`Jev 응답 ${status}`));
    assert.equal(s.posted.length, 0);
  }
  const s = setup();
  const r = await s.run(['--issue', '7'], { deps: { jevKey: null } });
  assert.equal(r.code, 2);
  assert.match(r.err[0], /TYPESAFE_API_KEY가 없습니다/);
  assert.equal(s.jev.calls.length, 0);
});

test('#44 병합 어댑터의 collectAllowed가 허용 댓글을 허용으로, 거부 댓글을 허용 아님으로 읽는다', async () => {
  const s = setup();
  const r = await s.run(['--issue', '7']);
  const url = r.out[0].split(' | ')[0];
  const issues = [{
    number: 7, body: ISSUE_BODY, labels: [],
    comments: [
      { body: s.report, createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', url: 'https://github.com/o/r/issues/7#issuecomment-1' },
      { body: s.posted[0].text, createdAt: '2026-11-18T00:01:00Z', updatedAt: '2026-11-18T00:01:00Z', url },
    ],
  }];
  assert.deepEqual(collectAllowed(issues).map((a) => [a.issue, a.sha]), [[7, s.hash]]);
  const t = setup({ jev: fakeJev({ '*': 0.1 }) });
  await t.run(['--issue', '7']);
  issues[0].comments[1] = { ...issues[0].comments[1], body: t.posted[0].text };
  assert.deepEqual(collectAllowed(issues), []);
});

test('보고서가 없거나 인자가 틀리면 종료 코드 2, 댓글 없음', async () => {
  const none = setup();
  none.comments = [{ body: '그냥 댓글' }];
  assert.equal((await none.run(['--issue', '7'])).code, 2);
  const s = setup();
  for (const argv of [[], ['--issue'], ['--issue', 'x'], ['--issue', '7', '--issue', '8'], ['--issue', '7', '--worker-model', 'codex'], ['--issue', '7', '--foo', 'x']]) {
    const r = await s.run(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err[0], /^오류: /);
  }
  assert.equal(s.posted.length, 0);
});

test('댓글 게시가 실패하면 종료 코드 5', async () => {
  const s = setup();
  const r = await s.run(['--issue', '7'], { deps: { postComment: async () => { throw new Error('gh 실패'); } } });
  assert.equal(r.code, 5);
});

test('workerTypeOf와 latestReport', () => {
  assert.equal(workerTypeOf('- 워커 모델: muse (x)'), 'muse');
  assert.equal(workerTypeOf('워커 모델: `gemini`'), 'gemini');
  assert.equal(workerTypeOf('- 워커 모델: codex'), null);
  const h = 'c'.repeat(40);
  const rep = latestReport([{ body: `## 결과 보고서\n커밋 해시: ${'1'.repeat(40)}` }, { body: 'x' }, { body: `## 결과 보고서\n커밋 해시: ${h}` }]);
  assert.equal(rep.hash, h);
  assert.equal(latestReport([{ body: 'x' }]), null);
  assert.equal(latestReport([{ body: `## 결과 보고서\n커밋 해시: ${'A'.repeat(40)}` }]).hash, null);
});

test('findIssueWorktree: 하달 번호가 가장 큰 이슈 워크트리를 고르고, 없으면 null', () => {
  const root = fwd(mkdtempSync(`${fwd(tmpdir())}/fw-`));
  made.push(root);
  assert.equal(findIssueWorktree(root, 7), null);
  for (const d of ['h1/issue-7', 'h2/issue-7', 'h10/issue-8', 'x/issue-7']) mkdirSync(`${root}/worktrees/${d}`, { recursive: true });
  assert.equal(findIssueWorktree(root, 7), `${root}/worktrees/h2/issue-7`);
  assert.equal(findIssueWorktree(root, 8), `${root}/worktrees/h10/issue-8`);
  assert.equal(findIssueWorktree(root, 9), null);
});

// ---------- 조언 판정 (ADR 0006, 판정자 Jev) ----------
const PROPOSAL = '# 제안문: 정렬\n\n## 작업 단위 1: 정렬\n### 목표\n정렬\n### 완료 기준\n| 기준 | 확인 방법 |\n|---|---|\n| list --sort title이 가나다순으로 출력한다 | node --test test/sort.test.mjs |\n### 먼저 끝나야 할 것\n없음\n### 전제·위험\n없음\n';
const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

function adviceSetup(text = PROPOSAL, opts = {}) {
  const s = setup(opts);
  s.inbox = `${s.root}/reviewer-inbox`;
  mkdirSync(s.inbox, { recursive: true });
  s.put = (t = text, n = 'p1.md') => { const f = `${s.inbox}/${n}`; writeFileSync(f, t); return f; };
  s.file = s.put();
  s.logFile = `${s.root}/advice-log.jsonl`;
  s.log = () => readAdviceLog(s.logFile);
  return s;
}

test('#44 조언 허용: 기준마다 decidable·checkable이 예면 전달 파일로 복사하고 기록한 뒤 제안문을 지운다', async () => {
  const s = adviceSetup();
  const h = sha(PROPOSAL);
  const r = await s.run(['--advice', s.file, '--advice-id', 'sort-1']);
  assert.equal(r.code, 0, r.err.join());
  const handoff = `${s.root}/handoffs/advice-${h.slice(0, 8)}.md`;
  assert.deepEqual(r.out, [`리뷰어 판정: 허용 | 허용된 조언: ${h} | 전달 파일: ${handoff} | 조언 id: sort-1 | 모델: jev (jev-1.14.0) | 시도: 1/2`]);
  assert.equal(readFileSync(handoff, 'utf8'), PROPOSAL);
  assert.equal(existsSync(s.file), false);
  const [e] = s.log();
  assert.deepEqual({ ...e, time: 'T' }, { time: 'T', file: 'p1.md', adviceId: 'sort-1', sha256: h, verdict: '허용', malformed: false, reviewer: 'jev (jev-1.14.0)', attempt: 1 });
  const [c] = s.jev.calls;
  assert.deepEqual(Object.keys(c.req.questions), ['decidable_1_1', 'checkable_1_1']);
  assert.deepEqual(c.req.state, { proposal: PROPOSAL });
  assert.match(c.req.questions.checkable_1_1.instructions, /node --test test\/sort\.test\.mjs/);
});

test('#44 조언 거부: Jev가 아니오면 이유를 stdout과 기록에 남기고, 양식이 빠지면 Jev 없이 거부한다', async () => {
  const s = adviceSetup(PROPOSAL, { jev: fakeJev({ decidable_1_1: 0.2 }) });
  const r = await s.run(['--advice', s.file, '--advice-id', 'sort-1']);
  assert.equal(r.code, 0, r.err.join());
  const lines = r.out[0].split('\n');
  assert.equal(lines[0], '리뷰어 판정: 거부 | 모델: jev (jev-1.14.0) | 시도: 1/2');
  assert.match(lines[1], /아니오 \(0\.20\): 충족을 가릴 수 있는 기준인가 — 작업 단위 1: 정렬: list --sort title/);
  assert.equal(s.log()[0].verdict, '거부');
  assert.equal(existsSync(`${s.root}/handoffs`), false);

  const jev = fakeJev();
  const t = adviceSetup(PROPOSAL.replace('### 전제·위험\n없음\n', ''), { jev });
  const r2 = await t.run(['--advice', t.file, '--advice-id', 'x']);
  assert.equal(r2.code, 0, r2.err.join());
  assert.match(r2.out[0], /모델: jev \(호출 안 함: 코드 검사에서 거부\)/);
  assert.match(r2.out[0], /작업 단위 1: 정렬: `### 전제·위험` 칸이 없습니다/);
  assert.equal(jev.calls.length, 0);
});

test('2회 한도: 같은 --advice-id가 2번 거부되면 Jev를 부르지 않고 종료 코드 7, 다른 id는 따로 센다', async () => {
  const s = adviceSetup(PROPOSAL, { jev: fakeJev({ '*': 0.1 }) });
  assert.equal((await s.run(['--advice', s.file, '--advice-id', 'sort-1'])).code, 0);
  const r2 = await s.run(['--advice', s.put(), '--advice-id', 'sort-1']);
  assert.match(r2.out[0], /시도: 2\/2/);
  assert.match(r2.out[0], /2번 거부되었습니다.*코디네이터에게 알리세요/);
  const before = s.jev.calls.length;
  const f3 = s.put();
  const r3 = await s.run(['--advice', f3, '--advice-id', 'sort-1']);
  assert.equal(r3.code, 7);
  assert.match(r3.out[0], /이미 2번 거부되어 더 판정하지 않습니다/);
  assert.equal(s.jev.calls.length, before, 'Jev를 부르지 않았다');
  assert.equal(s.log().length, 2);
  assert.equal((await s.run(['--advice', f3, '--advice-id', 'sort-2'])).code, 0);
});

test('조언 판정이 나오지 않은 실패(6 Jev 실패, 4 제안문 변경)는 기록하지 않고 제안문을 남긴다', async () => {
  const s = adviceSetup(PROPOSAL, { jev: fakeJev({}, { status: 503 }) });
  const r = await s.run(['--advice', s.file, '--advice-id', 'x']);
  assert.equal(r.code, 6);
  assert.equal(existsSync(s.logFile), false);
  assert.equal(existsSync(s.file), true);
  const t = adviceSetup();
  const changing = { fetch: async (url, init) => { writeFileSync(t.file, 'changed'); return t.jev.fetch(url, init); } };
  const r2 = await t.run(['--advice', t.file, '--advice-id', 'x'], { deps: changing });
  assert.equal(r2.code, 4);
  assert.match(r2.err[0], /제안문 파일이 바뀌었거나/);
  assert.equal(existsSync(t.logFile), false);
});

test('제안문 경로: 리뷰어 전용 폴더 바로 아래의 파일만 받는다(밖, .., 하위 폴더, 비슷한 이름의 폴더, 없는 파일은 종료 코드 2)', async () => {
  const s = adviceSetup();
  mkdirSync(`${s.inbox}/sub`, { recursive: true });
  writeFileSync(`${s.inbox}/sub/p.md`, PROPOSAL);
  mkdirSync(`${s.root}/reviewer-inbox-evil`, { recursive: true });
  writeFileSync(`${s.root}/reviewer-inbox-evil/p.md`, PROPOSAL);
  writeFileSync(`${s.root}/notes.md`, PROPOSAL);
  for (const p of [`${s.root}/notes.md`, `${s.inbox}/../notes.md`, `${s.inbox}/sub/p.md`, `${s.root}/reviewer-inbox-evil/p.md`, `${s.inbox}/없음.md`, `${s.inbox}/none.md`, s.inbox, `${s.inbox}/sub`]) {
    const r = await s.run(['--advice', p, '--advice-id', 'x']);
    assert.equal(r.code, 2, p);
  }
  assert.equal(s.jev.calls.length, 0);
  assert.equal(existsSync(s.file), true);
});

test('조언 인자 오류: --advice-id 없음, --issue와 섞음, id 모양, 빈 파일, 너무 긴 제안문은 종료 코드 2', async () => {
  const s = adviceSetup();
  for (const argv of [['--advice', s.file], ['--advice-id', 'x'], ['--advice', s.file, '--advice-id', 'x', '--issue', '7'], ['--advice', s.file, '--advice-id', 'x', '--worker-model', 'muse'],
    ['--advice', s.file, '--advice-id', '../x'], ['--advice', s.file, '--advice-id', 'a b'], ['--advice', s.file, '--advice-id', 'x'.repeat(65)]]) {
    assert.equal((await s.run(argv)).code, 2, JSON.stringify(argv));
  }
  assert.equal((await s.run(['--advice', s.put('  \n', 'empty.md'), '--advice-id', 'x'])).code, 2);
  const long = await s.run(['--advice', s.put('가'.repeat(MAX_ADVICE_CHARS + 1), 'long.md'), '--advice-id', 'x']);
  assert.equal(long.code, 2);
  assert.match(long.err[0], /너무 깁니다/);
  assert.equal(s.jev.calls.length, 0);
  assert.equal(existsSync(s.logFile), false);
});

test('실행 기록이 깨졌으면 한도를 셀 수 없어 종료 코드 2로 멈춘다', async () => {
  const s = adviceSetup();
  writeFileSync(s.logFile, '{"adviceId":"x","verdict":"거부"}\n{ broken\n');
  const r = await s.run(['--advice', s.file, '--advice-id', 'x']);
  assert.equal(r.code, 2);
  assert.match(r.err[0], /2번째 줄이 JSON이 아닙니다/);
  assert.equal(s.jev.calls.length, 0);
});

test('#25: Jev가 한 번 503이어도 스크립트가 다시 불러 판정을 남긴다(종료 코드 0)', async () => {
  const s = setup();
  let n = 0;
  const flaky = async (url, init) => (++n === 1 ? { status: 503, text: async () => 'down' } : s.jev.fetch(url, init));
  const r = await s.run(['--issue', '7'], { deps: { fetch: flaky } });
  assert.equal(r.code, 0, r.err.join());
  assert.equal(n, 2);
  assert.match(r.out[0], /리뷰어 판정: 허용/);
});
