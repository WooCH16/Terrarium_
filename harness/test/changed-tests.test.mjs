// 바뀐 파일에 닿는 시험 고르기(scripts/changed-tests.mjs). docs/plan-ci-merge-queue.md의 대응 규칙을 지킨다.
// 가릴 수 없으면 전체다. 사례는 실제로 깨졌던 조합을 넣는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectTests, changedFiles } from '../../scripts/changed-tests.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pick = (...changed) => selectTests(changed, { root });
const has = (r, ...names) => { for (const n of names) assert.ok(r.all || r.tests.includes(`${n}.test.mjs`), `${n}이 빠짐: ${r.reason} ${r.tests.join(',')}`); };

test('모듈이 바뀌면 그 모듈을 불러 쓰는 시험(간접 포함)을 고른다', () => {
  has(pick('harness/operator/run-worker.mjs'), 'skills', 'worker-doc', 'run-worker', 'operator-worker');
  has(pick('harness/operator/decision.mjs'), 'owner-decision', 'operator-rework');
  const r = pick('harness/operator/decision.mjs');
  assert.equal(r.all, false);
  assert.ok(!r.tests.includes('jev.test.mjs'), '닿지 않는 시험은 고르지 않는다');
});

test('문서는 건너뛰지 않는다: 읽는 시험을 고른다', () => {
  has(pick('harness/worker/AGENT.md'), 'skills', 'worker-doc');
  has(pick('harness/reviewer/AGENT.md'), 'reviewer-doc', 'run-reviewer');
  has(pick('harness/coordinator/AGENT.md'), 'rules', 'config', 'skills');
  has(pick('docs/01-overview.md'), 'rules');
  has(pick('docs/operator.md'), 'operator-docs');
  assert.equal(pick('docs/operator.md').all, false);
});

test('공용 파일, 설정, 시험 도우미, 스크립트, CI, 모르는 경로는 전체', () => {
  for (const p of ['harness/operator/protocol.mjs', 'harness/operator/report.mjs', 'harness/policy.mjs', 'harness/operator/operator.config.json', 'harness/coordinator.config.json',
    'harness/test/helpers/cli-trap.mjs', 'scripts/test.mjs', '.github/workflows/ci.yml', 'package.json', 'app/package.json', 'harness/fixtures/memo/cli.mjs', 'something/new.bin', 'harness/operator/removed-module.mjs']) {
    assert.equal(pick(p).all, true, p);
  }
  assert.equal(pick('docs/operator.md', 'harness/operator/protocol.mjs').all, true, '하나라도 전체면 전체');
});

test('시험 파일 하나는 그 파일만, 지운 시험 파일과 루트 문서는 시험이 없고, 앱은 앱 시험', () => {
  assert.deepEqual(pick('harness/test/jev.test.mjs'), { all: false, tests: ['jev.test.mjs'], app: false, reason: '' });
  assert.deepEqual(pick('harness/test/gone.test.mjs', 'CHANGELOG.md'), { all: false, tests: [], app: false, reason: '' });
  const a = pick('app/lib/terminal.mjs');
  assert.equal(a.app, true);
  assert.equal(a.all, false);
});

test('바뀐 파일을 알 수 없으면 전체: git 실패, 빈 목록', () => {
  assert.equal(changedFiles('no-such-ref', () => { throw new Error('bad ref'); }), null);
  assert.equal(selectTests(null, { root }).all, true);
  assert.equal(selectTests([], { root }).all, true);
  const calls = [];
  const git = (args) => { calls.push(args.join(' ')); return args[0] === 'merge-base' ? 'abc\n' : args[0] === 'diff' ? 'a.md\0b\\c.mjs\0' : 'new.txt\0'; };
  assert.deepEqual(changedFiles('origin/x', git), ['a.md', 'b/c.mjs', 'new.txt']);
  assert.match(calls[1], /^diff --name-only --no-renames -z abc$/);
});

test('CI: main이 아닌 PR은 바뀐 부분만, main PR과 push는 전체. 작업 이름은 그대로', () => {
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(ci, /^  check:$/m);
  assert.match(ci, /^  harness-unit:$/m);
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /if: github\.event_name == 'pull_request' && github\.base_ref != 'main'\n(.*\n){0,3}.*--changed "origin\/\$BASE_REF"/);
  assert.equal((ci.match(/if: github\.event_name != 'pull_request' \|\| github\.base_ref == 'main'/g) ?? []).length, 2);
});

test('역할 문서를 말하는 시험은 모두 문서 시험 목록에 있다(새 시험이 빠지지 않게)', async () => {
  const { ROLE_DOC_TESTS } = await import('../../scripts/changed-tests.mjs');
  const { readdirSync } = await import('node:fs');
  const dir = join(root, 'harness', 'test');
  const missing = readdirSync(dir).filter((f) => f.endsWith('.test.mjs') && f !== 'changed-tests.test.mjs' && /AGENT\.md|SKILL\.md/.test(readFileSync(join(dir, f), 'utf8')))
    .map((f) => f.replace('.test.mjs', '')).filter((n) => !ROLE_DOC_TESTS.includes(n));
  assert.deepEqual(missing, []);
  has(pick('harness/advisor/AGENT.md'), 'operator-docs', 'advisor');
});

test('설명 속 이름만으로는 잇지 않고, jev-review는 리뷰어 시험에 닿는다', () => {
  has(pick('harness/operator/jev-review.mjs'), 'run-reviewer', 'reviewer-doc');
  has(pick('harness/operator/profiles.mjs'), 'operator-policy', 'policy');
  assert.ok(!pick('harness/operator/decision.mjs').tests.includes('changed-tests.test.mjs'));
});
