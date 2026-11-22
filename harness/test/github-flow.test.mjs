// 결정 8-32(workflow.md 부록 B): push-branch·run-train을 가짜 gh(Actions 흉내)와 로컬 bare 원격으로 시험한다. 진짜 GitHub에 쓰지 않는다.
// S1(이슈 PR 2·하달 PR 1·CI 통과), S3(팀 둘 --base, 트레인 순서, main 빨리감기), S4(하달 PR CI 실패 → 미완료), S6(트레인 실패 → main 그대로, 실패 하달),
// S7(트레인 승인 없음 → PR 열린 채 main 그대로), S8(원격·워크플로 없음 → 로컬 흐름, CI 없음)과 스크립트의 거부·기다림 한도.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { main as pushMain, parseArgs as pushArgs, forcePushArgs, leaseable, rebuildFile } from '../operator/push-branch.mjs';
import { main as trainMain, parseTrainResult } from '../operator/run-train.mjs';
import { provenIssuesOnMain, openGit } from '../operator/merge-adapter.mjs';

const here = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const realHarness = dirname(here).replace(/\\/g, '/');
const FAKE = `${here}/helpers/fake-gh-actions.mjs`;
const T = { timeout: 120000 };
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 잠긴 파일은 무시 */ } } });

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
const gitTry = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return null; } };
const T0 = '2026-11-22T00:00:00Z';
let cid = 100;
const rc = (n, body) => ({ id: ++cid, user: { login: 'rev' }, body, created_at: T0, updated_at: T0, html_url: `https://github.com/o/r/issues/${n}#issuecomment-${cid}` });
const allowedComments = (n, sha) => [rc(n, `## 결과 보고서 (이슈 #${n})\n\n커밋 해시: ${sha}\n`), rc(n, `## 리뷰어 판정: 허용\n\n허용된 커밋: ${sha}\n이유`)];
const rejectedComments = (n, sha) => [rc(n, `## 결과 보고서 (이슈 #${n})\n\n커밋 해시: ${sha}\n`), rc(n, '## 리뷰어 판정: 거부\n\n이유: 완료 기준 2 미충족')];
const body = (deps = '없음') => `## 목표\nx\n\n## 의존하는 이슈\n${deps}\n\n## 참고 자료 위치\ny\n`;

