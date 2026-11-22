// workflow.md 부록 B S14: 워크플로 틀(harness/github/workflows/) 검사.
// actionlint가 PATH에 있으면 돌린다. 없으면(이 저장소의 기본) 시작 조건·권한·입력·브랜치 모양·재사용 CI 호출을 문자열과 YAML 읽기로 확인하고,
// run: 스크립트는 bash -n으로 문법만 본다(bash가 있을 때). YAML 읽기는 앱의 js-yaml이 있을 때만 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(harnessDir, 'github', 'workflows');
const read = (n) => readFileSync(join(dir, n), 'utf8').replace(/\r\n/g, '\n');
const FILES = ['harness-issue-pr.yml', 'harness-handoff-pr.yml', 'harness-train.yml', 'harness-ci.yml'];
const yamlPath = join(harnessDir, '..', 'app', 'node_modules', 'js-yaml', 'index.js');
const yaml = existsSync(yamlPath) ? (await import(pathToFileURL(yamlPath).href)).default : null;

test('S14: 틀 네 개가 있고 그 밖의 파일은 없다', () => {
  assert.deepEqual(readdirSync(dir).sort(), [...FILES].sort());
});

test('S14: actionlint(있으면)', { skip: spawnSync('actionlint', ['-version']).status !== 0 && 'actionlint가 없어 문자열 검사로 대신한다' }, () => {
  const r = spawnSync('actionlint', FILES.map((f) => join(dir, f)), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('S14: 시작 조건이 문서와 같다(이슈 PR = h*/issue-* push, 하달 PR = integration/h* push, 트레인 = workflow_dispatch, CI = workflow_call)', () => {
  assert.match(read('harness-issue-pr.yml'), /^on:\n  push:\n    branches:\n      - 'h\*\/issue-\*'\n/m);
  assert.match(read('harness-handoff-pr.yml'), /^on:\n  push:\n    branches:\n      - 'integration\/h\*'\n/m);
  assert.match(read('harness-train.yml'), /^on:\n  workflow_dispatch:\n    inputs:\n      handoffs:\n/m);
  assert.match(read('harness-ci.yml'), /^on:\n  workflow_call:\n    inputs:\n      ref:\n/m);
  for (const f of FILES) assert.doesNotMatch(read(f), /pull_request_target|^\s+pull_request:/m, `${f}: PR 이벤트에 기대지 않는다`);
});

test('S14: 권한은 필요한 것만(contents·pull-requests write, CI는 contents read)', () => {
  for (const f of ['harness-issue-pr.yml', 'harness-handoff-pr.yml', 'harness-train.yml']) {
    assert.match(read(f), /^permissions:\n  contents: write\n  pull-requests: write\n\n/m, f);
    assert.doesNotMatch(read(f), /write-all|actions: write|administration|id-token/, f);
  }
  assert.match(read('harness-ci.yml'), /^permissions:\n  contents: read\n\n/m);
  assert.match(read('harness-ci.yml'), /persist-credentials: false/);
});

test('S14: 트레인 입력(handoffs, request)과 실행 이름, 브랜치 모양·main 빨리감기·부분 머지 없음', () => {
  const t = read('harness-train.yml');
  assert.match(t, /^run-name: harness-train \$\{\{ inputs\.request \}\}$/m);
  assert.match(t, /request:\n        description: [^\n]+\n        required: true\n        type: string/);
  assert.match(t, /TRAIN="train\/\$\(date -u \+%Y%m%d\)-\$RUN_NUMBER"/);
  assert.match(t, /git push origin "\$AFTER:refs\/heads\/main"/);
  assert.doesNotMatch(t, /--force|-f origin|\+refs|push -f/);
  assert.match(t, /HARNESS_TRAIN_RESULT \$1/);
  assert.match(t, /GITHUB_STEP_SUMMARY/);
  assert.match(t, /K=\$\(\(K - 1\)\)/, '맨 뒤부터 빼며 다시 돈다');
  assert.match(t, /concurrency:\n  group: harness-train\n/);
});

test('S14: 입력·브랜치 이름은 run:에 ${{ }}로 넣지 않고 env로 넘겨 정규식으로 검사한다', () => {
  for (const f of FILES) {
    const text = read(f);
    for (const block of text.split(/\n\s+run: \|\n/).slice(1)) {
      const body = block.split(/\n {0,6}- (name|uses):|\n {2}[a-z-]+:\n/)[0];
      assert.doesNotMatch(body, /\$\{\{/, `${f}: run: 스크립트 안에 \${{ }}가 있다`);
    }
    assert.doesNotMatch(text, /run: .*\$\{\{ (inputs|github\.(ref_name|head_ref|event))/, f);
  }
  assert.match(read('harness-issue-pr.yml'), /\^\(h\[1-9\]\[0-9\]\{0,8\}\)\/issue-\(\[1-9\]\[0-9\]\{0,8\}\)\$/);
  assert.match(read('harness-handoff-pr.yml'), /\^integration\/\(h\[1-9\]\[0-9\]\{0,8\}\)\$/);
  assert.match(read('harness-train.yml'), /\^h\[1-9\]\[0-9\]\{0,8\}\(,h\[1-9\]\[0-9\]\{0,8\}\)\{0,9\}\$/);
});

test('S14: PR 워크플로는 재사용 CI를 부르고, 본문에는 링크만(이슈 본문·판정 원문을 옮기지 않는다)', () => {
  for (const f of ['harness-issue-pr.yml', 'harness-handoff-pr.yml']) {
    assert.match(read(f), /uses: \.\/\.github\/workflows\/harness-ci\.yml\n    with:\n      ref: \$\{\{ needs\.open-pr\.outputs\.sha \}\}/, f);
    assert.match(read(f), /if: needs\.open-pr\.outputs\.skip != 'true'/, f);
    assert.doesNotMatch(read(f), /gh issue view|issues\/\$ISSUE\/comments|gh pr merge/, f);
  }
  assert.match(read('harness-issue-pr.yml'), /https:\/\/github\.com\/\$ISSUES_REPO\/issues\/\$ISSUE/);
  assert.match(read('harness-issue-pr.yml'), /ISSUES_REPO: '\{\{REPO\}\}'/, 'setup이 지정 저장소 이름을 채운다');
});

test('S14: YAML로 읽힌다(js-yaml이 있으면), 작업과 단계 모양', { skip: !yaml && 'js-yaml이 없다' }, () => {
  for (const f of FILES) {
    const doc = yaml.load(read(f));
    assert.equal(typeof doc.name, 'string', f);
    assert.ok(doc.on && doc.jobs, f);
  }
  const train = yaml.load(read('harness-train.yml'));
  assert.deepEqual(Object.keys(train.on.workflow_dispatch.inputs), ['handoffs', 'request']);
  assert.deepEqual(train.permissions, { contents: 'write', 'pull-requests': 'write' });
  const issue = yaml.load(read('harness-issue-pr.yml'));
  assert.deepEqual(issue.on.push.branches, ['h*/issue-*']);
  assert.equal(issue.jobs.ci.uses, './.github/workflows/harness-ci.yml');
});

// 결정 8-35: 옛 브랜치·PR 닫기. 지우기는 safe_delete 하나로만, 세 모양만(main 아님). 트레인은 main에 올린 뒤에만 지우고 실패 길에는 지우기가 없다.
const SAFE_RE = '^(h[1-9][0-9]{0,8}/issue-[1-9][0-9]{0,8}|integration/h[1-9][0-9]{0,8}|train/[0-9]{8}-[0-9]{1,9})$';
const hasBash = spawnSync('bash', ['--version']).status === 0;

test('8-35: 지우기는 safe_delete 하나로만, 세 브랜치 모양 정규식, 이슈 PR·트레인 워크플로에 닫기·지우기 단계', () => {
  for (const f of ['harness-issue-pr.yml', 'harness-train.yml']) {
    const t = read(f);
    assert.equal((t.match(/^\s+safe_delete\(\) \{$/gm) ?? []).length, 1, `${f}: safe_delete 정의 하나`);
    assert.equal((t.match(/-X DELETE/g) ?? []).length, 1, `${f}: 지우는 API 호출은 safe_delete 안의 하나뿐`);
    const def = t.slice(t.search(/^\s+safe_delete\(\) \{$/m));
    const fn = def.slice(0, def.indexOf('\n          }\n') + 1);
    assert.match(fn, /-X DELETE "repos\/\$REPO\/git\/refs\/heads\/\$b"/);
    assert.ok(fn.includes(`[ "$b" = "main" ] || [[ ! "$b" =~ ${SAFE_RE} ]]`), `${f}: 세 모양 정규식과 main 거부`);
    assert.doesNotMatch(t, /--delete-branch|git push [^\n]*--delete|git push [^\n]*:refs\/heads\/[^\n]*" *$/m, `${f}: 다른 지우기 길이 없다`);
    assert.doesNotMatch(t, /gh pr merge/, f);
  }
  for (const f of ['harness-handoff-pr.yml', 'harness-ci.yml']) assert.doesNotMatch(read(f), /safe_delete|-X DELETE|gh pr close/, `${f}: 닫기·지우기 없음`);
  const issue = read('harness-issue-pr.yml');
  assert.match(issue, /close-older:\n    needs: open-pr\n/);
  assert.match(issue, /gh pr close "\$num" --repo "\$REPO" --comment "h\$M에서 다시 함/);
  assert.match(issue, /\[ "\$\{BASH_REMATCH\[2\]\}" = "\$ISSUE" \] && \[ "\$\{BASH_REMATCH\[1\]\}" -lt "\$M" \]/, '같은 이슈, 앞선 하달만');
  const handoff = read('harness-handoff-pr.yml');
  assert.match(handoff, /FORCED: \$\{\{ github\.event\.forced \}\}/);
  assert.match(handoff, /if \[ "\$FORCED" = "true" \]; then\n\s+gh pr comment "\$NUM"/, '다시 만든 통합 브랜치: 하달 PR을 닫지 않고 댓글');
});

test('8-35: 트레인은 main push 성공 뒤에만 지우고, 실패 길에는 지우기가 없다', () => {
  const t = read('harness-train.yml');
  const mainPush = t.indexOf('if ! git push origin "$AFTER:refs/heads/main"; then');
  const success = t.slice(mainPush, t.indexOf('K=$((N - 1))'));
  const failure = t.slice(t.indexOf('K=$((N - 1))'));
  const head = t.slice(0, mainPush);
  assert.ok(mainPush > 0);
  assert.doesNotMatch(head.replace(/safe_delete\(\) \{[\s\S]*?\n          \}\n/, ''), /safe_delete "|gh pr close/, 'main push 전에는 지우지 않는다');
  assert.doesNotMatch(failure, /safe_delete|gh pr close|-X DELETE/, '실패 길에는 지우기가 없다');
  const emitAt = success.indexOf('emit "$(jq -cn --arg t "$TRAIN" --argjson m');
  const firstDelete = success.indexOf('safe_delete "');
  assert.ok(emitAt > 0 && firstDelete > emitAt, '결과 줄을 먼저 찍고 정리한다(정리 실패가 결과를 바꾸지 않는다)');
  assert.match(success, /safe_delete "integration\/\$h"/);
  assert.match(success, /safe_delete "\$TRAIN"\n\s+exit 0/);
  assert.doesNotMatch(t, /^\s+set -[a-z]*e/m, '트레인은 set -e가 없다(정리 실패로 끝나지 않는다)');
});

test('8-35: safe_delete를 bash로 돌려 보면 세 모양만 지우고 main·다른 브랜치는 지우지 않는다', { skip: (!yaml || !hasBash) && 'bash나 js-yaml이 없다' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wf-del-'));
  try {
    for (const f of ['harness-issue-pr.yml', 'harness-train.yml']) {
      const doc = yaml.load(read(f));
      const script = Object.values(doc.jobs).flatMap((j) => j.steps ?? []).map((s) => s.run ?? '').find((r) => r.includes('safe_delete() {'));
      const def = script.slice(script.indexOf('safe_delete() {'));
      const fn = def.slice(0, def.indexOf('\n}\n') + 3);
      const p = join(tmp, `${f}.sh`);
      writeFileSync(p, `REPO=o/r\ngh() { echo "CALL $*"; }\n${fn}\nfor b in "$@"; do safe_delete "$b"; done\n`);
      const names = ['main', 'refs/heads/main', 'feature/x', 'h1/issue-2', 'integration/h3', 'train/20261122-1', 'integration/main', 'h0/issue-1', 'h1/issue-1/x', 'train/x', 'main/x', 'h1/issue-1 main'];
      const r = spawnSync('bash', [p, ...names], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const deleted = r.stdout.split('\n').filter((l) => l.startsWith('CALL ')).map((l) => /refs\/heads\/(\S+)/.exec(l)[1]);
      assert.deepEqual(deleted, ['h1/issue-2', 'integration/h3', 'train/20261122-1'], f);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('8-35: close-older 단계를 가짜 gh로 bash에서 돌린다(같은 이슈의 앞선 하달만 닫고 지움, 빈 하달이면 integration/h<N>도, 뒤 하달·다른 이슈는 그대로)', { skip: (!yaml || !hasBash) && 'bash나 js-yaml이 없다' }, () => {
  const step = yaml.load(read('harness-issue-pr.yml')).jobs['close-older'].steps[0].run;
  const tmp = mkdtempSync(join(tmpdir(), 'wf-close-'));
  // 가짜 gh: 원격 브랜치 목록, 브랜치마다 열린 PR, 하달마다 남은 이슈 브랜치 수·열린 하달 PR 수를 흉내 낸다. 부른 것은 stdout에 CALL 줄로.
  const stub = `gh() {
  case "$*" in
    "api --paginate repos/o/r/git/matching-refs/heads/h --jq "*) printf '%s\\n' h1/issue-2 h2/issue-2 h3/issue-2 h4/issue-2 h1/issue-20 h2/issue-5 hotfix main-h ;;
    "pr list --repo o/r --head h1/issue-2 --state open --json number --jq .[].number") echo 11 ;;
    "pr list --repo o/r --head h2/issue-2 --state open --json number --jq .[].number") echo 12 ;;
    "pr list --repo o/r --head "*"--state open --json number --jq .[].number") ;;
    "api repos/o/r/git/matching-refs/heads/h1/issue- --jq length") echo 0 ;;
    "api repos/o/r/git/matching-refs/heads/h2/issue- --jq length") echo 1 ;;
    "pr list --repo o/r --head integration/h1 --state open --json number --jq length") echo 0 ;;
    "pr list --repo o/r --head integration/h2 --state open --json number --jq length") echo 0 ;;
    "pr close "*) echo "CALL close $3 $7" ;;
    "api -X DELETE "*) echo "CALL delete $4" ;;
    *) echo "CALL unknown $*" ;;
  esac
}
`;
  try {
    const p = join(tmp, 'close.sh');
    writeFileSync(p, `${stub}${step}`);
    const runIt = (branch) => spawnSync('bash', [p], { encoding: 'utf8', env: { ...process.env, REPO: 'o/r', BRANCH: branch } });
    const r = runIt('h3/issue-2');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const calls = r.stdout.split('\n').filter((l) => l.startsWith('CALL '));
    assert.deepEqual(calls, [
      'CALL close 11 h3에서 다시 함(이슈 #2, 결정 8-35)', 'CALL delete repos/o/r/git/refs/heads/h1/issue-2',
      'CALL close 12 h3에서 다시 함(이슈 #2, 결정 8-35)', 'CALL delete repos/o/r/git/refs/heads/h2/issue-2',
      'CALL delete repos/o/r/git/refs/heads/integration/h1',
    ]);
    // 앞선 하달이 없으면(빈 목록, set -u) 아무것도 하지 않고 성공
    const r2 = runIt('h1/issue-9');
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.stdout.split('\n').filter((l) => l.startsWith('CALL ')).length, 0);
    // 모양이 아니면 실패하고 아무것도 하지 않는다
    const r3 = runIt('main');
    assert.notEqual(r3.status, 0);
    assert.equal(r3.stdout.split('\n').filter((l) => l.startsWith('CALL ')).length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('S14: run: 스크립트가 bash 문법을 통과한다(bash -n)', { skip: (!yaml || spawnSync('bash', ['--version']).status !== 0) && 'bash나 js-yaml이 없다' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wf-bash-'));
  try {
    for (const f of FILES) {
      const doc = yaml.load(read(f));
      for (const [job, j] of Object.entries(doc.jobs)) {
        for (const [i, s] of (j.steps ?? []).entries()) {
          if (!s.run) continue;
          assert.doesNotMatch(s.run, /\$\{\{/, `${f} ${job} ${i}: run: 안의 \${{ }}`);
          const p = join(tmp, `${f}-${job}-${i}.sh`);
          writeFileSync(p, s.run);
          const r = spawnSync('bash', ['-n', p], { encoding: 'utf8' });
          assert.equal(r.status, 0, `${f} ${job} ${i}: ${r.stderr}`);
        }
      }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
