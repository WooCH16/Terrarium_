import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync, spawn as nodeSpawnForTest } from 'node:child_process';
import { pruneDeadPids, loadModeDocs, sessionSettings, sessionCwd, launchSession, cleanupHandoff, removeHandoffWorktrees, pruneReflectedHandoffs } from '../operator/launch.mjs';
import { main, makeGhDeps } from '../operator/run-operator.mjs';
import { ConfigError } from '../operator/config.mjs';
import { STATES, formatLine, exitCode } from '../operator/report.mjs';

const here = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const realHarness = dirname(here);
const made = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)).replace(/\\/g, '/'); made.push(d); return d; };
const ENV_KEYS = ['HARNESS_CLAUDE_BIN', 'HARNESS_GH_BIN', 'FAKE_DIR', 'FAKE_CODES', 'FAKE_HANG', 'FAKE_MEMO', 'FAKE_RUN'];
const envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) { if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k]; }
});
after(() => {
  for (const d of made) {
    for (const h of ['h1', 'h2']) rmSync(sessionCwd(d, h), { recursive: true, force: true });
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 잠긴 파일은 무시 */ }
  }
});
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe', encoding: 'utf8' });

// 가짜 claude: 호출 내용을 FAKE_DIR/calls.jsonl에 적고, FAKE_CODES의 n번째 코드로 끝난다.
const FAKE = `
import { readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const dir = process.env.FAKE_DIR;
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;
const log = dir + '/calls.jsonl';
const n = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\\n').length + 1 : 1;
const rec = { n, args: process.argv.slice(2), cwd: process.cwd().replace(/\\\\/g, '/'), stdin, requireRole: process.env.HARNESS_REQUIRE_ROLE, runDir: process.env.HARNESS_RUN_DIR, author: process.env.GIT_AUTHOR_NAME };
if (process.env.FAKE_MEMO) {
  rec.branches = execFileSync('git', ['-C', process.env.FAKE_MEMO, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], { encoding: 'utf8' }).split('\\n').filter(Boolean);
  const wt = process.env.FAKE_RUN + '/worktrees';
  rec.worktrees = existsSync(wt) ? readdirSync(wt) : [];
}
appendFileSync(log, JSON.stringify(rec) + '\\n');
if (process.env.FAKE_ADD_WT && process.env.FAKE_MEMO) {
  // 워커가 하듯 이 하달의 이슈 워크트리를 만든다(하달 번호는 세션 머리말에서).
  const h = /\\b(h[1-9][0-9]*)\\b/.exec(stdin)[1];
  execFileSync('git', ['-C', process.env.FAKE_MEMO, 'worktree', 'add', '-q', '-b', h + '/issue-7', process.env.FAKE_RUN + '/worktrees/' + h + '/issue-7', 'main']);
}
console.log('CHILD-OUTPUT-NOISE');
console.error('CHILD-ERR-NOISE');
if (process.env.FAKE_GRANDCHILD) {
  const { spawn } = await import('node:child_process');
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  appendFileSync(process.env.FAKE_GRANDCHILD, String(g.pid));
  g.unref();
}
if (process.env.FAKE_HANG === '1') setInterval(() => {}, 1000);
else {
  const codes = JSON.parse(process.env.FAKE_CODES || '[0]');
  process.exit(codes[Math.min(n - 1, codes.length - 1)]);
}
`;