// 실행 폴더 하나: 대상 프로젝트(main + 이슈 브랜치 + 통합 브랜치), bare 원격, 가짜 gh 상태.
// handoffs: [{ h, issues: [n...], base?: 'h1' (그 하달의 첫 이슈 브랜치 위에서 시작), team }]
function fixture({ handoffs, target = true, allow = true, workflows = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ghflow-')).replace(/\\/g, '/');
  made.push(root);
  const run = `${root}/run`;
  const memo = `${run}/memo`;
  const remote = `${root}/remote.git`;
  mkdirSync(`${run}/issues/.drafts`, { recursive: true });
  mkdirSync(memo, { recursive: true });
  git(memo, 'init', '-q', '-b', 'main');
  writeFileSync(`${memo}/a.txt`, 'a\n');
  writeFileSync(`${memo}/ok.test.mjs`, "import { test } from 'node:test';\ntest('ok', () => {});\n");
  git(memo, 'add', '-A');
  git(memo, 'commit', '-q', '-m', 'init');
  const issues = {};
  const tips = {};
  for (const d of handoffs) {
    mkdirSync(`${run}/handoffs/${d.h}`, { recursive: true });
    if (d.base) writeFileSync(`${run}/handoffs/${d.h}/dispatch.json`, JSON.stringify({ team: d.team ?? null, base: d.base, issueBases: {} }));
    for (const n of d.issues) {
      // d.chain[n] = m: 같은 하달의 앞 이슈 #m의 브랜치에서 시작하고 #m에 기댄다(run-11의 같은 하달 의존)
      const dep = d.chain?.[n];
      const start = dep ? `${d.h}/issue-${dep}` : d.base ? `${d.base}/issue-${handoffs.find((x) => x.h === d.base).issues[0]}` : 'main';
      git(memo, 'checkout', '-q', '-b', `${d.h}/issue-${n}`, start);
      writeFileSync(`${memo}/f${n}.txt`, `${n}\n`);
      git(memo, 'add', '-A');
      git(memo, 'commit', '-q', '-m', `이슈 #${n}`);
      tips[n] = git(memo, 'rev-parse', 'HEAD');
      issues[n] = { body: body(dep ? `#${dep}` : d.base ?`#${handoffs.find((x) => x.h === d.base).issues[0]}` : '없음'), labels: ['리뷰대기'], comments: allow ? allowedComments(n, tips[n]) : [] };
    }
    git(memo, 'checkout', '-q', '-b', `integration/${d.h}`, 'main');
    for (const n of d.issues) git(memo, 'merge', '-q', '--no-ff', `${d.h}/issue-${n}`, '-m', `통합: 이슈 #${n}`);
    git(memo, 'checkout', '-q', 'main');
  }
  git(root, 'clone', '-q', '--bare', memo, remote);
  // bare에는 main만 둔다(나머지는 push-branch가 올린다)
  for (const b of git(remote, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/').split('\n')) if (b && b !== 'main') git(remote, 'update-ref', '-d', `refs/heads/${b}`);
  const config = { designatedRepo: 'o/r', issuesClone: `${run}/issues`, targetProject: memo, projectName: 'memo', worktrees: `${run}/worktrees`, harnessDir: realHarness, runDir: run };
  if (target) Object.assign(config, { targetRepo: 'owner/app', targetRemote: remote });
  writeFileSync(`${run}/harness.json`, JSON.stringify(config));
  const stateFile = `${root}/gh-state.json`;
  writeFileSync(stateFile, JSON.stringify({ remote, designated: 'o/r', target: 'owner/app', issues, ci: {}, workflows, prs: [], runs: [], calls: [] }));
  const env = { ...process.env, HARNESS_RUN_DIR: run, HARNESS_GH_BIN: FAKE, FAKE_GH_STATE: stateFile, HARNESS_CI_WAIT_MS: '1500', HARNESS_CI_POLL_MS: '20', HARNESS_TRAIN_WAIT_MS: '1500', HARNESS_FOREGROUND: '1' };
  // run-reflect(merge-adapter)의 gh 호출은 env를 넘기지 않고 이 프로세스의 환경을 물려받는다
  process.env.FAKE_GH_STATE = stateFile;
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const patch = (fn) => { const s = state(); fn(s); writeFileSync(stateFile, JSON.stringify(s)); };
  return { root, run, memo, remote, env, tips, state, patch };
}

async function call(fn, argv, env) {
  const lines = [];
  const errs = [];
  const code = await fn(argv, env, { write: (l) => lines.push(l), writeErr: (l) => errs.push(l) });
  let json = null;
  try { json = JSON.parse(lines.at(-1)); } catch { /* JSON이 아닌 출력 */ }
  return { code, json, lines, errs };
}
const push = (f, branch) => call(pushMain, ['--branch', branch], f.env);
const train = (f, list) => call(trainMain, ['--handoffs', list], f.env);
const writes = (s) => s.calls.filter((c) => (c[0] === 'pr' && !['list', 'checks', 'view'].includes(c[1])) || (c[0] === 'workflow' && c[1] === 'run'));

test('push-branch 인자: 두 모양만 받고 main·train/*·다른 브랜치는 거부', () => {
  assert.deepEqual(pushArgs(['--branch', 'h3/issue-12']), { branch: 'h3/issue-12', handoff: 'h3', issue: 12, kind: 'issue' });
  assert.deepEqual(pushArgs(['--branch', 'integration/h3']), { branch: 'integration/h3', handoff: 'h3', issue: null, kind: 'handoff' });
  for (const b of ['main', 'train/20261122-1', 'feature/x', 'h0/issue-1', 'h1/issue-0', 'integration/h1/x', 'H1/issue-1', 'h1/issue-1:main', '+h1/issue-1']) {
    assert.throws(() => pushArgs(['--branch', b]), /두 모양|모양만/, b);
  }
  assert.throws(() => pushArgs(['--branch', 'h1/issue-1', '--force']), /사용법/);
});

test('S1: 이슈 둘(같은 팀) → 이슈 PR 2개(→ integration/h1), 하달 PR 1개(→ main), CI 통과. 하네스는 gh pr을 쓰지 않는다', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1, 2] }] });
  const mainBefore = git(f.remote, 'rev-parse', 'refs/heads/main');
  for (const n of [1, 2]) {
    const r = await push(f, `h1/issue-${n}`);
    assert.equal(r.code, 0, r.errs.join('\n'));
    assert.equal(r.json.ci, 'pass');
    assert.equal(r.json.sha, f.tips[n]);
    assert.match(r.json.pr.url, /\/pull\/\d+$/);
  }
  const r = await push(f, 'integration/h1');
  assert.equal(r.code, 0, r.errs.join('\n'));
  assert.deepEqual(r.json.issues, [1, 2]);
  const s = f.state();
  const prs = s.prs.filter((p) => p.openedBy === 'actions');
  assert.equal(prs.filter((p) => p.baseRefName === 'integration/h1').length, 2);
  assert.equal(prs.filter((p) => p.baseRefName === 'main').length, 1);
  assert.deepEqual(writes(s), [], '하네스는 PR을 만들거나 머지하지 않는다');
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), mainBefore, 'main은 그대로');
  assert.equal(gitTry(f.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/train/x'), null);
  // 다시 불러도 다시 올리지 않고 읽기만 한다
  const again = await push(f, 'integration/h1');
  assert.equal(again.json.pushed, 'already');
  assert.ok(existsSync(`${f.run}/handoffs/h1/ci.jsonl`));
});

test('S1 끝 → S7: 사용자가 트레인을 승인하지 않으면(run-train을 부르지 않음) 하달 PR은 열린 채, main 그대로', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }] });
  const mainBefore = git(f.remote, 'rev-parse', 'refs/heads/main');
  assert.equal((await push(f, 'h1/issue-1')).code, 0);
  assert.equal((await push(f, 'integration/h1')).code, 0);
  const s = f.state();
  assert.equal(s.prs.find((p) => p.headRefName === 'integration/h1').state, 'OPEN');
  assert.equal(s.calls.filter((c) => c[0] === 'workflow').length, 0);
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), mainBefore);
});

