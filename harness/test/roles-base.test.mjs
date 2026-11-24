// 결정 8-29(역할 오퍼레이터: 담당 팀, 하달 기록 dispatch.json, 워커 기록 workers.jsonl)와
// 결정 8-31(F11: 반영 전 하달 위에서 시작하는 --base h<N>, 반영 순서)의 시험. 실제 모델·gh는 부르지 않는다(가짜 러너, gh 함수 끼워 넣기).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { withMixedRunners } from './helpers/mixed-runners.mjs';
import { main as runOperator } from '../operator/run-operator.mjs';
import { main as runWorker } from '../operator/run-worker.mjs';
import { main as runResearch } from '../operator/run-research.mjs';
import { main as reflectMain } from '../operator/run-reflect.mjs';
import { main as stopMain } from '../operator/stop-operator.mjs';
import { sessionSettings } from '../operator/launch.mjs';
import { parseTeam, parseKind, parseDependsOn } from '../operator/issue-body.mjs';
import { baseOrderProblem } from '../operator/merge-adapter.mjs';
import { decide } from '../policy.mjs';

const here = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const realHarness = dirname(here).replace(/\\/g, '/');
const guardFile = `${realHarness}/guard.mjs`;
const T = { timeout: 120000 };
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 잠긴 파일은 무시 */ } } });
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();

