import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'owner/harness-issues';

function runSetup() {
  const run = join(mkdtempSync(join(tmpdir(), 'setup-')), 'run');
  const r = spawnSync(process.execPath, [join(harnessDir, 'setup.mjs'), '--run', run, '--repo', REPO, '--no-clone'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return run;
}

test('setup creates run layout', () => {
  const run = runSetup();
  for (const p of ['harness.json', 'CLAUDE.md', '.claude/settings.json', 'issues/.gitignore', 'memo/cli.mjs', 'worktrees', 'logs', 'handoffs', 'reviewer-inbox',
    '.claude/agents/advisor.md']) {
    assert.ok(existsSync(join(run, p)), p);
  }
  assert.ok(!existsSync(join(run, '.claude/agents/worker.md')), 'worker는 하위 에이전트가 아니다');
  assert.ok(!existsSync(join(run, '.claude/agents/reviewer.md')), 'reviewer는 하위 에이전트가 아니다(ADR 0004, 소유자 결정 5-1)');
  assert.ok(!existsSync(join(harnessDir, 'agents', 'reviewer.md')), '리뷰어 하위 에이전트 정의는 지웠다(소유자 결정 5-1)');
  const config = JSON.parse(readFileSync(join(run, 'harness.json'), 'utf8'));
  assert.equal(config.designatedRepo, REPO);
  assert.match(config.issuesClone, /\/issues$/);
  assert.doesNotMatch(readFileSync(join(run, 'CLAUDE.md'), 'utf8'), /\{\{[A-Z]+\}\}/);
  assert.ok(!existsSync(join(run, '.claude/agents/operator.md')), 'operator subagent file is replaced by harness/operator/');
});

test('harness.json points at the operator config file', () => {
  const run = runSetup();
  const config = JSON.parse(readFileSync(join(run, 'harness.json'), 'utf8'));
  assert.match(config.operatorConfig, /operator[\\/]operator\.config\.json$/);
  assert.ok(existsSync(config.operatorConfig), config.operatorConfig);
});

test('settings hook points at guard with absolute config', () => {
  const run = runSetup();
  const settings = JSON.parse(readFileSync(join(run, '.claude/settings.json'), 'utf8'));
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
  assert.equal(settings.hooks.PreToolUse[0].matcher, '*');
  assert.match(cmd, /guard\.mjs" --config ".*\/harness\.json"$/);
  assert.equal(settings.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '2');
});

test('role docs: tools and file names match what the run showed', () => {
  const read = (p) => readFileSync(join(harnessDir, p), 'utf8');
  // 결과 보고서는 오퍼레이터가 올린 것만 인정한다
  assert.match(read('coordinator.md'), /대신 올리지 않는다/);
});

test('refresh rewrites role files only', () => {
  const run = runSetup();
  writeFileSync(join(run, 'CLAUDE.md'), 'stale');
  writeFileSync(join(run, 'memo', 'marker.txt'), 'keep');
  const r = spawnSync(process.execPath, [join(harnessDir, 'setup.mjs'), '--run', run, '--repo', REPO, '--refresh'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(readFileSync(join(run, 'CLAUDE.md'), 'utf8'), 'stale');
  assert.equal(readFileSync(join(run, 'memo', 'marker.txt'), 'utf8'), 'keep');
});

test('memo repo has one commit and passing tests', () => {
  const run = runSetup();
  const log = spawnSync('git', ['-C', join(run, 'memo'), 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' });
  assert.equal(log.stdout.trim(), '1');
  const t = spawnSync(process.execPath, ['--test'], { cwd: join(run, 'memo'), encoding: 'utf8' });
  assert.equal(t.status, 0, t.stdout);
});

// ---------- T3: 가짜 gh로 클론 경로와 공개 저장소 차단을 시험한다 ----------
import { mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

// 가짜 gh: repo view는 FAKE_VIS를, repo clone은 FAKE_ORIGIN(로컬 bare 저장소)을 복제하고, label create는 FAKE_LOG에 적는다.
const FAKE_GH = `
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, a.join(' ') + '\\n');
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write((process.env.FAKE_VIS ?? 'PRIVATE') + '\\n'); process.exit(process.env.FAKE_VIEW_FAIL ? 1 : 0); }
if (a[0] === 'repo' && a[1] === 'clone') { execFileSync('git', ['clone', '-q', process.env.FAKE_ORIGIN, a[3]], { stdio: 'ignore' }); process.exit(0); }
if (a[0] === 'label' && a[1] === 'create') process.exit(0);
process.stderr.write('unexpected gh call: ' + a.join(' '));
process.exit(1);
`;

function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), 'setup-gh-'));
  const bin = join(dir, 'gh.mjs');
  writeFileSync(bin, FAKE_GH);
  const origin = join(dir, 'origin.git');
  mkdirSync(origin);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  return { dir, origin, log, env: { ...process.env, HARNESS_GH_BIN: bin, FAKE_LOG: log, FAKE_ORIGIN: origin } };
}
const setupWith = (run, extra, env) => spawnSync(process.execPath, [join(harnessDir, 'setup.mjs'), '--run', run, '--repo', REPO, ...extra], { encoding: 'utf8', env });
const walk = (dir, base = dir, out = {}) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '.git') walk(p, base, out); } else out[p.slice(base.length)] = createHash('sha256').update(readFileSync(p)).digest('hex');
  }
  return out;
};