test('push-branch: 허용 판정이 없거나 해시가 다르면 아무것도 올리지 않는다(종료 코드 2)', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }], allow: false });
  const r = await push(f, 'h1/issue-1');
  assert.equal(r.code, 2);
  assert.match(r.errs.join('\n'), /허용한 리뷰어 판정이 없습니다/);
  assert.equal(gitTry(f.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/h1/issue-1'), null);
  assert.equal(gitTry(f.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/integration/h1'), null);
  f.patch((s) => { s.issues[1].comments = allowedComments(1, 'b'.repeat(40)); });
  assert.equal((await push(f, 'h1/issue-1')).code, 2);
  assert.equal((await push(f, 'integration/h1')).code, 2);
  assert.equal(gitTry(f.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/integration/h1'), null);
});

test('push-branch: 통합 브랜치에 이슈 밖 커밋이 있으면 거부, 원격이 빨리감기가 아니면 강제로 올리지 않는다', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }] });
  git(f.memo, 'checkout', '-q', 'integration/h1');
  writeFileSync(`${f.memo}/evil.txt`, 'x\n');
  git(f.memo, 'add', '-A');
  git(f.memo, 'commit', '-q', '-m', '몰래 넣은 커밋');
  git(f.memo, 'checkout', '-q', 'main');
  const r = await push(f, 'integration/h1');
  assert.equal(r.code, 2);
  assert.match(r.errs.join('\n'), /이슈 브랜치 밖의 커밋/);
  // 원격의 이슈 브랜치가 다른 커밋이면(빨리감기 아님) 실패하고 원격은 그대로
  const g2 = fixture({ handoffs: [{ h: 'h1', issues: [1] }] });
  git(g2.remote, 'update-ref', 'refs/heads/h1/issue-1', git(g2.remote, 'rev-parse', 'refs/heads/main'));
  git(g2.memo, 'branch', 'tmp-side', 'main');
  git(g2.memo, 'checkout', '-q', 'tmp-side');
  writeFileSync(`${g2.memo}/side.txt`, 's\n');
  git(g2.memo, 'add', '-A');
  git(g2.memo, 'commit', '-q', '-m', 'side');
  const side = git(g2.memo, 'rev-parse', 'HEAD');
  git(g2.memo, 'checkout', '-q', 'main');
  execFileSync('git', ['-C', g2.memo, 'push', '-q', g2.remote, `${side}:refs/heads/h1/issue-1`, '--force']);
  const r2 = await push(g2, 'h1/issue-1');
  assert.equal(r2.code, 2);
  assert.match(r2.errs.join('\n'), /강제로 올리지 않습니다/);
  assert.equal(git(g2.remote, 'rev-parse', 'refs/heads/h1/issue-1'), side);
});

test('push-branch: PR이 열리지 않거나 CI가 끝나지 않으면 기다림 한도에서 종료 코드 5', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }] });
  f.patch((s) => { s.noPr = ['h1/issue-1']; });
  const r = await push(f, 'h1/issue-1');
  assert.equal(r.code, 5);
  assert.equal(r.json.ci, 'timeout');
  f.patch((s) => { s.noPr = []; s.ci['h1/issue-1'] = 'pending'; });
  const r2 = await push(f, 'h1/issue-1');
  assert.equal(r2.code, 5);
  assert.equal(r2.json.pushed, 'already');
  assert.ok(r2.json.pr);
});

test('S4: 하달 PR CI 실패 → 관련 이슈를 미완료로 두고 CI 결과 댓글(종료 코드 1). 그 하달은 트레인에 못 들어간다', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1, 2] }] });
  for (const n of [1, 2]) assert.equal((await push(f, `h1/issue-${n}`)).code, 0);
  f.patch((s) => { s.ci['integration/h1'] = 'fail'; });
  const r = await push(f, 'integration/h1');
  assert.equal(r.code, 1);
  assert.equal(r.json.ci, 'fail');
  assert.deepEqual(r.json.failed, ['harness-ci / test']);
  const s = f.state();
  for (const n of [1, 2]) {
    assert.deepEqual(s.issues[n].labels, ['미완료']);
    assert.match(s.issues[n].comments.at(-1).body, /^## CI 결과: 실패/);
    assert.match(s.issues[n].comments.at(-1).body, /재작업 한도에 센다/);
  }
  // 미완료가 된 이슈는 허용으로 보지 않는다: 다시 올리기를 거부한다
  assert.equal((await push(f, 'integration/h1')).code, 2);
});

test('S3: 팀 둘(dev h1 → tester h2, --base h1). 트레인이 h1 → h2 순서로 쌓고 CI 한 번 뒤 main 빨리감기, 로컬 main도 따라간다', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1], team: 'dev' }, { h: 'h2', issues: [2], base: 'h1', team: 'tester' }] });
  for (const b of ['h1/issue-1', 'integration/h1', 'h2/issue-2', 'integration/h2']) assert.equal((await push(f, b)).code, 0, b);
  const before = git(f.remote, 'rev-parse', 'refs/heads/main');
  // 순서를 어기면 아무것도 시작하지 않는다
  const bad = await train(f, 'h2,h1');
  assert.equal(bad.code, 2);
  assert.match(bad.errs.join('\n'), /h1부터/);
  assert.equal(f.state().calls.filter((c) => c[0] === 'workflow').length, 0);
  const r = await train(f, 'h1,h2');
  assert.equal(r.code, 0, r.errs.join('\n'));
  assert.equal(r.json.ci, 'pass');
  assert.deepEqual(r.json.merged, ['h1', 'h2']);
  const after = git(f.remote, 'rev-parse', 'refs/heads/main');
  assert.notEqual(after, before);
  assert.equal(git(f.remote, 'merge-base', '--is-ancestor', before, after), '', '빨리감기');
  assert.equal(git(f.remote, 'rev-list', '--count', `${before}..${after}`) !== '0', true);
  assert.deepEqual(git(f.remote, 'log', '--format=%s', '--first-parent', `${before}..${after}`).split('\n'), ['트레인: h2', '트레인: h1']);
  assert.equal(r.json.localMain, '따라감');
  assert.equal(git(f.memo, 'rev-parse', 'refs/heads/main'), after);
  const s = f.state();
  assert.deepEqual(s.issues[1].labels, ['반영됨']);
  assert.deepEqual(s.issues[2].labels, ['반영됨']);
  assert.ok(s.prs.filter((p) => p.baseRefName === 'main').every((p) => p.state === 'MERGED'));
  // 트레인으로 들어간 이슈도 "main에 있음"으로 본다(의존 이슈가 대기로 남지 않게)
  const { git: g } = openGit({});
  assert.deepEqual([...provenIssuesOnMain(g, { memo: f.memo, run: f.run })].sort(), [1, 2]);
  assert.deepEqual([...provenIssuesOnMain(g, { memo: f.memo })], []);
  // 하네스가 쓴 gh는 workflow run 하나뿐
  assert.deepEqual(writes(s).map((c) => c.slice(0, 3)), [['workflow', 'run', 'harness-train.yml']]);
});

