// workflow.md 부록 B S15: setup의 워크플로 넣기. 동의하면 대상 저장소에 PR 하나만 만들고 main에는 쓰지 않는다. 거절하면 아무것도 쓰지 않고 로컬 흐름을 안내한다.
// 대상 저장소는 로컬 bare 저장소, gh는 가짜(helpers/fake-gh-actions.mjs)다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { workflowFiles } from '../github-workflows.mjs';

const here = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const setup = `${dirname(here)}/setup.mjs`;
const FAKE = `${here}/helpers/fake-gh-actions.mjs`;
const T = { timeout: 120000 };
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 무시 */ } } });
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();

function world() {
  const root = mkdtempSync(join(tmpdir(), 'setup-wf-')).replace(/\\/g, '/');
  made.push(root);
  const src = `${root}/src`;
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  writeFileSync(`${src}/a.txt`, 'a\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-q', '-m', 'init');
  const remote = `${root}/app.git`;
  git(root, 'clone', '-q', '--bare', src, remote);
  const stateFile = `${root}/gh.json`;
  writeFileSync(stateFile, JSON.stringify({ remote, target: 'owner/app', prs: [], calls: [] }));
  const env = { ...process.env, HARNESS_GH_BIN: FAKE, FAKE_GH_STATE: stateFile };
  const runSetup = (...args) => spawnSync(process.execPath, [setup, '--repo', 'owner/harness-issues', ...args], { encoding: 'utf8', env, input: '' });
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const refs = () => git(remote, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').sort();
  return { root, remote, runSetup, state, refs, mainSha: git(remote, 'rev-parse', 'refs/heads/main') };
}
const prCreates = (s) => s.calls.filter((c) => c[0] === 'pr' && c[1] === 'create');

test('S15: 동의(--add-workflows) → 브랜치 하나와 PR 하나, main은 그대로. harness.json에 대상 저장소', T, () => {
  const w = world();
  const run = `${w.root}/run`;
  const r = w.runSetup('--run', run, '--no-clone', '--target-repo', 'owner/app', '--target-remote', w.remote, '--add-workflows');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PR 하나를 만들었다\(main에는 쓰지 않았다/);
  assert.equal(git(w.remote, 'rev-parse', 'refs/heads/main'), w.mainSha);
  assert.deepEqual(w.refs().map((l) => l.split(' ')[0]), ['refs/heads/harness/add-workflows', 'refs/heads/main']);
  const files = git(w.remote, 'ls-tree', '--name-only', 'harness/add-workflows:.github/workflows').split('\n').sort();
  assert.deepEqual(files, ['harness-ci.yml', 'harness-handoff-pr.yml', 'harness-issue-pr.yml', 'harness-train.yml']);
  assert.match(git(w.remote, 'show', 'harness/add-workflows:.github/workflows/harness-issue-pr.yml'), /ISSUES_REPO: 'owner\/harness-issues'/);
  const s = w.state();
  assert.equal(prCreates(s).length, 1);
  assert.equal(s.prs.length, 1);
  assert.deepEqual([s.prs[0].headRefName, s.prs[0].baseRefName], ['harness/add-workflows', 'main']);
  const cfg = JSON.parse(readFileSync(`${run}/harness.json`, 'utf8'));
  assert.equal(cfg.targetRepo, 'owner/app');
  assert.equal(cfg.targetRemote, w.remote);
  // 같은 브랜치가 이미 있으면 다시 쓰지 않는다
  const again = w.runSetup('--run', run, '--refresh', '--add-workflows');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /이미 harness\/add-workflows 브랜치가 있어/);
  assert.equal(prCreates(w.state()).length, 1);
});

