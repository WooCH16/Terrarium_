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