test('S6: 트레인 CI 실패(뒤 하달이 깨뜨림) → main 그대로, 실패 하달과 통과한 앞부분을 보고. 스스로 머지하지 않는다', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }, { h: 'h2', issues: [2] }] });
  for (const b of ['h1/issue-1', 'integration/h1', 'h2/issue-2', 'integration/h2']) assert.equal((await push(f, b)).code, 0, b);
  f.patch((s) => { s.trainFail = ['h2']; });
  const before = git(f.remote, 'rev-parse', 'refs/heads/main');
  const localBefore = git(f.memo, 'rev-parse', 'refs/heads/main');
  const r = await train(f, 'h1,h2');
  assert.equal(r.code, 1);
  assert.equal(r.json.ci, 'fail');
  assert.equal(r.json.failedHandoff, 'h2');
  assert.deepEqual(r.json.passingPrefix, ['h1']);
  assert.equal(r.json.main, '그대로');
  assert.match(r.json.reason, /사용자에게 묻는다/);
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), before);
  assert.equal(git(f.memo, 'rev-parse', 'refs/heads/main'), localBefore);
  const s = f.state();
  assert.ok(s.prs.filter((p) => p.baseRefName === 'main').every((p) => p.state === 'OPEN'));
  assert.deepEqual(s.issues[1].labels, ['리뷰대기']);
  assert.equal(writes(s).length, 1, '트레인 시작 한 번 말고는 쓰지 않는다');
});

test('run-train: 하달 PR이 없으면 시작하지 않고, 결과 줄이 없으면 실패로 본다', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }] });
  const r = await train(f, 'h1');
  assert.equal(r.code, 2);
  assert.match(r.errs.join('\n'), /push-branch --branch integration\/h1/);
  assert.equal(f.state().calls.filter((c) => c[0] === 'workflow').length, 0);
  assert.equal((await push(f, 'h1/issue-1')).code, 0);
  assert.equal((await push(f, 'integration/h1')).code, 0);
  f.patch((s) => { s.noResultLine = true; });
  const before = git(f.remote, 'rev-parse', 'refs/heads/main');
  const r2 = await train(f, 'h1');
  assert.equal(r2.code, 2);
  assert.match(r2.errs.join('\n'), /결과 줄을 남기지 않았습니다/);
  assert.notEqual(git(f.remote, 'rev-parse', 'refs/heads/main'), before, '가짜 Actions는 머지했지만');
  assert.notEqual(git(f.memo, 'rev-parse', 'refs/heads/main'), git(f.remote, 'rev-parse', 'refs/heads/main'), '결과를 못 읽으면 로컬 main은 따라가지 않는다');
  const q = fixture({ handoffs: [{ h: 'h1', issues: [1] }] });
  assert.equal((await push(q, 'h1/issue-1')).code, 0);
  assert.equal((await push(q, 'integration/h1')).code, 0);
  q.patch((s) => { s.runStaysQueued = true; });
  const r3 = await train(q, 'h1');
  assert.equal(r3.code, 5);
  assert.equal(r3.json.ci, 'timeout');
});

test('S8: 대상 원격이 없으면 push-branch는 CI 없음(4), run-train은 로컬 흐름(run-reflect)으로 반영하고 "CI 없음"', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }], target: false });
  const p = await push(f, 'h1/issue-1');
  assert.equal(p.code, 4);
  assert.equal(p.json.ci, 'none');
  assert.match(p.json.reason, /로컬 흐름/);
  const before = git(f.memo, 'rev-parse', 'refs/heads/main');
  const r = await train(f, 'h1');
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.equal(r.json.ci, 'none');
  assert.equal(r.json.flow, 'local');
  assert.match(r.json.reason, /CI 없음/);
  assert.match(r.json.handoffs[0].lines[0], /^#1 \| 반영됨 \|/);
  assert.notEqual(git(f.memo, 'rev-parse', 'refs/heads/main'), before);
  assert.equal(f.state().calls.filter((c) => c[0] === 'workflow' || c[0] === 'pr').length, 0);
});

test('S8: 원격은 있어도 워크플로가 main에 없으면 로컬 흐름', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }], workflows: false });
  assert.equal((await push(f, 'h1/issue-1')).code, 4);
  const before = git(f.remote, 'rev-parse', 'refs/heads/main');
  const r = await train(f, 'h1');
  assert.equal(r.json.flow, 'local');
  assert.equal(gitTry(f.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/h1/issue-1'), null, '원격에는 아무것도 올리지 않았다');
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/main'), before);
});

test('트레인 결과 줄 읽기: 표지 뒤 JSON, 모르는 하달·모양이 틀린 값은 버린다', () => {
  const ok = `x\ty\t2026 HARNESS_TRAIN_RESULT {"result":"failed","train":"train/20261122-3","merged":[],"failedHandoff":"h2","passingPrefix":["h1"],"mainAfter":null}`;
  assert.deepEqual(parseTrainResult(ok, ['h1', 'h2']), { result: 'failed', train: 'train/20261122-3', merged: [], failedHandoff: 'h2', passingPrefix: ['h1'], mainAfter: null });
  assert.equal(parseTrainResult(ok, ['h1']), null);
  assert.equal(parseTrainResult(ok.replace('train/20261122-3', 'main'), ['h1', 'h2']), null);
  assert.equal(parseTrainResult('nothing', ['h1']), null);
});