function fakeEnv({ codes = [0], hang = false, memo, run } = {}) {
  const dir = tmp('op-fake-');
  writeFileSync(`${dir}/claude.mjs`, FAKE);
  process.env.HARNESS_CLAUDE_BIN = `${dir}/claude.mjs`;
  process.env.FAKE_DIR = dir;
  process.env.FAKE_CODES = JSON.stringify(codes);
  process.env.FAKE_HANG = hang ? '1' : '0';
  if (memo) process.env.FAKE_MEMO = memo; else delete process.env.FAKE_MEMO;
  if (run) process.env.FAKE_RUN = run; else delete process.env.FAKE_RUN;
  return { dir, calls: () => (existsSync(`${dir}/calls.jsonl`) ? readFileSync(`${dir}/calls.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}

// 임시 실행 폴더 + 임시 harnessDir(문서 스텁, 실제 operator.config.json 복사) + memo 저장소.
function makeRun({ withConfig = true } = {}) {
  const run = tmp('op-run-');
  const harnessDir = tmp('op-harness-');
  mkdirSync(`${harnessDir}/operator`, { recursive: true });
  writeFileSync(`${harnessDir}/operator/AGENT.md`, 'AGENT-DOC');
  mkdirSync(`${harnessDir}/operator/skills/operator-work`, { recursive: true });
  writeFileSync(`${harnessDir}/operator/skills/operator-work/SKILL.md`, 'WORK-DOC');
  if (withConfig) copyFileSync(`${realHarness}/operator/operator.config.json`, `${harnessDir}/operator/operator.config.json`);
  const memo = `${run}/memo`;
  mkdirSync(memo, { recursive: true });
  git(memo, 'init', '-q', '-b', 'main');
  git(memo, 'config', 'user.name', 't');
  git(memo, 'config', 'user.email', 't@t');
  writeFileSync(`${memo}/a.txt`, 'a');
  git(memo, 'add', '-A');
  git(memo, 'commit', '-q', '-m', 'init');
  const config = { designatedRepo: 'o/r', issuesClone: `${run}/issues`, targetProject: memo, worktrees: `${run}/worktrees`, harnessDir, runDir: run };
  writeFileSync(`${run}/harness.json`, JSON.stringify(config));
  return { run, harnessDir, memo, config };
}

function addHandoffNamespace({ run, memo }, h) {
  git(memo, 'worktree', 'add', '-q', '-b', `${h}/issue-7`, `${run}/worktrees/${h}/issue-7`);
  git(memo, 'worktree', 'add', '-q', '-b', `integration/${h}`, `${run}/worktrees/${h}/integration`);
}

function stubs(states = {}) {
  const calls = { set: [], fetch: [] };
  return {
    calls,
    fetchIssue: async (n) => { calls.fetch.push(n); return { state: states[n] ?? '리뷰대기', url: `https://example.test/issues/${n}` }; },
    setState: async (n, s) => { calls.set.push([n, s]); },
  };
}

async function runMain(argv, ctx, deps = {}) {
  const lines = [];
  const code = await main(argv, { HARNESS_RUN_DIR: ctx.run }, { write: (l) => lines.push(l), timeoutMs: 20000, ...deps });
  return { code, lines };
}

// ---------- loadModeDocs ----------
test('loadModeDocs는 AGENT.md와 모드 문서를 이어 붙인다', () => {
  const { harnessDir } = makeRun();
  const text = loadModeDocs('work', harnessDir);
  assert.ok(text.includes('AGENT-DOC') && text.includes('WORK-DOC'));
  assert.ok(text.indexOf('AGENT-DOC') < text.indexOf('WORK-DOC'));
});

test('loadModeDocs는 문서가 없으면 ConfigError(한국어 사유)', () => {
  const { harnessDir } = makeRun();
  assert.throws(() => loadModeDocs('research', harnessDir), (e) => e instanceof ConfigError && /문서/.test(e.message));
  assert.throws(() => loadModeDocs('bogus', harnessDir), (e) => e instanceof ConfigError && /모드/.test(e.message));
});

// ---------- sessionSettings ----------
test('sessionSettings(work): 훅 명령, env, 슬래시 경로', () => {
  const s = sessionSettings({ mode: 'work', handoff: 'h1', run: 'C:\\x\\run', harnessDir: 'C:\\x\\harness' });
  const cmd = s.hooks.PreToolUse[0].hooks[0].command;
  assert.equal(s.hooks.PreToolUse[0].matcher, '*');
  assert.equal(cmd.split('--role operator-work').length, 2);
  assert.equal(cmd.split('--handoff h1').length, 2);
  assert.ok(!cmd.includes('--issue'));
  assert.ok(!cmd.includes('\\'));
  assert.ok(cmd.includes('"C:/x/harness/guard.mjs"') && cmd.includes('"C:/x/run/harness.json"'));
  assert.equal(s.env.HARNESS_REQUIRE_ROLE, '1');
  assert.equal(s.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1');
  assert.equal(s.env.GIT_AUTHOR_NAME, 'terrarium-operator');
  assert.equal(s.env.GIT_COMMITTER_EMAIL, 'operator@localhost');
  assert.ok(!('permissions' in s));
});

test('sessionSettings(research): --issue가 한 번 들어간다', () => {
  const s = sessionSettings({ mode: 'research', handoff: 'h3', run: '/r', harnessDir: '/h', issue: 9 });
  const cmd = s.hooks.PreToolUse[0].hooks[0].command;
  assert.ok(cmd.includes('--role operator-research --handoff h3 --issue 9'));
});

test('sessionSettings는 잘못된 모드·하달을 한국어 사유로 거부한다', () => {
  assert.throws(() => sessionSettings({ mode: 'x', handoff: 'h1', run: '/r', harnessDir: '/h' }), /모드/);
  assert.throws(() => sessionSettings({ mode: 'work', handoff: 'h0', run: '/r', harnessDir: '/h' }), /하달/);
});

test('sessionSettings 훅 명령은 실제 guard.mjs의 역할 인자 검사를 통과한다', () => {
  const ctx = makeRun();
  for (const [mode, issue] of [['work'], ['research', 9], ['reflect']]) {
    const s = sessionSettings({ mode, handoff: 'h1', run: ctx.run, harnessDir: realHarness, issue });
    const cmd = s.hooks.PreToolUse[0].hooks[0].command;
    // 실제 셸이 훅 명령 문자열을 그대로 해석한다(따옴표 문제를 잡는다).
    const r = spawnSync(cmd, {
      shell: true,
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: `${ctx.run}/issues/a.md` } }),
      encoding: 'utf8',
      env: { ...process.env, ...s.env },
    });
    assert.ok([0, 2].includes(r.status), `${mode}: ${r.status} ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /알 수 없는 역할|두 번 이상|--handoff가 없거나|--role 없이|HARNESS_REQUIRE_ROLE=1인|가드 오류/, `${mode}: ${r.stderr}`);
  }
});

test('C1: 부모 환경에 HARNESS_RUN_DIR이 없어도 세션 설정 env로 세션 폴더의 스크립트가 harness.json을 찾는다', async () => {
  const ctx = makeRun();
  mkdirSync(`${ctx.run}/handoffs/h1`, { recursive: true });
  const fake = fakeEnv();
  const saved = process.env.HARNESS_RUN_DIR;
  delete process.env.HARNESS_RUN_DIR;
  try {
    await launchSession({ mode: 'work', handoff: 'h1', run: ctx.run, harnessDir: ctx.harnessDir, issues: [7], prompt: 'p', timeoutMs: 20000 });
  } finally { if (saved !== undefined) process.env.HARNESS_RUN_DIR = saved; }
  const [c] = fake.calls();
  assert.equal(c.runDir, ctx.run);
  const settings = JSON.parse(readFileSync(`${ctx.run}/handoffs/h1/settings-work.json`, 'utf8'));
  assert.equal(settings.env.HARNESS_RUN_DIR, ctx.run);
  // 세션이 보는 환경(설정 env만, 부모의 HARNESS_RUN_DIR 없음)과 세션 cwd에서 스크립트를 실행한다.
  const base = { ...process.env, ...settings.env };
  // 성공한 세션의 폴더는 M3에 따라 지워지므로, 같은 경로를 다시 만들어 그 안에서 실행한다.
  mkdirSync(c.cwd, { recursive: true });
  for (const script of ['run-worker.mjs --handoff h1 --issue 7 --model claude', 'merge-adapter-enqueue.mjs --handoff h1']) {
    const [name, ...args] = script.split(' ');
    const r = spawnSync(process.execPath, [`${realHarness}/operator/${name}`, ...args], { cwd: c.cwd, env: base, encoding: 'utf8' });
    assert.doesNotMatch(r.stdout + r.stderr, /harness\.json이 없습니다/, name);
  }
});

// ---------- sessionCwd ----------
test('sessionCwd는 실행 폴더 밖, 하달별 폴더', () => {
  const a = sessionCwd('C:\\r\\run', 'h1');
  assert.equal(a, sessionCwd('C:/r/run/', 'h1'));
  assert.notEqual(a, sessionCwd('C:/r/run', 'h2'));
  assert.notEqual(a, sessionCwd('C:/r/other', 'h1'));
  assert.match(a, /\/terrarium-sessions\/[0-9a-f]{8}-h1$/);
  assert.ok(!a.startsWith('C:/r/run'));
});

// ---------- launchSession ----------
test('launchSession: stdin 프롬프트, 인자, cwd, env, session.json', async () => {
  const ctx = makeRun();
  mkdirSync(`${ctx.run}/handoffs/h1`, { recursive: true });
  const fake = fakeEnv();
  const r = await launchSession({ mode: 'work', handoff: 'h1', run: ctx.run, harnessDir: ctx.harnessDir, issues: [7], prompt: 'PROMPT-BODY', timeoutMs: 20000 });
  assert.deepEqual(r, { code: 0, timedOut: false });
  const [c] = fake.calls();
  assert.equal(c.stdin, 'PROMPT-BODY');
  assert.ok(!c.args.includes('PROMPT-BODY'));
  assert.equal(c.args[0], '-p');
  const settingsFile = c.args[c.args.indexOf('--settings') + 1];
  assert.equal(settingsFile, `${ctx.run}/handoffs/h1/settings-work.json`);
  assert.ok(existsSync(settingsFile));
  assert.deepEqual(c.args.slice(c.args.indexOf('--setting-sources'), c.args.indexOf('--setting-sources') + 2), ['--setting-sources', 'user']);
  assert.equal(c.args[c.args.indexOf('--allowedTools') + 1], 'Bash Write Edit Read Glob Grep');
  assert.ok(c.args.includes('--no-session-persistence'));
  assert.equal(c.cwd.toLowerCase(), sessionCwd(ctx.run, 'h1').toLowerCase());
  assert.equal(c.requireRole, '1');
  assert.equal(c.author, 'terrarium-operator');
  const sj = JSON.parse(readFileSync(`${ctx.run}/handoffs/h1/session.json`, 'utf8'));
  assert.ok(Number.isInteger(sj.pid) && sj.pid > 0);
  assert.ok(!Number.isNaN(Date.parse(sj.startedAt)));
  assert.equal(sj.mode, 'work');
  assert.deepEqual(sj.issues, [7]);
});

test('M3: 성공한 세션의 세션 폴더는 지우고, 실패한 세션의 폴더는 진단용으로 남긴다', async () => {
  const ctx = makeRun();
  mkdirSync(`${ctx.run}/handoffs/h1`, { recursive: true });
  fakeEnv({ codes: [0] });
  await launchSession({ mode: 'work', handoff: 'h1', run: ctx.run, harnessDir: ctx.harnessDir, prompt: 'p', timeoutMs: 20000 });
  assert.equal(existsSync(sessionCwd(ctx.run, 'h1')), false);
  fakeEnv({ codes: [1] });
  await launchSession({ mode: 'work', handoff: 'h1', run: ctx.run, harnessDir: ctx.harnessDir, prompt: 'p', timeoutMs: 20000 });
  assert.equal(existsSync(sessionCwd(ctx.run, 'h1')), true);
});

test('launchSession: research 모드는 Edit 없이 웹 읽기까지 도구를 준다', async () => {
  const ctx = makeRun();
  mkdirSync(`${ctx.run}/handoffs/h2`, { recursive: true });
  const fake = fakeEnv();
  await launchSession({ mode: 'research', handoff: 'h2', run: ctx.run, harnessDir: ctx.harnessDir, issue: 9, prompt: 'p', timeoutMs: 20000 });
  const [c] = fake.calls();
  assert.equal(c.args[c.args.indexOf('--allowedTools') + 1], 'Bash Write Read Glob Grep WebFetch WebSearch Agent');
  assert.ok(readFileSync(`${ctx.run}/handoffs/h2/settings-research.json`, 'utf8').includes('--issue 9'));
});

test('launchSession: 종료 코드를 그대로 돌려준다', async () => {
  const ctx = makeRun();
  mkdirSync(`${ctx.run}/handoffs/h1`, { recursive: true });
  fakeEnv({ codes: [1] });
  const r = await launchSession({ mode: 'work', handoff: 'h1', run: ctx.run, harnessDir: ctx.harnessDir, prompt: 'p', timeoutMs: 20000 });
  assert.deepEqual(r, { code: 1, timedOut: false });
});

test('launchSession: 시간 초과면 자식을 죽이고 timedOut', async () => {
  const ctx = makeRun();
  mkdirSync(`${ctx.run}/handoffs/h1`, { recursive: true });
  fakeEnv({ hang: true });
  const r = await launchSession({ mode: 'work', handoff: 'h1', run: ctx.run, harnessDir: ctx.harnessDir, prompt: 'p', timeoutMs: 600 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
});

// ---------- cleanupHandoff ----------
test('cleanupHandoff는 해당 하달의 이름 공간만 지운다', () => {
  const ctx = makeRun();
  for (const h of ['h1', 'h2', 'h10']) addHandoffNamespace(ctx, h);
  cleanupHandoff({ handoff: 'h1', run: ctx.run, memo: ctx.memo });
  assert.ok(!existsSync(`${ctx.run}/worktrees/h1`));
  for (const h of ['h2', 'h10']) {
    assert.ok(existsSync(`${ctx.run}/worktrees/${h}/issue-7`), h);
    assert.ok(existsSync(`${ctx.run}/worktrees/${h}/integration`), h);
  }
  const branches = git(ctx.memo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();
  assert.deepEqual(branches, ['h10/issue-7', 'h2/issue-7', 'integration/h10', 'integration/h2', 'main']);
  assert.ok(!git(ctx.memo, 'worktree', 'list').includes('/worktrees/h1/'));
  assert.equal(git(ctx.memo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
});

test('cleanupHandoff는 잘못된 하달 이름을 거부하고 아무것도 지우지 않는다', () => {
  const ctx = makeRun();
  addHandoffNamespace(ctx, 'h1');
  for (const bad of ['main', 'h0', '../h1', 'h1/..', 'H1', '']) {
    assert.throws(() => cleanupHandoff({ handoff: bad, run: ctx.run, memo: ctx.memo }), /하달/, bad);
  }
  assert.ok(existsSync(`${ctx.run}/worktrees/h1/issue-7`));
});

test('cleanupHandoff는 이름 공간이 없어도 던지지 않는다', () => {
  const ctx = makeRun();
  cleanupHandoff({ handoff: 'h5', run: ctx.run, memo: ctx.memo });
});

// ---------- 워크트리 쌓임 (2026-11-24: 끝난 하달의 워크트리가 정리되지 않아 실행 폴더마다 수십 개가 남았다) ----------
const branchesOf = (memo) => git(memo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();

test('removeHandoffWorktrees: 그 하달의 작업 폴더만 지우고 브랜치는 남긴다(리뷰·반영이 브랜치를 쓴다)', () => {
  const ctx = makeRun();
  for (const h of ['h1', 'h2']) addHandoffNamespace(ctx, h);
  const removed = removeHandoffWorktrees({ handoff: 'h1', run: ctx.run, memo: ctx.memo });
  assert.deepEqual(removed.sort(), ['integration', 'issue-7']);
  assert.ok(!existsSync(`${ctx.run}/worktrees/h1`));
  assert.ok(existsSync(`${ctx.run}/worktrees/h2/issue-7`));
  assert.deepEqual(branchesOf(ctx.memo), ['h1/issue-7', 'h2/issue-7', 'integration/h1', 'integration/h2', 'main']);
  assert.ok(!git(ctx.memo, 'worktree', 'list').includes('/worktrees/h1/'), '워크트리 목록에서도 빠진다');
  assert.deepEqual(removeHandoffWorktrees({ handoff: 'h5', run: ctx.run, memo: ctx.memo }), [], '없으면 조용히');
  for (const bad of ['main', 'h0', '../h1', 'H1', '']) assert.throws(() => removeHandoffWorktrees({ handoff: bad, run: ctx.run, memo: ctx.memo }), /하달/, bad);
});

test('pruneReflectedHandoffs: 이슈가 모두 반영된 하달만 브랜치·폴더를 지운다(옛 시도 포함), 반영 안 된 이슈가 있거나 도는 하달은 남긴다', () => {
  const ctx = makeRun();
  addHandoffNamespace(ctx, 'h1'); // h1/issue-7: 거부돼 다시 보낸 옛 시도
  addHandoffNamespace(ctx, 'h2'); // h2/issue-7: 반영된 시도
  git(ctx.memo, 'branch', 'h3/issue-8', 'main'); // 반영 안 된 이슈
  git(ctx.memo, 'branch', 'h4/issue-7', 'main'); // 도는 하달
  git(ctx.memo, 'branch', 'h5/issue-7', 'main');
  git(ctx.memo, 'branch', 'h5/issue-9', 'main'); // 7은 반영됐지만 9는 아니다
  const r = pruneReflectedHandoffs({ run: ctx.run, memo: ctx.memo, proven: new Set([7]), isRunning: (h) => h === 'h4' });
  assert.deepEqual(r.cleaned, ['h1', 'h2']);
  assert.deepEqual(branchesOf(ctx.memo), ['h3/issue-8', 'h4/issue-7', 'h5/issue-7', 'h5/issue-9', 'main']);
  assert.ok(!existsSync(`${ctx.run}/worktrees/h1`) && !existsSync(`${ctx.run}/worktrees/h2`));
  assert.deepEqual(JSON.parse(readFileSync(`${ctx.run}/handoffs/h2/pruned.json`, 'utf8')).issues, [7], '정리 기록을 남긴다');
  assert.equal(existsSync(`${ctx.run}/handoffs/h3/pruned.json`), false);
  assert.deepEqual(pruneReflectedHandoffs({ run: ctx.run, memo: ctx.memo, proven: new Set(), isRunning: () => false }).cleaned, [], '반영된 것이 없으면 아무것도');
});

// ---------- gh 배선 ----------
test('makeGhDeps.fetchIssue: 단일 상태 라벨과 마지막 결과 보고서 댓글 URL', async () => {
  const seen = [];
  const exec = (bin, args) => {
    seen.push([bin, ...args]);
    return JSON.stringify({
      url: 'https://x/issues/7',
      labels: [{ name: 'bug' }, { name: '리뷰대기' }],
      comments: [
        { body: '## 결과 보고서\n1', url: 'https://x/issues/7#c1' },
        { body: '잡담', url: 'https://x/issues/7#c2' },
        { body: '## 결과 보고서\n2', url: 'https://x/issues/7#c3' },
        { body: '다시 잡담', url: 'https://x/issues/7#c4' },
      ],
    });
  };
  const gh = makeGhDeps('o/r', exec);
  assert.deepEqual(await gh.fetchIssue(7), { state: '리뷰대기', url: 'https://x/issues/7#c3' });
  assert.deepEqual(seen[0], ['gh', 'issue', 'view', '7', '--repo', 'o/r', '--json', 'labels,comments,url']);
});

test('makeGhDeps.fetchIssue: 보고서 댓글이 없으면 이슈 URL', async () => {
  const gh = makeGhDeps('o/r', () => JSON.stringify({ url: 'https://x/issues/7', labels: [{ name: '진행중' }], comments: [] }));
  assert.deepEqual(await gh.fetchIssue(7), { state: '진행중', url: 'https://x/issues/7' });
});

test('makeGhDeps.fetchIssue: 상태 라벨이 없으면 "라벨 없음", 둘 이상이면 한국어 사유로 던진다', async () => {
  const none = makeGhDeps('o/r', () => JSON.stringify({ url: 'u', labels: [{ name: 'bug' }], comments: [] }));
  assert.deepEqual(await none.fetchIssue(7), { state: '라벨 없음', url: 'u' });
  const two = makeGhDeps('o/r', () => JSON.stringify({ url: 'u', labels: [{ name: '진행중' }, { name: '막힘' }], comments: [] }));
  await assert.rejects(() => two.fetchIssue(7), /상태 라벨/);
});

test('makeGhDeps.ensureLabels: 상태 라벨 9개와 취소 라벨을 gh label create --force로 만든다(멱등)', async () => {
  const seen = [];
  await makeGhDeps('o/r', (bin, args) => { seen.push([bin, ...args]); return ''; }).ensureLabels();
  assert.equal(seen.length, 10);
  assert.deepEqual(seen.map((c) => c[3]).sort(), [...STATES, '취소'].sort());
  for (const c of seen) {
    assert.deepEqual(c.slice(0, 3), ['gh', 'label', 'create']);
    assert.ok(c.includes('--force') && c.includes('--repo') && c[c.indexOf('--repo') + 1] === 'o/r');
  }
});

test('run-operator: 세션을 띄우기 전에 상태 라벨을 보장한다', async () => {
  const ctx = makeRun();
  const fake = fakeEnv();
  const order = [];
  const s = stubs();
  s.ensureLabels = async () => { order.push(['labels', fake.calls().length]); };
  const { code } = await runMain(['--issues', '7'], ctx, s);
  assert.equal(code, 0);
  assert.deepEqual(order, [['labels', 0]]);
});

test('run-operator: 상태 라벨이 없는 이슈는 세션 전에 진행중을 붙인다', async () => {
  const ctx = makeRun();
  fakeEnv();
  const s = stubs({ 7: '라벨 없음', 8: '리뷰대기' });
  s.ensureLabels = async () => {};
  const { code } = await runMain(['--issues', '7,8'], ctx, s);
  assert.equal(code, 0);
  assert.deepEqual(s.calls.set, [[7, '진행중']]);
});

test('formatLine: 라벨 없음 상태도 보고 줄이 되고 종료 코드는 0', () => {
  assert.equal(formatLine({ number: 9, state: '라벨 없음', url: 'https://x/9' }), '#9 | 라벨 없음 | https://x/9');
  assert.equal(exitCode([{ number: 9, state: '라벨 없음', url: 'u' }]), 0);
});

test('makeGhDeps.setState: 다른 상태 라벨을 빼고 보류를 붙인다', async () => {
  const seen = [];
  const exec = (bin, args) => {
    seen.push(args);
    return JSON.stringify({ url: 'u', labels: [{ name: 'bug' }, { name: '진행중' }], comments: [] });
  };
  await makeGhDeps('o/r', exec).setState(7, '보류');
  assert.deepEqual(seen[1], ['issue', 'edit', '7', '--repo', 'o/r', '--add-label', '보류', '--remove-label', '진행중']);
});

// ---------- run-operator main ----------
test('run-operator: 이슈마다 보고 줄 하나, 자식 출력은 새지 않는다', async () => {
  const ctx = makeRun();
  const fake = fakeEnv();
  const s = stubs({ 7: '리뷰대기', 8: '허용됨' });
  const { code, lines } = await runMain(['--issues', '7,8'], ctx, s);
  assert.equal(code, 0);
  assert.deepEqual(lines.join('\n').split('\n'), ['#7 | 리뷰대기 | https://example.test/issues/7', '#8 | 허용됨 | https://example.test/issues/8']);
  assert.ok(!lines.join('').includes('CHILD'));
  assert.ok(existsSync(`${ctx.run}/handoffs/h1/session.json`));
  const [c] = fake.calls();
  assert.ok(c.stdin.includes('AGENT-DOC') && c.stdin.includes('WORK-DOC'));
  assert.ok(c.stdin.includes('h1') && c.stdin.includes('7') && c.stdin.includes('8'));
});

test('run-operator: 세션이 끝나면 그 하달의 워커 작업 폴더를 지우고 브랜치는 남긴다', async () => {
  const ctx = makeRun();
  addHandoffNamespace(ctx, 'h2'); // 다른 하달은 건드리지 않는다
  fakeEnv({ memo: ctx.memo, run: ctx.run });
  process.env.FAKE_ADD_WT = '1';
  try {
    const { code } = await runMain(['--issues', '7'], ctx, stubs());
    assert.equal(code, 0);
  } finally { delete process.env.FAKE_ADD_WT; }
  assert.ok(!existsSync(`${ctx.run}/worktrees/h1`), 'h1 작업 폴더 없음');
  assert.ok(existsSync(`${ctx.run}/worktrees/h2/issue-7`));
  assert.ok(branchesOf(ctx.memo).includes('h1/issue-7'), '브랜치는 남는다');
  assert.ok(!git(ctx.memo, 'worktree', 'list').includes('/worktrees/h1/'));
});

test('run-operator: 막힘이 있으면 종료 코드 1', async () => {
  const ctx = makeRun();
  fakeEnv();
  const { code, lines } = await runMain(['--issues', '7'], ctx, stubs({ 7: '막힘' }));
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
});

test('run-operator --handoff: 같은 번호를 이어받는다', async () => {
  const ctx = makeRun();
  const fake = fakeEnv();
  mkdirSync(`${ctx.run}/handoffs/h1`, { recursive: true });
  const { code } = await runMain(['--issues', '7', '--handoff', 'h1'], ctx, stubs());
  assert.equal(code, 0);
  assert.deepEqual(readdirSync(`${ctx.run}/handoffs`), ['h1']);
  assert.ok(fake.calls()[0].args.some((a) => a.endsWith('/handoffs/h1/settings-work.json')));
});

test('I3: 이미 이슈 브랜치·통합 브랜치가 있는 하달은 --force-restart 없이는 다시 시작하지 않는다(정리가 허용된 작업을 지우므로)', async () => {
  const ctx = makeRun();
  addHandoffNamespace(ctx, 'h1');
  mkdirSync(`${ctx.run}/handoffs/h1`, { recursive: true });
  const fake = fakeEnv();
  const { code, lines } = await runMain(['--issues', '7', '--handoff', 'h1'], ctx, stubs());
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /--force-restart/);
  assert.equal(fake.calls().length, 0);
  const branches = git(ctx.memo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();
  assert.deepEqual(branches, ['h1/issue-7', 'integration/h1', 'main']);
  assert.ok(existsSync(`${ctx.run}/worktrees/h1/issue-7`));
});

test('I3: 브랜치가 없는 하달은 플래그 없이 이어받고, --force-restart는 --handoff 없이 쓸 수 없다', async () => {
  const ctx = makeRun();
  mkdirSync(`${ctx.run}/handoffs/h1`, { recursive: true });
  fakeEnv();
  assert.equal((await runMain(['--issues', '7', '--handoff', 'h1'], ctx, stubs())).code, 0);
  assert.equal((await runMain(['--issues', '7', '--force-restart'], ctx, stubs())).code, 2);
});

test('run-operator --handoff: 없는 하달이면 종료 코드 2', async () => {
  const ctx = makeRun();
  fakeEnv();
  const { code, lines } = await runMain(['--issues', '7', '--handoff', 'h4'], ctx, stubs());
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /하달/);
});

test('run-operator: 실패하면 그 하달의 이름 공간만 정리하고 1회 다시 시작한다', async () => {
  const ctx = makeRun();
  for (const h of ['h1', 'h2', 'h10']) addHandoffNamespace(ctx, h);
  mkdirSync(`${ctx.run}/handoffs/h1`, { recursive: true });
  const fake = fakeEnv({ codes: [1, 0], memo: ctx.memo, run: ctx.run });
  const { code, lines } = await runMain(['--issues', '7', '--handoff', 'h1', '--force-restart'], ctx, stubs());
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  const [first, second] = fake.calls();
  assert.ok(first.branches.includes('h1/issue-7') && first.worktrees.includes('h1'));
  assert.ok(!second.branches.includes('h1/issue-7') && !second.branches.includes('integration/h1'));
  assert.ok(!second.worktrees.includes('h1'));
  for (const keep of ['main', 'h2/issue-7', 'integration/h2', 'h10/issue-7', 'integration/h10']) assert.ok(second.branches.includes(keep), keep);
  assert.ok(second.worktrees.includes('h2') && second.worktrees.includes('h10'));
});

test('run-operator: 두 번 실패하면 보류로 표시하고 종료 코드 1', async () => {
  const ctx = makeRun();
  const fake = fakeEnv({ codes: [1, 1] });
  const s = stubs({ 7: '진행중', 8: '진행중' });
  let cleanups = 0;
  const cleanupHandoffCounted = (o) => { cleanups++; cleanupHandoff(o); };
  const { code, lines } = await runMain(['--issues', '7,8'], ctx, { ...s, cleanupHandoff: cleanupHandoffCounted });
  assert.equal(code, 1);
  assert.equal(cleanups, 1);
  assert.equal(fake.calls().length, 2);
  assert.deepEqual(s.calls.set, [[7, '보류'], [8, '보류']]);
  assert.deepEqual(lines.join('\n').split('\n'), ['#7 | 보류 | https://example.test/issues/7', '#8 | 보류 | https://example.test/issues/8']);
});

test('run-operator: 시간 초과도 실패로 본다', async () => {
  const ctx = makeRun();
  fakeEnv({ hang: true });
  const s = stubs();
  const { code } = await runMain(['--issues', '7'], ctx, { ...s, timeoutMs: 500 });
  assert.equal(code, 1);
  assert.deepEqual(s.calls.set, [[7, '보류']]);
});

test('run-operator: 설정 파일이 없으면 종료 코드 2와 한 줄 사유', async () => {
  const ctx = makeRun({ withConfig: false });
  fakeEnv();
  const { code, lines } = await runMain(['--issues', '7'], ctx, stubs());
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /설정/);
  assert.ok(!lines[0].includes('\n'));
});

test('run-operator: 모드 문서가 없으면 종료 코드 2', async () => {
  const ctx = makeRun();
  fakeEnv();
  rmSync(`${ctx.harnessDir}/operator/skills/operator-work/SKILL.md`);
  const { code, lines } = await runMain(['--issues', '7'], ctx, stubs());
  assert.equal(code, 2);
  assert.match(lines[0], /문서/);
});

test('run-operator: harness.json이 없으면 종료 코드 2', async () => {
  const run = tmp('op-empty-');
  const { code, lines } = await runMain(['--issues', '7'], { run }, stubs());
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /harness\.json/);
});

test('run-operator: 잘못된 인자는 종료 코드 2와 한 줄', async () => {
  const ctx = makeRun();
  fakeEnv();
  const bad = [
    [], ['--issues'], ['--issues', 'a,b'], ['--issues', '7,'], ['--issues', '7', '--issues', '8'],
    ['--issues', '7', '--handoff', 'h0'], ['--issues', '7', '--handoff', 'h1', '--handoff', 'h2'], ['--issues', '7', '--bogus'],
  ];
  for (const argv of bad) {
    const { code, lines } = await runMain(argv, ctx, stubs());
    assert.equal(code, 2, JSON.stringify(argv));
    assert.equal(lines.length, 1, JSON.stringify(argv));
    assert.match(lines[0], /인자|--issues|--handoff/, JSON.stringify(argv));
  }
  assert.equal(existsSync(`${ctx.run}/handoffs`), false);
});

test('run-operator: 상태 라벨 오류는 종료 코드 2와 한 줄(줄바꿈 없음)', async () => {
  const ctx = makeRun();
  fakeEnv();
  const s = stubs();
  s.fetchIssue = async () => { throw new Error('이슈 #7의 상태 라벨이\n정확히 하나가 아닙니다'); };
  const { code, lines } = await runMain(['--issues', '7'], ctx, s);
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('\n'));
  assert.match(lines[0], /상태 라벨/);
});

test('run-operator 스크립트: 실제 프로세스로 설정 오류를 한 줄·종료 코드 2로 낸다', () => {
  const ctx = makeRun({ withConfig: false });
  const r = spawnSync(process.execPath, [`${realHarness}/operator/run-operator.mjs`, '--issues', '7'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_RUN_DIR: ctx.run },
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.match(r.stdout, /설정/);
});

// ---------- 수정 라운드 1 ----------
const FAKE_GH = `
const a = process.argv.slice(2);
if (a[0] === 'issue' && a[1] === 'view') {
  console.log(JSON.stringify({ url: 'https://example.test/issues/' + a[2], labels: [{ name: '리뷰대기' }], comments: [] }));
}
`;

function junctionSetup() {
  const outside = tmp('op-outside-');
  mkdirSync(`${outside}/precious`, { recursive: true });
  writeFileSync(`${outside}/precious/data.txt`, 'keep');
  return outside;
}

test('cleanupHandoff: worktrees/<h>가 junction이면 아무것도 지우지 않고 거부한다', () => {
  const ctx = makeRun();
  const outside = junctionSetup();
  mkdirSync(`${ctx.run}/worktrees`, { recursive: true });
  symlinkSync(outside, `${ctx.run}/worktrees/h1`, 'junction');
  assert.throws(() => cleanupHandoff({ handoff: 'h1', run: ctx.run, memo: ctx.memo }), /링크/);
  assert.equal(readFileSync(`${outside}/precious/data.txt`, 'utf8'), 'keep');
});

test('cleanupHandoff: 하위 항목이 junction이면 아무것도 지우지 않고 거부한다', () => {
  const ctx = makeRun();
  const outside = junctionSetup();
  addHandoffNamespace(ctx, 'h1');
  symlinkSync(outside, `${ctx.run}/worktrees/h1/x`, 'junction');
  assert.throws(() => cleanupHandoff({ handoff: 'h1', run: ctx.run, memo: ctx.memo }), /링크/);
  assert.equal(readFileSync(`${outside}/precious/data.txt`, 'utf8'), 'keep');
  assert.ok(existsSync(`${ctx.run}/worktrees/h1/issue-7`));
  assert.ok(git(ctx.memo, 'for-each-ref', 'refs/heads/h1/').includes('h1/issue-7'));
});

test('cleanupHandoff: <run>/worktrees 자체가 junction이면 아무것도 지우지 않고 거부한다', () => {
  const ctx = makeRun();
  const outside = tmp('op-outside2-');
  mkdirSync(`${outside}/h1/issue-7`, { recursive: true });
  writeFileSync(`${outside}/h1/issue-7/precious.txt`, 'keep');
  symlinkSync(outside, `${ctx.run}/worktrees`, 'junction');
  assert.throws(() => cleanupHandoff({ handoff: 'h1', run: ctx.run, memo: ctx.memo }), /링크|거부/);
  assert.equal(readFileSync(`${outside}/h1/issue-7/precious.txt`, 'utf8'), 'keep');
});

test('launchSession: 띄운 뒤 error 이벤트는 spawnError가 아니다(pid가 있으면 시간 초과로 센다)', async () => {
  const ctx = makeRun();
  fakeEnv({ hang: true });
  const spawn = (...a) => {
    const c = nodeSpawnForTest(...a);
    setTimeout(() => c.emit('error', new Error('kill EPERM')), 50);
    return c;
  };
  const r = await launchSession({ mode: 'work', handoff: 'h1', run: ctx.run, harnessDir: ctx.harnessDir, prompt: 'p', timeoutMs: 600 }, { spawn });
  assert.equal(r.spawnError, undefined);
  assert.equal(r.timedOut, true);
});

test('launchSession: 시간 초과 시 손자 프로세스까지 끝낸다(윈도우)', { skip: process.platform !== 'win32' }, async () => {
  const ctx = makeRun();
  const f = fakeEnv({ hang: true });
  const pidFile = `${f.dir}/grandchild.pid`;
  process.env.FAKE_GRANDCHILD = pidFile;
  try {
    const r = await launchSession({ mode: 'work', handoff: 'h1', run: ctx.run, harnessDir: ctx.harnessDir, prompt: 'p', timeoutMs: 2500 });
    assert.equal(r.timedOut, true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    await new Promise((res) => setTimeout(res, 500));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) { try { process.kill(pid); } catch { /* 이미 끝남 */ } }
    assert.equal(alive, false, '손자 프로세스가 살아 있다');
  } finally { delete process.env.FAKE_GRANDCHILD; }
});

test('cleanupHandoff: 실행 폴더나 worktrees가 없어도 브랜치는 정리한다', () => {
  const ctx = makeRun();
  addHandoffNamespace(ctx, 'h1');
  rmSync(`${ctx.run}/worktrees`, { recursive: true, force: true });
  cleanupHandoff({ handoff: 'h1', run: ctx.run, memo: ctx.memo });
  assert.ok(!git(ctx.memo, 'for-each-ref', 'refs/heads/h1/').includes('h1/'));
  // 실행 폴더 자체가 없어도 던지지 않고 브랜치만 정리한다.
  git(ctx.memo, 'branch', 'h2/issue-7');
  git(ctx.memo, 'branch', 'integration/h2');
  const missing = `${ctx.run}-missing`;
  cleanupHandoff({ handoff: 'h2', run: missing, memo: ctx.memo });
  assert.ok(!git(ctx.memo, 'for-each-ref', 'refs/heads/h2/').includes('h2/'));
});

test('cleanupHandoff: memo가 git 저장소가 아니면 조용히 넘어가지 않고 던진다', () => {
  const ctx = makeRun();
  const notRepo = tmp('op-notrepo-');
  assert.throws(() => cleanupHandoff({ handoff: 'h1', run: ctx.run, memo: notRepo }), /저장소|정리/);
});

test('sessionSettings: 셸에서 위험한 문자가 든 경로·큰 이슈 번호를 거부한다', () => {
  for (const bad of ['/a"b', '/a$b', '/a`b', '/a%b', '/a\nb']) {
    assert.throws(() => sessionSettings({ mode: 'work', handoff: 'h1', run: bad, harnessDir: '/h' }), (e) => e instanceof ConfigError && /경로/.test(e.message), bad);
    assert.throws(() => sessionSettings({ mode: 'work', handoff: 'h1', run: '/r', harnessDir: bad }), (e) => e instanceof ConfigError && /경로/.test(e.message), bad);
  }
  assert.throws(() => sessionSettings({ mode: 'research', handoff: 'h1', run: '/r', harnessDir: '/h', issue: 1234567890 }), /이슈/);
});

test('launchSession: 실행 파일을 띄울 수 없으면 spawnError로 구분한다', async () => {
  const ctx = makeRun();
  mkdirSync(`${ctx.run}/handoffs/h1`, { recursive: true });
  process.env.HARNESS_CLAUDE_BIN = `${tmp('op-nobin-')}/no-such-claude`;
  const r = await launchSession({ mode: 'work', handoff: 'h1', run: ctx.run, harnessDir: ctx.harnessDir, prompt: 'p', timeoutMs: 20000 });
  assert.equal(r.code, -1);
  assert.equal(r.timedOut, false);
  assert.match(r.spawnError, /ENOENT/);
});

test('run-operator: 실행 파일 오류는 정리·재시작·보류 없이 종료 코드 2와 HARNESS_CLAUDE_BIN 안내', async () => {
  const ctx = makeRun();
  fakeEnv();
  process.env.HARNESS_CLAUDE_BIN = `${tmp('op-nobin-')}/no-such-claude`;
  const s = stubs();
  let cleanups = 0;
  const { code, lines } = await runMain(['--issues', '7'], ctx, { ...s, cleanupHandoff: () => { cleanups++; } });
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /HARNESS_CLAUDE_BIN/);
  assert.match(lines[0], /실행 파일/);
  assert.equal(cleanups, 0);
  assert.deepEqual(s.calls.set, []);
});

