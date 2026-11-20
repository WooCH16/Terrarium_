import { test } from 'node:test';
import { withMixedRunners } from './helpers/mixed-runners.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const smoke = join(dirname(fileURLToPath(import.meta.url)), '..', 'operator', 'e2e', 'smoke.mjs');
const temps = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'smoke-test-')); temps.push(d); return d; };
// 기본 설정은 훅이 걸린 워커가 없다(ADR 0009). 판정 논리는 claude CLI 워커가 있는 시험용 설정으로 시험한다.
const mixedConfig = (() => { const d = mkdtempSync(join(tmpdir(), 'smoke-cfg-')); const f = join(d, 'operator.config.json'); writeFileSync(f, JSON.stringify(withMixedRunners(JSON.parse(readFileSync(join(dirname(smoke), '..', 'operator.config.json'), 'utf8'))))); return f; })();
const sh = (args, opts = {}) => spawnSync(process.execPath, [smoke, ...args], { encoding: 'utf8', ...opts, env: { ...process.env, HARNESS_SMOKE_CONFIG: mixedConfig, ...(opts.env ?? {}) } });
test.after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

test('--dry: every accident a-e is denied, table + result file, exit 0', () => {
  const run = tmp();
  const out = join(tmp(), 'result.md');
  const r = sh(['--run', run, '--dry', '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.match(r.stdout, new RegExp(`^\| ${id}\.`, 'm'), `row ${id}`);
  assert.match(r.stdout, /claude/);
  for (const m of ['gemini', 'muse']) assert.match(r.stdout, new RegExp(m));
  assert.match(r.stdout, /미확인/);
  assert.ok(existsSync(out));
  const md = readFileSync(out, 'utf8');
  assert.match(md, /미확인/);
  assert.doesNotMatch(md + r.stdout, /ghp_A{36}/, 'fake token text must not be echoed');
});

test('--dry: unconfirmed models are not counted as passes', () => {
  const r = sh(['--run', tmp(), '--dry', '--out', join(tmp(), 'r.md')]);
  const rows = r.stdout.split('\n').filter((l) => /^\| [a-e]\./.test(l));
  assert.equal(rows.length, 5);
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    assert.equal(cells.filter((c) => c === '미확인').length, 2, row);
    assert.equal(cells.filter((c) => c === '거부').length, 1, row);
  }
  assert.match(r.stdout, /통과 5\b/);
  assert.match(r.stdout, /미확인 10\b/);
});

test('--dry: exit 1 when a guard allows an attempt', () => {
  const stub = join(tmp(), 'allow-all.mjs');
  writeFileSync(stub, 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));');
  const r = sh(['--run', tmp(), '--dry', '--out', join(tmp(), 'r.md'), '--guard', stub]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /허용/);
});

test('--dry: a guard that denies everything fails the allow-control (exit 1)', () => {
  const stub = join(tmp(), 'deny-all.mjs');
  writeFileSync(stub, 'process.stderr.write("[하네스 가드] 거부: x\n"); process.exit(2);');
  const r = sh(['--run', tmp(), '--dry', '--out', join(tmp(), 'r.md'), '--guard', stub]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

const historyDir = join(dirname(smoke), '..', '..', '..', 'docs', 'history');
const smokeFiles = () => (existsSync(historyDir) ? readdirSync(historyDir).filter((f) => f.startsWith('operator-smoke-')) : []);

test('--dry with --out writes only there: docs/history gets no new smoke file', () => {
  const before = smokeFiles();
  const out = join(tmp(), 'only-here.md');
  sh(['--run', tmp(), '--dry', '--out', out]);
  assert.ok(existsSync(out));
  assert.deepEqual(smokeFiles(), before);
});

// 진짜 guard를 감싸되, 표식이 든 입력만 다르게 답하는 가짜 guard(변이 시험용)
function wrapGuard(marker, mode) {
  const real = join(dirname(smoke), '..', '..', 'guard.mjs');
  const f = join(tmp(), 'wrap-guard.mjs');
  writeFileSync(f, `import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const input = readFileSync(0, 'utf8');
if (input.includes(${JSON.stringify(marker)})) {
  if (${JSON.stringify(mode)} === 'allow') process.exit(0);
  process.stderr.write('[하네스 가드] 거부: ' + ${JSON.stringify(mode)} + '\\n');
  process.exit(2);
}
const r = spawnSync(process.execPath, [${JSON.stringify(real)}, ...process.argv.slice(2)], { input, encoding: 'utf8' });
process.stderr.write(r.stderr);
process.exit(r.status);
`);
  return f;
}
const dryWith = (guard) => sh(['--run', tmp(), '--dry', '--out', join(tmp(), 'r.md'), '--guard', guard]);

test('mutation M1: worker git push allowed -> exit 1', () => {
  const r = dryWith(wrapGuard('git push', 'allow'));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /허용/);
});

test('mutation M2: body-file secret scan removed -> exit 1', () => {
  const r = dryWith(wrapGuard('--body-file', 'allow'));
  assert.equal(r.status, 1, r.stdout);
});

test('mutation M3: write-outside-worktree check removed -> exit 1', () => {
  const r = dryWith(wrapGuard('outside.txt', 'allow'));
  assert.equal(r.status, 1, r.stdout);
});

test('a denial for the wrong reason is not a pass (exit 1, reason shown)', () => {
  const r = dryWith(wrapGuard('git push', '판정 중 오류: boom'));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /판정 중 오류: boom/);
  const r2 = dryWith(wrapGuard('git push', '엉뚱한 규칙'));
  assert.equal(r2.status, 1, r2.stdout);
});

test('worker Bash allow-control: a guard that denies worker git status fails', () => {
  const r = dryWith(wrapGuard('git status', '엉뚱한 규칙'));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /대조/);
});