// 가짜 워커 러너(claude CLI 자리): 이슈 번호 파일 하나를 커밋하고 결과 파일을 쓴다. FAKE_FAILS번째 시도까지는 실패한다.
const FAKE = `
import { writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const E = process.env;
let stdin = ''; for await (const c of process.stdin) stdin += c;
mkdirSync(E.FAKE_LOG, { recursive: true });
const n = readdirSync(E.FAKE_LOG).length + 1;
writeFileSync(E.FAKE_LOG + '/a-' + n, 'x');
if (n <= Number(E.FAKE_FAILS ?? 0)) process.exit(1);
const g = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
writeFileSync('work-' + E.FAKE_ISSUE + '.txt', 'x');
g('add', '-A'); g('commit', '-q', '-m', 'work ' + E.FAKE_ISSUE);
mkdirSync('.harness', { recursive: true });
const secs = [['이슈 번호', E.FAKE_ISSUE], ['변경 요약', 'x'], ['테스트 명령과 결과', '통과'], ['커밋 해시', g('rev-parse', 'HEAD')]];
writeFileSync('.harness/worker-result.md', secs.map(([k, v]) => '## ' + k + '\\n' + v + '\\n').join('\\n'));
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'rb-')).replace(/\\/g, '/');
  made.push(root);
  const run = `${root}/run`;
  const harnessDir = `${root}/harness`;
  const memo = `${root}/memo`;
  mkdirSync(`${run}/handoffs`, { recursive: true });
  mkdirSync(`${harnessDir}/operator/skills/operator-work`, { recursive: true });
  mkdirSync(`${harnessDir}/operator/skills/operator-research`, { recursive: true });
  const cfg = withMixedRunners(JSON.parse(readFileSync(`${realHarness}/operator/operator.config.json`, 'utf8')));
  cfg.allowedModels = ['claude'];
  cfg.jev.routing.workerModels = { claude: 'claude 일' };
  cfg.fallback = {};
  cfg.workerRetries = 2;
  writeFileSync(`${harnessDir}/operator/operator.config.json`, JSON.stringify(cfg));
  copyFileSync(`${realHarness}/operator/AGENT.md`, `${harnessDir}/operator/AGENT.md`);
  copyFileSync(`${realHarness}/operator/skills/operator-work/SKILL.md`, `${harnessDir}/operator/skills/operator-work/SKILL.md`);
  copyFileSync(`${realHarness}/operator/skills/operator-research/SKILL.md`, `${harnessDir}/operator/skills/operator-research/SKILL.md`);
  mkdirSync(`${memo}/test`, { recursive: true });
  git(memo, 'init', '-q', '-b', 'main');
  git(memo, 'config', 'core.autocrlf', 'false');
  writeFileSync(`${memo}/README.md`, 'base\n');
  writeFileSync(`${memo}/test/ok.test.mjs`, "import { test } from 'node:test';\ntest('ok', () => {});\n");
  git(memo, 'add', '-A');
  git(memo, 'commit', '-q', '-m', 'base');
  writeFileSync(`${run}/harness.json`, JSON.stringify({ harnessDir, targetProject: memo, designatedRepo: 'o/r', issuesClone: `${root}/issues`, worktrees: `${run}/worktrees` }));
  const fake = `${root}/fake-runner.mjs`;
  writeFileSync(fake, FAKE);
  const env = { HARNESS_RUN_DIR: run, HARNESS_CLAUDE_BIN: fake, HARNESS_WORKER_PASS_ENV: 'FAKE_*', FAKE_LOG: `${root}/log` };
  return { root, run, harnessDir, memo, env };
}

// 반영 전 하달: handoffs/h<N> 폴더와 이슈 브랜치(파일 하나).
function priorHandoff(f, h, n, file) {
  mkdirSync(`${f.run}/handoffs/${h}`, { recursive: true });
  git(f.memo, 'checkout', '-q', '-b', `${h}/issue-${n}`, 'main');
  writeFileSync(`${f.memo}/${file}`, `${file}\n`);
  git(f.memo, 'add', '-A');
  git(f.memo, 'commit', '-q', '-m', `work ${n}`);
  const sha = git(f.memo, 'rev-parse', 'HEAD');
  git(f.memo, 'checkout', '-q', 'main');
  return sha;
}

let seq = 0;
const cm = (body) => ({ id: ++seq, author: { login: 'rev' }, body, url: `https://github.com/o/r/issues/1#issuecomment-${1000 + seq}`, createdAt: new Date(Date.parse('2026-01-01T00:00:00Z') + seq * 1000).toISOString(), updatedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + seq * 1000).toISOString() });
const allowPair = (sha) => [cm(`## 결과 보고서\n커밋 해시: ${sha}\n`), cm(`## 리뷰어 판정: 허용\n\n허용된 커밋: ${sha}\n이유`)];
const body = ({ team, deps = [], kind = '작업' } = {}) => `## 목표\nx\n\n## 영역, 워커 모델, 유형\n- 워커 모델: claude\n- 유형: ${kind} (Jev 라우팅, 확률 0.80)\n${team ? `- 담당 팀: ${team}\n` : ''}\n## 의존하는 이슈\n${deps.length ? deps.map((d) => `#${d}`).join(', ') : '없음'}\n`;