test('run-operator: 정리가 실패하면 재시작 없이 종료 코드 2와 한 줄, 보류 표시 없음', async () => {
  const ctx = makeRun();
  const fake = fakeEnv({ codes: [1, 0] });
  const s = stubs();
  const { code, lines } = await runMain(['--issues', '7'], ctx, { ...s, cleanupHandoff: () => { throw new Error('정리 실패: 남은 폴더가 있습니다'); } });
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /정리 실패/);
  assert.equal(fake.calls().length, 1);
  assert.deepEqual(s.calls.set, []);
});

test('run-operator: 오류 문장의 제어 문자(ESC, BEL, 백스페이스)를 지운다', async () => {
  const ctx = makeRun();
  fakeEnv();
  const s = stubs();
  s.fetchIssue = async () => { throw new Error('이슈 오류\u001b[2K\u0007\b\r가짜 줄\u0085끝'); };
  const { code, lines } = await runMain(['--issues', '7'], ctx, s);
  assert.equal(code, 2);
  assert.doesNotMatch(lines[0], /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  assert.match(lines[0], /이슈 오류/);
});

test('run-operator 스크립트: 실제 프로세스 성공 실행의 stdout은 보고 두 줄뿐', () => {
  const ctx = makeRun();
  const fake = fakeEnv();
  const gh = `${tmp('op-gh-')}/gh.mjs`;
  writeFileSync(gh, FAKE_GH);
  const r = spawnSync(process.execPath, [`${realHarness}/operator/run-operator.mjs`, '--issues', '7,8'], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_RUN_DIR: ctx.run, HARNESS_GH_BIN: gh },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), ['#7 | 리뷰대기 | https://example.test/issues/7', '#8 | 리뷰대기 | https://example.test/issues/8']);
  assert.equal(r.stdout.includes('CHILD'), false);
  assert.equal(fake.calls().length, 1);
});