test('real guard: every attempt is denied by its intended rule (reasons appear in the result)', () => {
  const r = sh(['--run', tmp(), '--dry', '--out', join(tmp(), 'r.md')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /git push은 워커가 쓸 수 없는 git 하위 명령/);
});

const snapshot = (d) => {
  const out = {};
  const walk = (p) => {
    for (const n of readdirSync(p)) {
      const q = join(p, n);
      if (statSync(q).isDirectory()) { out[q] = 'dir'; walk(q); } else out[q] = readFileSync(q, 'utf8');
    }
  };
  walk(d);
  return out;
};

test('--dry never writes into the folder given by --run', () => {
  const run = tmp();
  mkdirSync(join(run, 'issues', '.drafts'), { recursive: true });
  writeFileSync(join(run, 'issues', '.drafts', 'bad.md'), 'keep me');
  writeFileSync(join(run, 'harness.json'), '{"keep":1}');
  const before = snapshot(run);
  const r = sh(['--run', run, '--dry', '--out', join(tmp(), 'r.md')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(snapshot(run), before);
});

test('--dry does not need --run', () => {
  assert.equal(sh(['--dry', '--out', join(tmp(), 'r.md')]).status, 0);
});

test('argument handling: modes are required and exclusive', () => {
  assert.equal(sh([]).status, 2);
  assert.equal(sh(['--run', tmp()]).status, 2);
  assert.equal(sh(['--run', tmp(), '--dry', '--live']).status, 2);
  assert.equal(sh(['--run', tmp(), '--dry', '--bogus']).status, 2);
});

test('--live refuses without --run, without harness.json, without --issues', () => {
  const noRun = sh(['--live', '--issues', '7,8']);
  assert.equal(noRun.status, 2);
  assert.match(noRun.stderr, /--run/);
  const noCfg = sh(['--live', '--run', tmp(), '--issues', '7,8', '--out', join(tmp(), 'r.md')]);
  assert.equal(noCfg.status, 2);
  assert.match(noCfg.stderr, /harness\.json/);
  const run = tmp();
  writeFileSync(join(run, 'harness.json'), '{}');
  const noIssues = sh(['--live', '--run', run, '--out', join(tmp(), 'r.md')]);
  assert.equal(noIssues.status, 2);
  assert.match(noIssues.stderr, /--issues/);
  const badIssues = sh(['--live', '--run', run, '--issues', 'x', '--out', join(tmp(), 'r.md')]);
  assert.equal(badIssues.status, 2);
});

test('--live refuses unless confirmed with --yes-spend-money (never launches a real session in tests)', () => {
  const run = tmp();
  writeFileSync(join(run, 'harness.json'), '{}');
  const r = sh(['--live', '--run', run, '--issues', '7,8', '--out', join(tmp(), 'r.md')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--yes-spend-money/);
});

test('M7: --dry는 저장소 이름을 실행 폴더의 harness.json(designatedRepo)이나 --repo에서 받고 하드코딩하지 않는다', () => {
  const run = tmp();
  writeFileSync(join(run, 'harness.json'), JSON.stringify({ designatedRepo: 'someone/else-issues' }));
  const r = sh(['--run', run, '--dry', '--out', join(tmp(), 'r.md')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const r2 = sh(['--run', tmp(), '--repo', 'a/b', '--dry', '--out', join(tmp(), 'r.md')]);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  const src = readFileSync(smoke, 'utf8');
  assert.doesNotMatch(src, /WooCH16/);
});