// 결정 8-35 이전에는 섞인 하달을 종료 코드 2로 거부했다. 이제 판정 전 이슈가 섞인 때만 거부하고, 반려된 이슈만 빼고 다시 만든다(아래 시험들).
test('섞인 하달(허용 하나, 판정 전 하나): 판정 전 이슈는 빼지 않고 통합 브랜치를 거부(종료 코드 2), 아무것도 바꾸지 않는다', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1, 2] }] });
  f.patch((s) => { s.issues[2].comments = []; });
  const integBefore = git(f.memo, 'rev-parse', 'refs/heads/integration/h1');
  assert.equal((await push(f, 'h1/issue-1')).code, 0);
  assert.equal((await push(f, 'h1/issue-2')).code, 2);
  const r = await push(f, 'integration/h1');
  assert.equal(r.code, 2);
  assert.match(r.errs.join('\n'), /판정 전인 #2의 커밋이 있습니다/);
  assert.equal(f.state().prs.filter((p) => p.baseRefName === 'main').length, 0);
  assert.equal(git(f.memo, 'rev-parse', 'refs/heads/integration/h1'), integBefore, '로컬 통합 브랜치도 그대로');
  assert.equal(existsSync(`${f.run}/handoffs/h1/rebuilt.json`), false);
});

const hasFile = (f, sha, name) => gitTry(f.remote, 'cat-file', '-e', `${sha}:${name}`) !== null;