test('launchSession: 끝날 때 죽은 pids는 걸러내고 산 pid는 남긴다(재사용 pid 종료 방지)', async () => {
  const { EventEmitter } = await import('node:events');
  const ctx = makeRun();
  mkdirSync(`${ctx.run}/handoffs/h1`, { recursive: true });
  const file = `${ctx.run}/handoffs/h1/session.json`;
  const spawn = () => {
    const c = new EventEmitter();
    c.pid = 777; c.stdout = { resume() {} }; c.stderr = { resume() {} }; c.stdin = { on() {}, end() {} };
    setImmediate(() => {
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pids: [111, 222] }));
      c.emit('close', 0, null);
    });
    return c;
  };
  const r = await launchSession({ mode: 'work', handoff: 'h1', run: ctx.run, harnessDir: ctx.harnessDir, prompt: 'p', timeoutMs: 20000 }, { spawn, probe: (p) => p === 222 });
  assert.equal(r.code, 0);
  const j = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(j.pids, [222]);
  assert.equal(j.pid, 777);
  assert.ok(j.endedAt);
});

test('pruneDeadPids: 탐침이 거짓인 pid만 버리고, 기본 탐침은 이 프로세스를 산 것으로 본다', () => {
  assert.deepEqual(pruneDeadPids([1, 2, 3], (p) => p !== 1), [2, 3]);
  assert.deepEqual(pruneDeadPids([process.pid, 4000000]), [process.pid]);
});

test('makeGhDeps.fetchDependsOn: 본문의 의존하는 이슈 번호, 읽을 수 없으면 빈 목록', async () => {
  const seen = [];
  const make = (body) => makeGhDeps('o/r', (bin, args) => { seen.push(args); return JSON.stringify({ body }); });
  assert.deepEqual(await make('## 의존하는 이슈\n#3, #4\n').fetchDependsOn(7), [3, 4]);
  assert.deepEqual(seen[0], ['issue', 'view', '7', '--repo', 'o/r', '--json', 'body']);
  assert.deepEqual(await make('의존 절 없음').fetchDependsOn(7), []);
});