test('S15: 거절(--no-workflows)이나 묻지 못하는 실행(터미널 아님) → 대상 저장소에 아무것도 쓰지 않고 로컬 흐름 안내', T, () => {
  for (const flag of [['--no-workflows'], []]) {
    const w = world();
    const before = w.refs();
    const r = w.runSetup('--run', `${w.root}/run`, '--no-clone', '--target-repo', 'owner/app', '--target-remote', w.remote, ...flag);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /넣지 않았다\. 대상 저장소에는 아무것도 쓰지 않았다\. 로컬 흐름\(run-reflect\)/);
    assert.deepEqual(w.refs(), before);
    assert.equal(prCreates(w.state()).length, 0);
  }
});

test('S15: 대상 저장소가 없으면 넣지 않고, --refresh는 대상 저장소 칸을 이어받는다(나중에 --add-workflows로 넣기)', T, () => {
  const w = world();
  const run = `${w.root}/run`;
  const r = w.runSetup('--run', run, '--no-clone', '--add-workflows');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /대상 저장소\(--target-repo\)가 없어 넣지 않았다/);
  assert.equal(JSON.parse(readFileSync(`${run}/harness.json`, 'utf8')).targetRepo, undefined);
  const run2 = `${w.root}/run2`;
  assert.equal(w.runSetup('--run', run2, '--no-clone', '--target-repo', 'owner/app', '--target-remote', w.remote, '--no-workflows').status, 0);
  const ref = w.runSetup('--run', run2, '--refresh');
  assert.equal(ref.status, 0, ref.stderr);
  const cfg = JSON.parse(readFileSync(`${run2}/harness.json`, 'utf8'));
  assert.equal(cfg.targetRepo, 'owner/app');
  assert.equal(cfg.targetRemote, w.remote);
  const other = w.runSetup('--run', run2, '--refresh', '--target-repo', 'owner/other');
  assert.equal(other.status, 1);
  assert.match(other.stderr, /대상 저장소를 바꾸지 않는다/);
  const later = w.runSetup('--run', run2, '--refresh', '--add-workflows');
  assert.equal(later.status, 0, later.stderr);
  assert.equal(prCreates(w.state()).length, 1);
  assert.equal(git(w.remote, 'rev-parse', 'refs/heads/main'), w.mainSha);
});

test('S15: 인자 검사(대상 저장소 모양, 시험 명령, 자기 CI 파일 이름)는 아무것도 쓰기 전에 멈춘다', T, () => {
  const w = world();
  for (const args of [['--target-repo', 'bad'], ['--target-repo', 'owner/app', '--test-command', "npm test'; rm -rf /"], ['--target-repo', 'owner/app', '--ci-workflow', '../x.yml'],
    ['--target-remote', w.remote], ['--target-repo', 'owner/app', '--add-workflows', '--no-workflows']]) {
    const r = w.runSetup('--run', `${w.root}/r-${args.length}`, '--no-clone', ...args);
    assert.equal(r.status, 1, args.join(' '));
  }
  assert.equal(prCreates(w.state()).length, 0);
});

test('S15: 자기 CI를 쓰면 기본 CI 파일을 넣지 않고 uses:를 바꾼다. 시험 명령은 틀에 들어간다', () => {
  const own = workflowFiles({ designatedRepo: 'owner/harness-issues', ciWorkflow: 'ci.yml' });
  assert.deepEqual([...own.keys()].sort(), ['harness-handoff-pr.yml', 'harness-issue-pr.yml', 'harness-train.yml']);
  assert.match(own.get('harness-issue-pr.yml'), /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.doesNotMatch(own.get('harness-handoff-pr.yml'), /harness-ci\.yml/);
  const cmd = workflowFiles({ designatedRepo: 'o/r', testCommand: 'node --test' });
  assert.match(cmd.get('harness-ci.yml'), /vars\.HARNESS_TEST_COMMAND \|\| 'node --test'/);
  assert.match(cmd.get('harness-train.yml'), /vars\.HARNESS_TEST_COMMAND \|\| 'node --test'/);
  for (const t of cmd.values()) assert.doesNotMatch(t, /\{\{[A-Z]+\}\}/);
});
