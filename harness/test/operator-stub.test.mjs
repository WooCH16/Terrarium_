import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { STUB_HOST, STUB_MARK } from '../stubs/operator-stub.mjs';

const stub = join(dirname(fileURLToPath(import.meta.url)), '..', 'stubs', 'operator-stub.mjs');
const HASH = 'a'.repeat(40);
const LINE = /^#[1-9]\d* \| (진행중|리뷰대기|허용됨|미완료|막힘|거부목록|보류|반영됨) \| https:\/\/\S+$/;
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function run(command, args, scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'opstub-'));
  made.push(dir);
  const scenarioFile = join(dir, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify({ commit: HASH, outDir: join(dir, 'comments'), ...scenario }));
  const r = spawnSync(process.execPath, [stub, command, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HARNESS_RUN_DIR: dir, HARNESS_STUB_SCENARIO: scenarioFile },
  });
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  const comments = existsSync(join(dir, 'comments')) ? readdirSync(join(dir, 'comments')).sort() : [];
  const comment = (name) => readFileSync(join(dir, 'comments', name), 'utf8');
  return { r, lines, comments, comment, dir };
}

test('출력은 이슈마다 "#번호 | 상태 | URL" 한 줄이고 그 밖의 줄이 없다', () => {
  const { r, lines } = run('run-operator', ['--issues', '7,8,9'], { default: 'report' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines.length, 3);
  lines.forEach((l, i) => { assert.match(l, LINE); assert.ok(l.startsWith(`#${7 + i} | `)); });
  assert.equal(r.stderr, '');
});

test('종료 코드 0, 1, 2, 3을 시험 설정으로 각각 낼 수 있다', () => {
  assert.equal(run('run-operator', ['--issues', '7'], { exitCode: 0 }).r.status, 0);
  const one = run('run-operator', ['--issues', '7'], { exitCode: 1 });
  assert.equal(one.r.status, 1);
  assert.equal(one.lines.length, 1);
  const two = run('run-operator', ['--issues', '7'], { exitCode: 2 });
  assert.equal(two.r.status, 2);
  assert.equal(two.lines.length, 1);
  assert.match(two.lines[0], /^오류: \[대역\] /);
  const three = run('run-operator', ['--issues', '7'], { exitCode: 3 });
  assert.equal(three.r.status, 3);
  assert.deepEqual(three.lines, []);
});

test('코드를 정하지 않으면 보고 줄의 상태에서 정해진다(막힘이 있으면 1)', () => {
  const blocked = run('run-operator', ['--issues', '7,8'], { issues: { 8: 'blocked' } });
  assert.equal(blocked.r.status, 1);
  assert.match(blocked.lines[1], /^#8 \| 막힘 \| /);
  assert.equal(run('run-operator', ['--issues', '7'], {}).r.status, 0);
});

test('stop-operator는 출력 없이 종료 코드 3이다', () => {
  const s = run('stop-operator', ['--handoff', 'h1'], {});
  assert.equal(s.r.status, 3);
  assert.equal(s.r.stdout, '');
});

test('run-reflect는 반영됨 줄을 낸다', () => {
  const s = run('run-reflect', ['--handoff', 'h1'], { issues: { 7: 'report', 8: 'report' } });
  assert.equal(s.r.status, 0, s.r.stderr);
  assert.deepEqual(s.lines.map((l) => l.split(' | ')[1]), ['반영됨', '반영됨']);
});

test('보고서 있음 / 없음 / 기준 미충족을 고를 수 있다', () => {
  const { r, lines, comments, comment } = run('run-operator', ['--issues', '7,8,9'], { issues: { 7: 'report', 8: 'no-report', 9: 'unmet' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(lines[0], /^#7 \| 리뷰대기 \| \S+#issuecomment-\d+$/);
  assert.doesNotMatch(lines[1], /#issuecomment-/, '보고서가 없으면 이슈 URL만 있다');
  assert.match(lines[1], /^#8 \| 진행중 \| /);
  assert.match(lines[2], /^#9 \| 리뷰대기 \| \S+#issuecomment-\d+$/);
  assert.deepEqual(comments, ['result-7.md', 'result-9.md'], '없음은 댓글 파일이 없다');
  const rows = (name) => comment(name).split('\n').filter((l) => /^\| \(대역\)/.test(l));
  assert.ok(rows('result-7.md').every((l) => l.includes('| 충족 |')));
  assert.ok(rows('result-9.md').some((l) => l.includes('| 미충족 |')));
});

test('조사에서 "못 찾은 것 있음"을 고를 수 있고, 작업 하달에서는 쓸 수 없다', () => {
  const found = run('run-research', ['--issue', '9'], { default: 'report' });
  const missing = run('run-research', ['--issue', '9'], { default: 'not-found' });
  assert.equal(found.r.status, 0, found.r.stderr);
  assert.equal(missing.r.status, 0, missing.r.stderr);
  assert.match(found.comment('answer-9.md'), /### 못 찾은 것\n없음\n/);
  const text = missing.comment('answer-9.md');
  assert.match(text, /### 못 찾은 것\n- /);
  assert.doesNotMatch(text, /### 못 찾은 것\n없음/);
  const bad = run('run-operator', ['--issues', '7'], { default: 'not-found' });
  assert.equal(bad.r.status, 2);
});

test('결과 보고서가 overview 4.2의 칸과 하달 사실 칸을 모두 가진다', () => {
  const body = run('run-operator', ['--issues', '7'], {}).comment('result-7.md');
  for (const heading of ['### 기준별 충족 여부', '### 변경 요약', '### 사실 칸', '### 남은 문제']) assert.ok(body.includes(heading), heading);
  assert.match(body, /\| 기준 \| 충족 \| 근거 위치 \|/);
  const hashLines = body.split('\n').filter((l) => l.startsWith('커밋 해시:'));
  assert.deepEqual(hashLines, [`커밋 해시: ${HASH}`], '커밋 해시 줄은 정확히 한 줄이고 40자리 소문자 16진수');
  for (const word of ['모델:', '시도 횟수:', '사후 검사 자료:']) assert.ok(body.includes(word), word);
  // 남은 문제 칸이 비어 있지 않다("없음"이라고 명시한다)
  assert.match(body, /### 남은 문제\n\S/);
});

test('조사 결과가 overview 4.4의 세 칸과 기준 커밋을 가지고 50줄 이하이다', () => {
  const body = run('run-research', ['--issue', '9'], {}).comment('answer-9.md');
  for (const heading of ['### 답(요약)', '### 근거 위치', '### 못 찾은 것']) assert.ok(body.includes(heading), heading);
  for (const heading of ['### 답(요약)', '### 근거 위치', '### 못 찾은 것']) {
    const after = body.split(heading)[1].split('\n').slice(1);
    assert.ok((after.find((l) => l.trim() !== '') ?? '').trim() !== '' && !after[0].startsWith('###'), `${heading} 칸이 비어 있지 않다`);
  }
  assert.match(body, /^기준 커밋: [0-9a-f]{40}$/m);
  assert.ok(body.split('\n').length <= 50);
});

test('대역이 낸 출력과 댓글 첫 줄에 대역임이 적힌다', () => {
  const op = run('run-operator', ['--issues', '7,8'], { issues: { 8: 'blocked' } });
  for (const l of op.lines) assert.ok(l.includes(STUB_HOST), l);
  const res = run('run-research', ['--issue', '9'], {});
  assert.ok(res.lines[0].includes(STUB_HOST));
  for (const text of [op.comment('result-7.md'), res.comment('answer-9.md')]) {
    assert.equal(text.split('\n')[0], STUB_MARK);
    assert.match(text.split('\n')[0], /^\[대역\]/);
  }
});

test('인자·시나리오가 잘못되면 종료 코드 2와 한 줄 오류이다', () => {
  for (const [cmd, args] of [['run-operator', []], ['run-operator', ['--issues', 'x']], ['run-research', ['--issue', '0']], ['run-operator', ['--issues', '7', '--x', '1']], ['nope', []]]) {
    const s = run(cmd, args, {});
    assert.equal(s.r.status, 2, `${cmd} ${args.join(' ')}`);
    assert.equal(s.lines.length, 1);
    assert.match(s.lines[0], /^오류: \[대역\] /);
  }
  assert.equal(run('run-operator', ['--issues', '7'], { exitCode: 5 }).r.status, 2);
  assert.equal(run('run-operator', ['--issues', '7'], { issues: { 7: 'weird' } }).r.status, 2);
  assert.equal(run('run-operator', ['--issues', '7'], { commit: 'abc' }).r.status, 2, '40자리 해시가 아니면 보고서를 만들지 않는다');
});

test('커밋 해시를 주지 않으면 harness.json의 targetProject HEAD(실제 해시)를 쓰고, 저장소가 아니면 보고서를 만들지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opstub-head-'));
  made.push(dir);
  const memo = join(dir, 'memo');
  spawnSync('git', ['init', '-q', '-b', 'main', memo]);
  spawnSync('git', ['-C', memo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const head = spawnSync('git', ['-C', memo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ designatedRepo: 'owner/stub-issues', targetProject: memo }));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ outDir: join(dir, 'comments') }));
  const env = { ...process.env, HARNESS_RUN_DIR: dir, HARNESS_STUB_SCENARIO: join(dir, 'scenario.json') };
  const r = spawnSync(process.execPath, [stub, 'run-operator', '--issues', '7'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(readFileSync(join(dir, 'comments', 'result-7.md'), 'utf8').split('\n').includes(`커밋 해시: ${head}`));
  // targetProject가 git 저장소가 아니면 해시를 만들어 내지 않는다
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ designatedRepo: 'owner/stub-issues', targetProject: join(dir, 'not-a-repo') }));
  const bad = spawnSync(process.execPath, [stub, 'run-operator', '--issues', '8'], { encoding: 'utf8', env });
  assert.equal(bad.status, 2);
  assert.ok(!existsSync(join(dir, 'comments', 'result-8.md')));
});