function fakeRepo(init) {
  const issues = new Map(Object.entries(init).map(([n, v]) => [Number(n), { label: v.label ?? '진행중', comments: v.comments ?? [], body: v.body ?? body() }]));
  const url = (n) => `https://github.com/o/r/issues/${n}`;
  return {
    issues,
    fetchIssue: async (n) => ({ state: issues.get(n).label ?? '라벨 없음', url: url(n) }),
    setState: async (n, s) => { issues.get(n).label = s; },
    countReports: async (n) => issues.get(n).comments.filter((c) => c.body.startsWith('## 결과 보고서')).length,
    fetchDependsOn: async (n) => parseDependsOn(issues.get(n).body) ?? [],
    fetchTeam: async (n) => parseTeam(issues.get(n).body),
    fetchIssueData: async (n) => { const i = issues.get(n); return { number: n, state: 'OPEN', url: url(n), labels: i.label ? [{ name: i.label }] : [], body: i.body, comments: i.comments }; },
  };
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const lines = (p) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const passAll = async () => ({ ok: true, code: 0, timedOut: false, overCap: false });

// ---------- 담당 팀 읽기 ----------
test('parseTeam: 다섯 값은 읽고, 줄 없음·모르는 값·두 줄은 null. 대소문자와 뒤 설명을 다룬다', () => {
  for (const t of ['dev', 'design', 'tester', 'plan', 'sec']) assert.equal(parseTeam(`- 담당 팀: ${t}\n`), t);
  assert.equal(parseTeam('- 담당 팀: DEV (개발팀)\n'), 'dev');
  assert.equal(parseTeam('## 영역\n- 담당 팀:sec\n'), 'sec');
  assert.equal(parseTeam('## 목표\nx\n'), null);
  assert.equal(parseTeam('- 담당 팀: qa\n'), null);
  assert.equal(parseTeam('- 담당 팀: 개발팀\n'), null);
  assert.equal(parseTeam('- 담당 팀: dev\n- 담당 팀: dev\n'), null, '두 줄은 불명확');
  assert.equal(parseTeam('- 담당 팀: dev\n- 담당 팀: x\n'), null);
  assert.equal(parseTeam('```\n- 담당 팀: dev\n```\n'), null, '코드 블록 안은 읽지 않는다');
  assert.equal(parseTeam('- 담당 팀: development\n'), null);
  assert.equal(parseKind(body({ kind: '조사' })), '조사');
  assert.equal(parseKind('x'), null);
});

// ---------- 하달 기록 ----------
async function dispatchOnly(f, repo, argv) {
  const out = []; const launched = [];
  const code = await runOperator(argv, { HARNESS_RUN_DIR: f.run }, {
    write: (l) => out.push(l), ...repo,
    launchSession: async (o) => { launched.push(o); return { code: 0, timedOut: false }; },
  });
  return { code, out, launched };
}

test('하달 기록(8-29): 팀이 같으면 dispatch.json에 팀·요청·넘긴 이슈·뺀 사유가 남고, 세션 머리말에 담당 팀이 온다. 끝나면 endedAt·rows가 채워진다', T, async () => {
  const f = setup();
  const repo = fakeRepo({ 5: { body: body({ team: 'dev' }) }, 6: { body: body({ team: 'dev', deps: [9] }) }, 9: { body: body({ team: 'dev' }) } });
  const d = await dispatchOnly(f, repo, ['--issues', '5,6']);
  assert.equal(d.code, 1);
  assert.deepEqual(d.launched.map((o) => [o.handoff, o.issues, o.baseHandoff]), [['h1', [5], undefined]]);
  assert.match(d.launched[0].prompt, /^- 담당 팀: 개발팀\(dev\)$/m);
  assert.match(d.launched[0].prompt, /^- 시작 지점: main$/m);
  const rec = readJson(`${f.run}/handoffs/h1/dispatch.json`);
  assert.equal(rec.team, 'dev');
  assert.equal(rec.mode, 'work');
  assert.deepEqual(rec.requested, [5, 6]);
  assert.deepEqual(rec.live, [5]);
  assert.deepEqual(rec.excluded, [{ issue: 6, reason: '대기' }]);
  assert.equal(rec.base, null);
  assert.match(rec.startedAt, /^\d{4}-/);
  assert.match(rec.endedAt, /^\d{4}-/);
  assert.equal(rec.sessionOk, true);
  assert.deepEqual(rec.rows, [{ number: 5, state: '진행중' }, { number: 6, state: '대기' }]);
});

test('하달 기록(8-29): 팀이 섞이면(팀 없음 포함) 종료 코드 2, 하달 폴더도 세션도 만들지 않는다', T, async () => {
  const f = setup();
  const repo = fakeRepo({ 5: { body: body({ team: 'dev' }) }, 6: { body: body({ team: 'tester' }) }, 7: { body: body() } });
  const d = await dispatchOnly(f, repo, ['--issues', '5,6']);
  assert.equal(d.code, 2);
  assert.deepEqual(d.out, ['오류: 이슈 #5(dev)와 #6(tester)의 담당 팀이 다릅니다. 팀별로 따로 하달하세요.']);
  assert.deepEqual(d.launched, []);
  assert.deepEqual(readdirSync(`${f.run}/handoffs`), []);
  const d2 = await dispatchOnly(f, repo, ['--issues', '7,5']);
  assert.equal(d2.code, 2);
  assert.match(d2.out[0], /#7\(팀 없음\)와 #5\(dev\)/);
  assert.deepEqual(readdirSync(`${f.run}/handoffs`), []);
});

test('하달 기록(8-29): 모두 빠진 하달도 dispatch.json이 남고 live가 빈다. 팀 없는 이슈만이면 team null이고 출력은 그대로다', T, async () => {
  const f = setup();
  const repo = fakeRepo({ 6: { body: body({ team: 'plan', deps: [9] }) }, 9: {}, 7: {} });
  const d = await dispatchOnly(f, repo, ['--issues', '6']);
  assert.deepEqual(d.launched, []);
  const rec = readJson(`${f.run}/handoffs/h1/dispatch.json`);
  assert.deepEqual([rec.team, rec.live, rec.excluded, rec.sessionOk], ['plan', [], [{ issue: 6, reason: '대기' }], true]);
  assert.ok(rec.endedAt);
  const d2 = await dispatchOnly(f, repo, ['--issues', '7']);
  assert.deepEqual(d2.out, ['#7 | 진행중 | https://github.com/o/r/issues/7']);
  assert.match(d2.launched[0].prompt, /^- 담당 팀: 없음$/m);
  assert.equal(readJson(`${f.run}/handoffs/h2/dispatch.json`).team, null);
});

test('하달 기록(8-29): 조사 하달도 dispatch.json(mode research, 팀)을 남긴다', T, async () => {
  const f = setup();
  const repo = fakeRepo({ 4: { body: body({ team: 'sec', kind: '조사' }) } });
  const out = [];
  const code = await runResearch(['--issue', '4'], { HARNESS_RUN_DIR: f.run }, { write: (l) => out.push(l), ...repo, launchSession: async () => ({ code: 0, timedOut: false }) });
  assert.equal(code, 0, out.join());
  const rec = readJson(`${f.run}/handoffs/h1/dispatch.json`);
  assert.deepEqual([rec.team, rec.mode, rec.live, rec.sessionOk], ['sec', 'research', [4], true]);
  assert.ok(rec.endedAt);
});

// ---------- 워커 기록 ----------
async function worker(f, handoff, issue, extra = [], env = {}) {
  const out = []; const err = [];
  const code = await runWorker(['--handoff', handoff, '--issue', String(issue), '--model', 'claude', ...extra], { ...f.env, FAKE_ISSUE: String(issue), ...env },
    { write: (l) => out.push(l), writeErr: (l) => err.push(l), fetchIssueBody: async () => '본문' });
  return { code, out, err, rec: out[0] ? JSON.parse(out[0]) : null };
}

test('워커 기록(8-29): 호출마다 start·end 한 줄씩. 재시도 3번이면 attempts 3인 end 하나. 쓰기 실패는 결과를 바꾸지 않는다', T, async () => {
  const f = setup();
  mkdirSync(`${f.run}/handoffs/h1`);
  const r = await worker(f, 'h1', 7, [], { FAKE_FAILS: '2' });
  assert.equal(r.code, 0, r.err.join());
  const [s, e, ...rest] = lines(`${f.run}/handoffs/h1/workers.jsonl`);
  assert.deepEqual(rest, []);
  assert.deepEqual([s.event, s.issue, s.requestedModel, s.model, s.base], ['start', 7, 'claude', 'claude', 'main']);
  assert.equal(s.baseCommit, git(f.memo, 'rev-parse', 'main'));
  assert.deepEqual([e.event, e.issue, e.status, e.attempts, e.model], ['end', 7, '완료', 3, 'claude']);
  // workers.jsonl 자리가 폴더라 쓸 수 없어도 워커는 그대로 끝난다.
  mkdirSync(`${f.run}/handoffs/h2/workers.jsonl`, { recursive: true });
  rmSync(`${f.root}/log`, { recursive: true, force: true });
  const r2 = await worker(f, 'h2', 8);
  assert.equal(r2.code, 0, r2.err.join());
  assert.equal(r2.rec.status, '완료');
});

// ---------- 시작 지점 --base (F11, 결정 8-31) ----------
test('--base(8-31): 반영 전 하달 h1 위에서 시작한 하달의 새 워크트리에 앞 이슈의 파일이 보이고, 반영은 h1부터만 된다', T, async () => {
  const f = setup();
  const s45 = priorHandoff(f, 'h1', 45, 'quickstart.md');
  writeFileSync(`${f.run}/handoffs/h1/dispatch.json`, JSON.stringify({ team: 'plan', mode: 'work', base: null }));
  const repo = fakeRepo({
    45: { label: '리뷰대기', body: body({ team: 'plan' }), comments: allowPair(s45) },
    46: { label: '미완료', body: body({ team: 'tester', deps: [45] }) },
  });
  const launched = [];
  const out = [];
  // 가짜 세션: 머리말의 기준 줄을 읽어 그대로 run-worker에 넘긴다(오퍼레이터가 하는 일).
  const code = await runOperator(['--issues', '46', '--base', 'h1'], { HARNESS_RUN_DIR: f.run }, {
    write: (l) => out.push(l), ...repo,
    launchSession: async (o) => {
      launched.push(o);
      const m = /^ {2}- #46: run-worker에 --base (\S+)$/m.exec(o.prompt);
      assert.ok(m, o.prompt.split('\n').slice(0, 14).join('\n'));
      const w = await worker(f, o.handoff, 46, ['--base', m[1]]);
      assert.equal(w.code, 0, w.err.join());
      return { code: 0, timedOut: false };
    },
  });
  assert.equal(code, 0, out.join());
  assert.equal(launched[0].handoff, 'h2');
  assert.equal(launched[0].baseHandoff, 'h1', '세션 훅에 시작 지점 하달을 넘긴다');
  assert.match(launched[0].prompt, /^- 시작 지점: h1 \(아직 main에 반영 전\)$/m);
  assert.ok(existsSync(`${f.run}/worktrees/h2/issue-46/quickstart.md`), '앞 하달 이슈의 파일이 새 워크트리에 있다');
  const rec = readJson(`${f.run}/handoffs/h2/dispatch.json`);
  assert.deepEqual([rec.team, rec.base, rec.issueBases, rec.excluded], ['tester', 'h1', { 46: 'h1/issue-45' }, []]);
  const start = lines(`${f.run}/handoffs/h2/workers.jsonl`)[0];
  assert.deepEqual([start.base, start.baseCommit], ['h1/issue-45', s45]);
  assert.ok(existsSync(`${f.run}/handoffs/h1/dispatch.json`) && git(f.memo, 'rev-parse', 'refs/heads/h1/issue-45') === s45, '시작 지점 하달은 건드리지 않는다');

  // 46도 허용됐다. h2부터 반영하면 거부(종료 코드 2), main은 그대로.
  const s46 = git(f.memo, 'rev-parse', 'refs/heads/h2/issue-46');
  repo.issues.get(46).comments.push(...allowPair(s46));
  repo.issues.get(46).label = '리뷰대기'; // 합치기 스크립트가 붙이는 라벨(이 시험은 세션 안의 합치기를 건너뛴다)
  const mainBefore = git(f.memo, 'rev-parse', 'main');
  const reflect = async (h) => { const o = []; const e = []; const c = await reflectMain(['--handoff', h], { HARNESS_RUN_DIR: f.run }, { write: (l) => o.push(l), writeErr: (l) => e.push(l), runTests: passAll, fetchIssueData: repo.fetchIssueData, setState: repo.setState }); return { c, o, e }; };
  const early = await reflect('h2');
  assert.equal(early.c, 2);
  assert.match(early.e.join('\n'), /h2은 h1의 결과\(#45\) 위에서 시작했고 그 결과가 아직 main에 없습니다\. h1부터 반영하세요/);
  assert.equal(git(f.memo, 'rev-parse', 'main'), mainBefore);
  // 의존 글이 없어도 git 조상 관계로 거부한다.
  assert.match(baseOrderProblem((cwd, a) => git(cwd, ...a), f.memo, f.run, 'h2', [{ n: 46, sha: s46 }]), /h1부터 반영/);

  // h1 → h2 순서면 둘 다 반영된다.
  const r1 = await reflect('h1');
  assert.equal(r1.c, 0, r1.e.join());
  const r2 = await reflect('h2');
  assert.equal(r2.c, 0, r2.e.join());
  assert.deepEqual(r2.o, ['#46 | 반영됨 | https://github.com/o/r/issues/46']);
  assert.equal(git(f.memo, 'show', 'main:quickstart.md'), 'quickstart.md');
  assert.equal(git(f.memo, 'show', 'main:work-46.txt'), 'x');
});

test('--base(8-31): 시작 지점 하달이 없으면 거부, 이미 반영됐으면 main에서 시작(base null, 요청은 기록), --handoff와 함께 쓰면 거부', T, async () => {
  const f = setup();
  const repo = fakeRepo({ 46: { body: body({ deps: [45] }) }, 45: {}, 47: {} });
  const none = await dispatchOnly(f, repo, ['--issues', '47', '--base', 'h9']);
  assert.equal(none.code, 2);
  assert.match(none.out[0], /시작 지점 하달 h9 폴더가 없습니다/);
  assert.deepEqual(readdirSync(`${f.run}/handoffs`), [], '거부하면 하달 폴더를 만들지 않는다');
  mkdirSync(`${f.run}/handoffs/h1`);
  const empty = await dispatchOnly(f, repo, ['--issues', '47', '--base', 'h1']);
  assert.equal(empty.code, 2);
  assert.match(empty.out[0], /h1에 이슈 브랜치가 없습니다/);
  // 머지 트레인으로 들어가 run-train이 이름 공간을 치운 하달(train.json이 남음, 결정 8-35)은 반영된 것으로 보고 main에서 시작한다
  writeFileSync(`${f.run}/handoffs/h1/train.json`, JSON.stringify({ train: 'train/20261122-1', issues: [] }));
  const trained = await dispatchOnly(f, repo, ['--issues', '47', '--base', 'h1']);
  assert.equal(trained.code, 0, trained.out.join());
  assert.equal(trained.launched[0].baseHandoff, undefined);
  assert.deepEqual(readJson(`${f.run}/handoffs/h2/dispatch.json`).base, null);
  rmSync(`${f.run}/handoffs/h1/train.json`);
  rmSync(`${f.run}/handoffs/h2`, { recursive: true, force: true });
  // h1/issue-45를 main에 반영해 둔다(이 하네스의 병합 커밋 모양).
  const s45 = priorHandoff(f, 'h1', 45, 'quickstart.md');
  git(f.memo, 'merge', '-q', '--no-ff', s45, '-m', '병합: 이슈 #45', '-m', `허용된 커밋: ${s45}`);
  const done = await dispatchOnly(f, repo, ['--issues', '46', '--base', 'h1']);
  assert.equal(done.code, 0, done.out.join());
  assert.equal(done.launched[0].baseHandoff, undefined);
  const rec = readJson(`${f.run}/handoffs/h2/dispatch.json`);
  assert.deepEqual([rec.base, rec.baseRequested], [null, 'h1']);
  const both = await dispatchOnly(f, repo, ['--issues', '46', '--base', 'h1', '--handoff', 'h2']);
  assert.equal(both.code, 2);
  assert.match(both.out[0], /--base는 새 하달에만/);
});

test('--base(8-31): 밖의 의존이 시작 지점 하달에 없으면(다른 반영 전 하달) 여전히 대기다', T, async () => {
  const f = setup();
  priorHandoff(f, 'h1', 45, 'a.md');
  const s44 = priorHandoff(f, 'h2', 44, 'b.md');
  const repo = fakeRepo({ 44: { label: '리뷰대기', comments: allowPair(s44) }, 45: {}, 46: { body: body({ deps: [44, 45] }) }, 47: { body: body({ deps: [45] }) } });
  const d = await dispatchOnly(f, repo, ['--issues', '46,47', '--base', 'h1']);
  assert.deepEqual(d.launched.map((o) => o.issues), [[47]]);
  assert.ok(d.out.join('\n').includes('#46 | 대기'));
});

test('--base(8-31): h2를 멈추고 정리해도 시작 지점 h1의 브랜치·통합 브랜치는 그대로다', T, async () => {
  const f = setup();
  const s45 = priorHandoff(f, 'h1', 45, 'quickstart.md');
  git(f.memo, 'branch', 'integration/h1', s45);
  mkdirSync(`${f.run}/handoffs/h2`);
  const w = await worker(f, 'h2', 46, ['--base', 'h1/issue-45']);
  assert.equal(w.code, 0, w.err.join());
  writeFileSync(`${f.run}/handoffs/h2/session.json`, JSON.stringify({ pid: null, endedAt: '2026-01-01T00:00:00Z', pids: [] }));
  const out = [];
  assert.equal(await stopMain(['--handoff', 'h2'], { HARNESS_RUN_DIR: f.run }, { write: (l) => out.push(l) }), 3, out.join());
  assert.equal(git(f.memo, 'branch', '--list', 'h2/*'), '');
  assert.equal(git(f.memo, 'rev-parse', 'refs/heads/h1/issue-45'), s45);
  assert.equal(git(f.memo, 'rev-parse', 'refs/heads/integration/h1'), s45);
});

// ---------- 훅 ----------
const HR = 'C:/run';
const opConfig = (extra = {}) => ({ harnessDir: 'C:/h', runDir: HR, issuesClone: `${HR}/issues`, targetProject: `${HR}/memo`, designatedRepo: 'o/r', role: 'operator-work', handoff: 'h2', ...extra });
const hookBash = (command, config) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: HR }, config, { visibility: () => 'PRIVATE', readFile: () => { throw new Error('x'); } });

test('훅(8-31): 시작 지점 하달이 있으면 run-worker --base에 그 하달의 이슈 브랜치만 더 받는다. 다른 모양은 지금처럼 막는다', () => {
  const withBase = opConfig({ baseHandoff: 'h1' });
  const rw = (base) => `node C:/h/operator/run-worker.mjs --handoff h2 --issue 46 --model claude --base ${base}`;
  assert.equal(hookBash(rw('h1/issue-45'), withBase).allow, true);
  assert.equal(hookBash(rw('h2/issue-44'), withBase).allow, true);
  assert.equal(hookBash(rw('main'), withBase).allow, true);
  assert.equal(hookBash(rw('h1/issue-45'), opConfig()).allow, false, '시작 지점이 없으면 다른 하달의 브랜치는 받지 않는다');
  assert.equal(hookBash(rw('h3/issue-45'), withBase).allow, false);
  assert.equal(hookBash(rw('integration/h1'), withBase).allow, false, '통합 브랜치는 병합 커밋을 넣는다(run-11)');
  assert.equal(hookBash(rw('h1/issue-45'), opConfig({ baseHandoff: 'h2' })).allow, false);
  assert.equal(hookBash('git -C C:/run/memo branch -D h1/issue-45', withBase).allow, false, '시작 지점 하달의 브랜치는 지우지 못한다');
  assert.equal(hookBash('git -C C:/run/worktrees/h2/integration merge --no-ff h1/issue-45 -m x', withBase).allow, false, '시작 지점 하달의 브랜치는 합치지 못한다');
  assert.equal(hookBash('git -C C:/run/memo worktree add C:/run/worktrees/h2/issue-46 -b h2/issue-46 h1/issue-45', withBase).allow, false);
});

test('훅(8-31): 코디네이터는 run-operator --base h<N>을 쓸 수 있고 다른 모양은 막힌다', () => {
  const coord = { designatedRepo: 'o/r', issuesClone: `${HR}/issues`, targetProject: `${HR}/memo`, harnessDir: 'C:/h', runDir: HR };
  const c = (cmd) => decide({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: HR }, coord, { visibility: () => 'PRIVATE', readFile: () => { throw new Error('x'); } }).allow;
  assert.equal(c('node C:/h/operator/run-operator.mjs --issues 46 --base h1'), true);
  assert.equal(c('node C:/h/operator/run-operator.mjs --base h1 --issues 46,47'), true);
  assert.equal(c('node C:/h/operator/run-operator.mjs --issues 46 --base h1/issue-45'), false);
  assert.equal(c('node C:/h/operator/run-operator.mjs --issues 46 --base integration/h1'), false);
  assert.equal(c('node C:/h/operator/run-operator.mjs --issues 46 --base h1 --base h2'), false);
});

test('훅(8-31): 세션 설정은 시작 지점이 있을 때만 --base-handoff를 붙이고, guard는 그 값을 operator-work에만 받는다', () => {
  assert.doesNotMatch(sessionSettings({ mode: 'work', handoff: 'h2', run: 'C:/r', harnessDir: 'C:/h' }).hooks.PreToolUse[0].hooks[0].command, /base-handoff/);
  assert.match(sessionSettings({ mode: 'work', handoff: 'h2', run: 'C:/r', harnessDir: 'C:/h', baseHandoff: 'h1' }).hooks.PreToolUse[0].hooks[0].command, / --base-handoff h1$/);
  assert.throws(() => sessionSettings({ mode: 'research', handoff: 'h2', run: 'C:/r', harnessDir: 'C:/h', issue: 4, baseHandoff: 'h1' }));
  assert.throws(() => sessionSettings({ mode: 'work', handoff: 'h2', run: 'C:/r', harnessDir: 'C:/h', baseHandoff: 'h2' }));
  const dir = mkdtempSync(join(tmpdir(), 'rbg-')).replace(/\\/g, '/');
  made.push(dir);
  writeFileSync(`${dir}/harness.json`, JSON.stringify({ designatedRepo: 'o/r', issuesClone: `${dir}/issues`, targetProject: `${dir}/memo`, harnessDir: realHarness, runDir: dir }));
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: `node ${realHarness}/operator/run-worker.mjs --handoff h2 --issue 46 --model claude --base h1/issue-45` }, cwd: dir });
  const run = (...a) => spawnSync(process.execPath, [guardFile, '--config', `${dir}/harness.json`, '--visibility-stub', 'PRIVATE', ...a], { input, encoding: 'utf8' }).status;
  assert.equal(run('--role', 'operator-work', '--handoff', 'h2', '--base-handoff', 'h1'), 0);
  assert.equal(run('--role', 'operator-work', '--handoff', 'h2'), 2);
  assert.equal(run('--role', 'operator-reflect', '--handoff', 'h2', '--base-handoff', 'h1'), 2);
  assert.equal(run('--role', 'operator-work', '--handoff', 'h2', '--base-handoff', 'h2'), 2);
  assert.equal(run('--role', 'operator-work', '--handoff', 'h2', '--base-handoff=h1'), 2, '비슷한 모양은 닫힌 실패');
});