test('8-35 섞인 하달: 허용 #1, CI로 미완료된 #2(독립) → 통합 브랜치를 #1만으로 다시 만들어 하달 PR, #2는 반려. 재작업 h2 → 옛 이슈 PR 닫힘·브랜치 지움, 트레인 뒤 정리', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1, 2] }] });
  const oldInteg = git(f.memo, 'rev-parse', 'refs/heads/integration/h1');
  assert.equal((await push(f, 'h1/issue-1')).code, 0);
  f.patch((s) => { s.ci['h1/issue-2'] = 'fail'; });
  assert.equal((await push(f, 'h1/issue-2')).code, 1, '이슈 PR CI 실패 → #2 미완료');
  assert.deepEqual(f.state().issues[2].labels, ['미완료']);
  const r = await push(f, 'integration/h1');
  assert.equal(r.code, 0, r.errs.join('\n'));
  assert.equal(r.json.ci, 'pass');
  assert.deepEqual(r.json.issues, [1]);
  assert.equal(r.json.rebuilt.from, oldInteg);
  assert.deepEqual(r.json.rebuilt.kept, [1]);
  assert.deepEqual(r.json.rebuilt.returned, [{ issue: 2, reason: '상태가 미완료' }]);
  assert.deepEqual(r.json.rebuilt.held, []);
  const newInteg = git(f.memo, 'rev-parse', 'refs/heads/integration/h1');
  assert.notEqual(newInteg, oldInteg);
  assert.equal(r.json.sha, newInteg);
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/integration/h1'), newInteg);
  assert.ok(hasFile(f, newInteg, 'f1.txt') && !hasFile(f, newInteg, 'f2.txt'), '다시 만든 통합 브랜치에는 #1만');
  assert.deepEqual(git(f.memo, 'log', '--format=%s', '--first-parent', `main..${newInteg}`).split('\n'), ['통합: 이슈 #1']);
  const s = f.state();
  const hp = s.prs.find((p) => p.headRefName === 'integration/h1' && p.baseRefName === 'main');
  assert.equal(hp.state, 'OPEN');
  assert.equal(hp.headRefOid, newInteg);
  assert.deepEqual(s.issues[2].labels, ['미완료'], '반려된 이슈는 미완료 그대로(재작업은 새 하달)');
  assert.match(s.issues[2].comments.at(-1).body, /^## 통합 브랜치 다시 만듦 \(결정 8-35\)[\s\S]*반려\(상태가 미완료\)[\s\S]*새 하달/);
  assert.deepEqual(writes(s), [], '하네스는 PR을 쓰지 않는다');
  // 다시 불러도 다시 만들지 않는다(같은 끝, 읽기만)
  const again = await push(f, 'integration/h1');
  assert.equal(again.code, 0);
  assert.equal(again.json.pushed, 'already');
  assert.equal(again.json.rebuilt.to, newInteg);
  assert.equal(git(f.memo, 'rev-parse', 'refs/heads/integration/h1'), newInteg);
  assert.equal(JSON.parse(readFileSync(`${f.run}/handoffs/h1/rebuilt.json`, 'utf8')).length, 1);

  // 재작업: 새 하달 h2의 #2(독립이라 main에서 시작). 허용되면 이슈 PR이 열리고 옛 h1/issue-2 이슈 PR은 닫히고 원격 브랜치는 지워진다.
  mkdirSync(`${f.run}/handoffs/h2`, { recursive: true });
  git(f.memo, 'checkout', '-q', '-b', 'h2/issue-2', 'main');
  writeFileSync(`${f.memo}/f2.txt`, '2 again\n');
  git(f.memo, 'add', '-A');
  git(f.memo, 'commit', '-q', '-m', '이슈 #2 재작업');
  const t2 = git(f.memo, 'rev-parse', 'HEAD');
  git(f.memo, 'checkout', '-q', '-b', 'integration/h2', 'main');
  git(f.memo, 'merge', '-q', '--no-ff', 'h2/issue-2', '-m', '통합: 이슈 #2');
  git(f.memo, 'checkout', '-q', 'main');
  f.patch((st) => { st.ci['h1/issue-2'] = 'pass'; st.issues[2].comments.push(...allowedComments(2, t2)); st.issues[2].labels = ['리뷰대기']; });
  assert.equal((await push(f, 'h2/issue-2')).code, 0);
  const s2 = f.state();
  const old = s2.prs.find((p) => p.headRefName === 'h1/issue-2');
  assert.equal(old.state, 'CLOSED');
  assert.equal(old.closeComment, 'h2에서 다시 함');
  assert.ok(s2.deleted.includes('h1/issue-2'));
  assert.equal(gitTry(f.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/h1/issue-2'), null);
  assert.ok(gitTry(f.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/integration/h1'), '하달 PR이 열린 integration/h1은 남는다');
  assert.ok(gitTry(f.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/h1/issue-1'));
  assert.equal(s2.prs.find((p) => p.headRefName === 'h2/issue-2').state, 'OPEN');
  assert.equal((await push(f, 'integration/h2')).code, 0);

  // 트레인(h1 → h2): 통과하면 원격의 하달 브랜치·트레인 브랜치를 지우고, 로컬 하달 이름 공간도 치운다. main은 지우지 않는다.
  const tr = await train(f, 'h1,h2');
  assert.equal(tr.code, 0, tr.errs.join('\n'));
  assert.deepEqual(tr.json.merged, ['h1', 'h2']);
  assert.deepEqual(tr.json.cleanup, { h1: '정리함', h2: '정리함' });
  const remoteLeft = git(f.remote, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/').split('\n').filter(Boolean);
  assert.deepEqual(remoteLeft, ['main']);
  const localLeft = git(f.memo, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/').split('\n').filter(Boolean);
  assert.deepEqual(localLeft, ['main']);
  const s3 = f.state();
  assert.deepEqual(s3.issues[1].labels, ['반영됨']);
  assert.deepEqual(s3.issues[2].labels, ['반영됨']);
  assert.ok(s3.prs.every((p) => p.state !== 'OPEN'), '열린 PR이 남지 않는다');
  assert.deepEqual(s3.refusedDeletes ?? [], []);
  assert.ok(existsSync(`${f.run}/handoffs/h1/train.json`), '기록은 남는다');
  const { git: g } = openGit({});
  assert.deepEqual([...provenIssuesOnMain(g, { memo: f.memo, run: f.run })].sort(), [1, 2]);
});

test('8-35 순서가 바뀌어도: 재작업 하달 h2가 먼저 돌고(#2 리뷰대기·허용) 나서 integration/h1을 올리면 #2는 반려(h2에서 재작업 중)로 빼고 라벨·댓글은 건드리지 않는다', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1, 2] }] });
  assert.equal((await push(f, 'h1/issue-1')).code, 0);
  f.patch((s) => { s.ci['h1/issue-2'] = 'fail'; });
  assert.equal((await push(f, 'h1/issue-2')).code, 1);
  // 이슈 PR CI 실패 뒤 바로 재작업 하달 h2: 합치기가 #2를 리뷰대기로 두고, 리뷰어가 아직 판정하기 전(마지막 판정은 옛 허용)
  mkdirSync(`${f.run}/handoffs/h2`, { recursive: true });
  git(f.memo, 'checkout', '-q', '-b', 'h2/issue-2', 'main');
  writeFileSync(`${f.memo}/f2.txt`, '2 again\n');
  git(f.memo, 'add', '-A');
  git(f.memo, 'commit', '-q', '-m', '이슈 #2 재작업');
  const t2 = git(f.memo, 'rev-parse', 'HEAD');
  git(f.memo, 'checkout', '-q', 'main');
  f.patch((s) => { s.issues[2].labels = ['리뷰대기']; s.issues[2].comments.push(rc(2, `## 결과 보고서 (이슈 #2)\n\n커밋 해시: ${t2}\n`)); });
  const before = f.state().issues[2].comments.length;
  const r = await push(f, 'integration/h1');
  assert.equal(r.code, 0, r.errs.join('\n'));
  assert.deepEqual(r.json.rebuilt.kept, [1]);
  assert.deepEqual(r.json.rebuilt.returned, [{ issue: 2, reason: 'h2에서 재작업 중' }]);
  assert.deepEqual(f.state().issues[2].labels, ['리뷰대기'], '뒤 하달의 라벨을 건드리지 않는다');
  assert.equal(f.state().issues[2].comments.length, before, '댓글도 남기지 않는다');
  // h2가 허용되면 그대로 올라간다
  f.patch((s) => { s.issues[2].comments.push(rc(2, `## 리뷰어 판정: 허용\n\n허용된 커밋: ${t2}\n이유`)); s.ci['h1/issue-2'] = 'pass'; });
  assert.equal((await push(f, 'h2/issue-2')).code, 0);
  assert.equal(f.state().prs.find((p) => p.headRefName === 'h1/issue-2').state, 'CLOSED');
  const again = await push(f, 'integration/h1');
  assert.equal(again.code, 0, again.errs.join('\n'));
  assert.equal(again.json.pushed, 'already');
});

test('8-35 섞인 하달: 허용 #3이 거부된 #2에 기대면(#2 브랜치에서 시작) #3도 빼고 대기, 통합 브랜치는 #1만', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1, 2, 3], chain: { 3: 2 } }] });
  f.patch((s) => { s.issues[2].comments = rejectedComments(2, f.tips[2]); s.issues[2].labels = ['미완료']; });
  for (const b of ['h1/issue-1', 'h1/issue-3']) assert.equal((await push(f, b)).code, 0, b);
  const r = await push(f, 'integration/h1');
  assert.equal(r.code, 0, r.errs.join('\n'));
  assert.deepEqual(r.json.issues, [1]);
  assert.deepEqual(r.json.rebuilt.kept, [1]);
  assert.deepEqual(r.json.rebuilt.returned.map((x) => x.issue), [2]);
  assert.deepEqual(r.json.rebuilt.held.map((x) => x.issue), [3]);
  assert.match(r.json.rebuilt.held[0].reason, /#2/);
  assert.ok(hasFile(f, r.json.sha, 'f1.txt') && !hasFile(f, r.json.sha, 'f2.txt') && !hasFile(f, r.json.sha, 'f3.txt'));
  const s = f.state();
  assert.deepEqual(s.issues[3].labels, ['대기'], '반려된 이슈와 함께 새 하달로');
  assert.match(s.issues[3].comments.at(-1).body, /^## 통합 브랜치 다시 만듦[\s\S]*함께 새 하달/);
  // 거부 판정만 있고 라벨이 아직 없어도 반려로 본다(미완료로 둔다)
  const g2 = fixture({ handoffs: [{ h: 'h1', issues: [1, 2] }] });
  g2.patch((s2) => { s2.issues[2].comments = rejectedComments(2, g2.tips[2]); });
  const r2 = await push(g2, 'integration/h1');
  assert.equal(r2.code, 0, r2.errs.join('\n'));
  assert.deepEqual(r2.json.rebuilt.returned, [{ issue: 2, reason: '리뷰어 거부' }]);
  assert.deepEqual(g2.state().issues[2].labels, ['미완료']);
  // 모두 반려되면 남길 것이 없어 거부(종료 코드 2), 아무것도 올리지 않는다
  const g3 = fixture({ handoffs: [{ h: 'h1', issues: [1] }] });
  g3.patch((s3) => { s3.issues[1].labels = ['미완료']; });
  const r3 = await push(g3, 'integration/h1');
  assert.equal(r3.code, 2);
  assert.match(r3.errs.join('\n'), /남길 허용된 이슈가 없습니다/);
  assert.equal(gitTry(g3.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/integration/h1'), null);
});

test('8-35 강제 push: 이미 올린 통합 브랜치를 다시 만들면 --force-with-lease(옛 끝)로만 덮고, 원격이 예상 밖으로 움직였으면 거부', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1, 2] }] });
  for (const b of ['h1/issue-1', 'h1/issue-2', 'integration/h1']) assert.equal((await push(f, b)).code, 0, b);
  const oldInteg = git(f.remote, 'rev-parse', 'refs/heads/integration/h1');
  f.patch((s) => { s.issues[2].labels = ['미완료']; });
  const calls = [];
  const remoteGit = (cwd, args) => { calls.push(args); return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); };
  const lines = [];
  const errs = [];
  const code = await pushMain(['--branch', 'integration/h1'], f.env, { write: (l) => lines.push(l), writeErr: (l) => errs.push(l), remoteGit });
  assert.equal(code, 0, errs.join('\n'));
  const j = JSON.parse(lines.at(-1));
  assert.equal(j.pushed, 'forced');
  assert.equal(j.rebuilt.from, oldInteg);
  assert.equal(git(f.remote, 'rev-parse', 'refs/heads/integration/h1'), j.sha);
  const pushes = calls.filter((a) => a[0] === 'push');
  assert.deepEqual(pushes, [['push', '--porcelain', `--force-with-lease=refs/heads/integration/h1:${oldInteg}`, f.remote, 'refs/heads/integration/h1:refs/heads/integration/h1']]);
  const hp = f.state().prs.find((p) => p.headRefName === 'integration/h1');
  assert.equal(hp.state, 'OPEN', '하달 PR은 닫지 않고 새 끝으로 갱신');
  assert.equal(hp.headRefOid, j.sha);

  // 원격이 예상 밖으로 움직였으면(기록에 없는 끝) 강제로 덮지 않는다
  const g2 = fixture({ handoffs: [{ h: 'h1', issues: [1, 2] }] });
  for (const b of ['h1/issue-1', 'h1/issue-2', 'integration/h1']) assert.equal((await push(g2, b)).code, 0, b);
  git(g2.memo, 'branch', 'tmp-side', 'integration/h1');
  git(g2.memo, 'checkout', '-q', 'tmp-side');
  writeFileSync(`${g2.memo}/side.txt`, 's\n');
  git(g2.memo, 'add', '-A');
  git(g2.memo, 'commit', '-q', '-m', 'side');
  const side = git(g2.memo, 'rev-parse', 'HEAD');
  git(g2.memo, 'checkout', '-q', 'main');
  execFileSync('git', ['-C', g2.memo, 'push', '-q', g2.remote, `${side}:refs/heads/integration/h1`]);
  g2.patch((s) => { s.issues[2].labels = ['미완료']; });
  const r2 = await push(g2, 'integration/h1');
  assert.equal(r2.code, 2);
  assert.match(r2.errs.join('\n'), /강제로 올리지 않습니다/);
  assert.equal(git(g2.remote, 'rev-parse', 'refs/heads/integration/h1'), side, '원격은 그대로');
  const r3 = await push(g2, 'integration/h1');
  assert.equal(r3.code, 2, '다시 불러도 덮지 않는다');
  assert.equal(git(g2.remote, 'rev-parse', 'refs/heads/integration/h1'), side);
});