test('T3: 지정 저장소가 PRIVATE이면 클론하고 실행 폴더에 규칙·에이전트·설정·클론이 생긴다', () => {
  const g = fakeGh();
  const run = join(mkdtempSync(join(tmpdir(), 'setup-')), 'run');
  const r = setupWith(run, [], { ...g.env, FAKE_VIS: 'PRIVATE' });
  assert.equal(r.status, 0, r.stderr);
  for (const p of ['CLAUDE.md', 'harness.json', '.claude/settings.json', '.claude/agents/advisor.md', 'reviewer-inbox', 'issues/.git', 'issues/advisors.md', 'issues/records/memo.md', 'memo/.git']) {
    assert.ok(existsSync(join(run, p)), p);
  }
  const origin = spawnSync('git', ['-C', join(run, 'issues'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(origin.replace(/\\/g, '/'), g.origin.replace(/\\/g, '/'));
  // 초기 문서가 원격에 올라갔다
  assert.match(spawnSync('git', ['--git-dir', g.origin, 'log', '--oneline', 'main'], { encoding: 'utf8' }).stdout, /초기 문서/);
  assert.match(readFileSync(g.log, 'utf8'), /^repo view /m);
  // 만든 파일 목록과 다음 실행 명령 한 줄이 출력된다
  assert.match(r.stdout, /만든 것:/);
  assert.match(r.stdout, /CLAUDE\.md/);
  const next = r.stdout.split('\n').filter((l) => l.startsWith('다음 실행 명령:'));
  assert.equal(next.length, 1);
  assert.match(next[0], /claude --setting-sources project,local --allowedTools/);
});

test('T3: {{REPO}}, {{ISSUES}}, {{MEMO}}, {{HARNESS}}가 CLAUDE.md와 에이전트 정의에 하나도 남지 않는다', () => {
  // 원본에는 네 자리표시자가 모두 있어야 이 시험이 의미 있다
  const source = readFileSync(join(harnessDir, 'coordinator.md'), 'utf8');
  for (const p of ['{{REPO}}', '{{ISSUES}}', '{{MEMO}}', '{{HARNESS}}']) assert.ok(source.includes(p), `원본 coordinator.md에 ${p}가 있다`);
  const run = runSetup();
  for (const f of ['CLAUDE.md', '.claude/agents/advisor.md', '.claude/settings.json', 'harness.json']) {
    const text = readFileSync(join(run, f), 'utf8');
    assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, f);
  }
  const claude = readFileSync(join(run, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.includes(REPO));
  assert.ok(claude.replace(/\\/g, '/').includes(join(run, 'issues').replace(/\\/g, '/')));
});

test('T3: 개인 경로·이메일·사용자 이름이 설치 결과에 정해진 값으로 박히지 않는다(경로는 실행 폴더·하네스 폴더에서만 온다)', () => {
  const run = runSetup();
  const cfg = JSON.parse(readFileSync(join(run, 'harness.json'), 'utf8'));
  const fwdRun = run.replace(/\\/g, '/');
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'designatedRepo' || k === 'projectName') continue; // 경로가 아닌 값
    assert.ok(String(v).replace(/\\/g, '/').startsWith(fwdRun) || String(v).replace(/\\/g, '/').includes('/harness'), `${k}=${v}`);
  }
  assert.doesNotMatch(readFileSync(join(harnessDir, 'setup.mjs'), 'utf8'), /@(gmail|naver|users\.noreply)\.|C:\/Users\/[a-z]/i);
});

test('T3: --refresh는 규칙·에이전트·설정만 다시 쓰고 클론과 기록은 건드리지 않는다(전후 해시 비교)', () => {
  const g = fakeGh();
  const run = join(mkdtempSync(join(tmpdir(), 'setup-')), 'run');
  assert.equal(setupWith(run, [], { ...g.env, FAKE_VIS: 'PRIVATE' }).status, 0);
  // 클론·기록·로그·하달 폴더에 사용자 상태를 만든다
  writeFileSync(join(run, 'issues', 'records', 'memo.md'), '# 기록 문서: memo\n\n사용자 기록\n');
  writeFileSync(join(run, 'issues', 'notes.md'), 'keep');
  mkdirSync(join(run, 'handoffs', 'h1'), { recursive: true });
  writeFileSync(join(run, 'handoffs', 'h1', 'session.json'), '{}');
  writeFileSync(join(run, 'logs', 'a.log'), 'x');
  writeFileSync(join(run, 'guard.log'), 'line\n');
  // 규칙·에이전트·설정은 낡게 만든다
  for (const f of ['CLAUDE.md', '.claude/agents/advisor.md', '.claude/settings.json']) writeFileSync(join(run, f), 'stale');
  const keep = ['issues', 'memo', 'handoffs', 'logs'];
  const before = Object.fromEntries(keep.map((d) => [d, walk(join(run, d))]));
  const guardBefore = readFileSync(join(run, 'guard.log'), 'utf8');
  const callsBefore = readFileSync(g.log, 'utf8');
  const headBefore = spawnSync('git', ['-C', join(run, 'issues'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout;

  const r = setupWith(run, ['--refresh'], { ...g.env, FAKE_VIS: 'PUBLIC' });
  assert.equal(r.status, 0, r.stderr);
  for (const d of keep) assert.deepEqual(walk(join(run, d)), before[d], `${d}는 그대로여야 한다`);
  assert.equal(readFileSync(join(run, 'guard.log'), 'utf8'), guardBefore);
  assert.equal(spawnSync('git', ['-C', join(run, 'issues'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout, headBefore);
  assert.equal(readFileSync(g.log, 'utf8'), callsBefore, '--refresh는 gh를 부르지 않는다');
  for (const f of ['CLAUDE.md', '.claude/agents/advisor.md', '.claude/settings.json']) assert.notEqual(readFileSync(join(run, f), 'utf8'), 'stale', f);
});

test('T3: 지정 저장소가 PRIVATE가 아니면 아무것도 쓰지 않고 종료 코드 2로 끝난다', () => {
  for (const vis of ['PUBLIC', 'INTERNAL', '']) {
    const g = fakeGh();
    const parent = mkdtempSync(join(tmpdir(), 'setup-'));
    const run = join(parent, 'run');
    const r = setupWith(run, [], { ...g.env, FAKE_VIS: vis });
    assert.equal(r.status, 2, `${vis}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /PRIVATE가 아니다/);
    assert.ok(!existsSync(run), `${vis}: 실행 폴더가 만들어지지 않았다`);
    assert.deepEqual(readdirSync(parent), [], `${vis}: 상위 폴더에도 아무것도 없다`);
    assert.doesNotMatch(readFileSync(g.log, 'utf8'), /clone|label/, `${vis}: 클론·라벨 호출 없음`);
    assert.equal(r.stdout, '');
  }
});

test('T3: 공개 여부를 확인하지 못해도(gh 실패) 아무것도 쓰지 않고 종료 코드 2로 끝난다', () => {
  const g = fakeGh();
  const parent = mkdtempSync(join(tmpdir(), 'setup-'));
  const run = join(parent, 'run');
  const r = setupWith(run, [], { ...g.env, FAKE_VIS: 'PRIVATE', FAKE_VIEW_FAIL: '1' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /확인하지 못해/);
  assert.deepEqual(readdirSync(parent), []);
});

test('T3: 비어 있지 않은 실행 폴더에는 설치하지 않는다(종료 코드 1)', () => {
  const run = runSetup();
  const before = walk(run);
  const r = setupWith(run, ['--no-clone'], process.env);
  assert.equal(r.status, 1);
  assert.deepEqual(walk(run), before);
});

// 이슈 #19: --project로 자기 대상 프로젝트를 지정한다.
function makeProject(name, { branch = 'main', commit = true } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'proj-')), name);
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  spawnSync('git', ['init', '-q', '-b', branch, dir]);
  if (commit) {
    writeFileSync(join(dir, 'app.txt'), 'hello\n');
    g('add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'init');
  }
  return dir;
}
const setupProject = (run, project, extra = []) => spawnSync(process.execPath, [join(harnessDir, 'setup.mjs'), '--run', run, '--repo', REPO, '--no-clone', '--project', project, ...extra], { encoding: 'utf8' });
const freshRun = () => join(mkdtempSync(join(tmpdir(), 'setup-')), 'run');

test('#19: --project는 지정한 git 저장소를 실행 폴더에 복제하고 원래 저장소와의 연결을 끊는다', () => {
  const src = makeProject('shop-api');
  const head = spawnSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const run = freshRun();
  const r = setupProject(run, src);
  assert.equal(r.status, 0, r.stderr);
  const config = JSON.parse(readFileSync(join(run, 'harness.json'), 'utf8'));
  assert.equal(config.projectName, 'shop-api');
  assert.match(config.targetProject, /\/run\/shop-api$/);
  assert.ok(!existsSync(join(run, 'memo')), '메모 예제는 만들지 않는다');
  assert.equal(spawnSync('git', ['-C', join(run, 'shop-api'), 'rev-parse', 'main'], { encoding: 'utf8' }).stdout.trim(), head);
  assert.equal(spawnSync('git', ['-C', join(run, 'shop-api'), 'remote'], { encoding: 'utf8' }).stdout.trim(), '', 'origin이 남지 않는다');
  const claude = readFileSync(join(run, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.includes('records/shop-api.md') && !claude.includes('records/memo.md'));
  assert.ok(claude.includes('- 영역: shop-api'));
  assert.ok(existsSync(join(run, 'issues', 'records', 'shop-api.md')));
  assert.match(readFileSync(join(run, 'issues', 'advisors.md'), 'utf8'), /\| advisor \| shop-api \|/);
  assert.equal(spawnSync('git', ['-C', src, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim(), '', '원래 저장소는 그대로');
});

test('#19: 옵션이 없으면 지금처럼 메모 예제를 쓴다', () => {
  const run = runSetup();
  const config = JSON.parse(readFileSync(join(run, 'harness.json'), 'utf8'));
  assert.equal(config.projectName, 'memo');
  assert.ok(readFileSync(join(run, 'CLAUDE.md'), 'utf8').includes('records/memo.md'));
});

test('#19: 없는 경로, git이 아닌 폴더, main 없는 저장소, 쓸 수 없는 이름은 아무것도 쓰지 않고 종료 코드 1', () => {
  const plain = join(mkdtempSync(join(tmpdir(), 'proj-')), 'plain');
  for (const p of [join(tmpdir(), 'no-such-project-' + Date.now()), (writeFileSync(join(dirname(plain), 'x'), ''), dirname(plain)), makeProject('dev-only', { branch: 'dev' }), makeProject('issues'), makeProject('empty', { commit: false })]) {
    const run = freshRun();
    const r = setupProject(run, p);
    assert.equal(r.status, 1, `${p}: ${r.stderr}`);
    assert.ok(!existsSync(run), `${p}: 실행 폴더를 만들지 않는다`);
  }
});

test('#19: --refresh는 지정했던 대상 프로젝트 이름을 유지하고 --project와 함께 쓸 수 없다', () => {
  const src = makeProject('shop-api');
  const run = freshRun();
  assert.equal(setupProject(run, src).status, 0);
  writeFileSync(join(run, 'CLAUDE.md'), 'stale');
  const r = spawnSync(process.execPath, [join(harnessDir, 'setup.mjs'), '--run', run, '--repo', REPO, '--refresh'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(join(run, 'CLAUDE.md'), 'utf8').includes('records/shop-api.md'));
  assert.equal(JSON.parse(readFileSync(join(run, 'harness.json'), 'utf8')).projectName, 'shop-api');
  assert.equal(setupProject(run, src, ['--refresh']).status, 1);
});