test('8-35 강제 push 인자는 integration/h<N> 모양과 40자리 예상 끝일 때만 만든다', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(forcePushArgs('o', 'integration/h3', sha), ['push', '--porcelain', `--force-with-lease=refs/heads/integration/h3:${sha}`, 'o', 'refs/heads/integration/h3:refs/heads/integration/h3']);
  for (const b of ['main', 'h1/issue-1', 'train/20261122-1', 'feature/x', 'integration/h0', 'integration/h1/x', 'refs/heads/integration/h1', '+integration/h1', undefined]) {
    assert.throws(() => forcePushArgs('o', b, sha), /integration\/h<N>만/, String(b));
  }
  for (const e of ['', 'abc', null, 'A'.repeat(40)]) assert.throws(() => forcePushArgs('o', 'integration/h1', e), /예상 원격 끝/);
});

test('8-35 rebuilt.json: 로컬 끝이 마지막 다시 만든 결과일 때만 옛 끝들을 덮을 수 있다', () => {
  const root = mkdtempSync(join(tmpdir(), 'rebuilt-')).replace(/\\/g, '/');
  made.push(root);
  mkdirSync(`${root}/handoffs/h1`, { recursive: true });
  const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(40));
  assert.deepEqual(leaseable(root, 'h1', b), []);
  writeFileSync(rebuildFile(root, 'h1'), JSON.stringify([{ from: a, to: b }]));
  assert.deepEqual(leaseable(root, 'h1', b), [a]);
  assert.deepEqual(leaseable(root, 'h1', c), [], '기록에 없는 끝이면 덮지 않는다');
  writeFileSync(rebuildFile(root, 'h1'), JSON.stringify([{ from: a, to: b }, { from: b, to: c }]));
  assert.deepEqual(leaseable(root, 'h1', c).sort(), [a, b]);
  assert.deepEqual(leaseable(root, 'h1', b), []);
  writeFileSync(rebuildFile(root, 'h1'), 'not json');
  assert.deepEqual(leaseable(root, 'h1', c), []);
});

test('8-35 트레인 실패 길: 원격 브랜치·PR을 지우지 않고 로컬도 치우지 않는다', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }] });
  for (const b of ['h1/issue-1', 'integration/h1']) assert.equal((await push(f, b)).code, 0, b);
  f.patch((s) => { s.trainFail = ['h1']; });
  const before = git(f.remote, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/');
  const r = await train(f, 'h1');
  assert.equal(r.code, 1);
  assert.equal(r.json.cleanup, undefined);
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/'), before);
  assert.deepEqual(f.state().deleted ?? [], []);
  assert.ok(gitTry(f.memo, 'rev-parse', '--verify', '--quiet', 'refs/heads/h1/issue-1'));
});

test('8-35 코디네이터 규칙: 섞인 하달은 묻지 않고 반려(재작업 하달, 필요하면 --base), 다시 만든 통합 브랜치는 상태 표에', () => {
  const flow = readFileSync(`${realHarness}/coordinator/skills/coordinator-issue-flow/SKILL.md`, 'utf8');
  assert.match(flow, /8-35/);
  assert.match(flow, /반려/);
  assert.match(flow, /rebuilt/);
  assert.match(flow, /--base h<N>/);
  assert.doesNotMatch(flow, /허용된 이슈만 `run-reflect`/, '옛 "결정할 것" 선택지는 없다');
  const exc = readFileSync(`${realHarness}/coordinator/skills/coordinator-exceptions/SKILL.md`, 'utf8');
  assert.match(exc, /섞인 하달/);
  const rec = readFileSync(`${realHarness}/coordinator/skills/coordinator-records/SKILL.md`, 'utf8');
  assert.match(rec, /반려/);
  const agent = readFileSync(`${realHarness}/coordinator/AGENT.md`, 'utf8');
  assert.match(agent, /8-35/);
  assert.doesNotMatch(agent, /하달의 이슈가 모두 허용되면 `push-branch\.mjs --branch integration/);
});

test('run-train: 트레인이 통과하면 반영 안 된 이슈가 있어도 종료 코드 0(1은 트레인 실패에만)', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }] });
  git(f.memo, 'checkout', '-q', '-b', 'h1/issue-3', 'main');
  writeFileSync(`${f.memo}/f3.txt`, '3\n');
  git(f.memo, 'add', '-A');
  git(f.memo, 'commit', '-q', '-m', '합치기에서 빠진 이슈');
  git(f.memo, 'checkout', '-q', 'main');
  f.patch((s) => { s.issues[3] = { body: body(), labels: ['미완료'], comments: [] }; });
  for (const b of ['h1/issue-1', 'integration/h1']) assert.equal((await push(f, b)).code, 0, b);
  const r = await train(f, 'h1');
  assert.equal(r.code, 0, r.errs.join('\n'));
  assert.equal(r.json.ci, 'pass');
  assert.deepEqual(r.json.rows.map((x) => [x.number, x.state]), [[1, '반영됨'], [3, '보류']]);
});

test('S4 보탬: CI 결과 댓글은 판정받은 보고서 수(재작업 한도)를 바꾸지 않는다. 재작업 보고서가 판정받으면 그때 센다', T, async () => {
  const { reviewedReports } = await import('../operator/run-operator.mjs');
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }] });
  f.patch((s) => { s.ci['h1/issue-1'] = 'fail'; });
  assert.equal((await push(f, 'h1/issue-1')).code, 1);
  const cs = f.state().issues[1].comments;
  assert.equal(reviewedReports(cs), 1);
  assert.equal(reviewedReports([...cs, ...allowedComments(1, 'c'.repeat(40))]), 2);
});

test('명령줄: 훅이 허용하는 모양 그대로 node로 돌린다(인자 오류 2, 가짜 gh로 정상 0)', T, async () => {
  const f = fixture({ handoffs: [{ h: 'h1', issues: [1] }] });
  const cli = (script, args) => spawnSync(process.execPath, [`${realHarness}/operator/${script}`, ...args], { encoding: 'utf8', env: f.env, cwd: f.run });
  const bad = cli('push-branch.mjs', ['--branch', 'main']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /모양만 받습니다/);
  const ok = cli('push-branch.mjs', ['--branch', 'h1/issue-1']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout.trim().split('\n').pop()).ci, 'pass');
  assert.equal(cli('push-branch.mjs', ['--branch', 'integration/h1']).status, 0);
  assert.equal(cli('run-train.mjs', ['--handoffs', 'h1;h2']).status, 2);
  const t = cli('run-train.mjs', ['--handoffs', 'h1']);
  assert.equal(t.status, 0, t.stderr);
  assert.equal(JSON.parse(t.stdout.trim().split('\n').pop()).ci, 'pass');
});
