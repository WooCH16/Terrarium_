import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { proposal, MODES, MARK, UNIT_FIELDS, parseProposal, missingFields, unverifiableCriteria, parseAdvisors, matchAdvisors } from '../stubs/advisor-stub.mjs';

const stubs = join(dirname(fileURLToPath(import.meta.url)), '..', 'stubs');
const read = (f) => readFileSync(join(stubs, f), 'utf8');

test('대역이 정상 / 부족 / 거부될 제안문을 골라 낼 수 있다', () => {
  assert.deepEqual(Object.keys(MODES), ['정상', '부족', '거부']);
  const texts = Object.keys(MODES).map((m) => proposal(m));
  assert.equal(new Set(texts).size, 3, '세 방식의 제안문이 서로 다르다');
  assert.throws(() => proposal('엉뚱'), /알 수 없는 방식/);
  // 명령줄로도 고를 수 있다
  for (const m of Object.keys(MODES)) {
    const r = spawnSync(process.execPath, [join(stubs, 'advisor-stub.mjs'), m], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, proposal(m));
  }
  assert.equal(spawnSync(process.execPath, [join(stubs, 'advisor-stub.mjs'), '엉뚱'], { encoding: 'utf8' }).status, 2);
});

test('제안문 첫 줄에 대역임이 적힌다', () => {
  for (const m of Object.keys(MODES)) assert.equal(proposal(m).split(/\r?\n/)[0], MARK, m);
});

test('정상 제안문: 작업 단위마다 목표, 완료 기준, 먼저 끝나야 할 것, 전제·위험을 가지고 기준마다 확인 방법이 있다', () => {
  const text = proposal('정상');
  const units = parseProposal(text);
  assert.equal(units.length, 2);
  for (const u of units) for (const f of UNIT_FIELDS) assert.ok(u.fields[f], `${u.title}: ${f}`);
  assert.deepEqual(missingFields(text), []);
  assert.deepEqual(unverifiableCriteria(text), []);
  assert.match(text, /\| 기준 \| 확인 방법 \|/);
});

test('부족한 제안문: 양식 항목이 빠진 작업 단위를 가려낼 수 있다', () => {
  const problems = missingFields(proposal('부족'));
  assert.ok(problems.some((p) => p.startsWith('작업 단위 1') && p.includes('전제·위험')), problems.join('|'));
  assert.ok(problems.some((p) => p.startsWith('작업 단위 2') && p.includes('먼저 끝나야 할 것')), problems.join('|'));
  assert.equal(problems.length, 2);
});

test('거부될 제안문: 양식은 갖췄지만 확인할 수 없는 기준이 있다', () => {
  const text = proposal('거부');
  assert.deepEqual(missingFields(text), []);
  const bad = unverifiableCriteria(text);
  assert.equal(bad.length, 2, bad.join('|'));
});

test('제안문이 아닌 글이나 빈 글은 문제로 가려낸다', () => {
  assert.deepEqual(missingFields('아무 말'), ['작업 단위가 없다']);
  assert.deepEqual(missingFields(''), ['작업 단위가 없다']);
});

test('어드바이저 목록 예시에서 영역이 맞는 어드바이저를 찾는다', () => {
  const list = read('advisors.example.md');
  const rows = parseAdvisors(list);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'advisor');
  assert.equal(rows[0].area, 'memo');
  assert.deepEqual(matchAdvisors(list, 'memo').map((a) => a.name), ['advisor']);
  assert.deepEqual(matchAdvisors(list, 'MEMO').map((a) => a.name), ['advisor']);
});

test('목록에 맞는 어드바이저가 없는 경우: 맞지 않는 영역과 빈 목록', () => {
  const list = read('advisors.example.md');
  assert.deepEqual(matchAdvisors(list, 'billing'), []);
  assert.deepEqual(matchAdvisors(list, ''), []);
  const empty = read('advisors.empty.md');
  assert.deepEqual(parseAdvisors(empty), []);
  assert.deepEqual(matchAdvisors(empty, 'memo'), []);
});

test('여러 영역을 아는 어드바이저와 겹치는 어드바이저는 모두 찾는다', () => {
  const list = [
    '| 이름 | 아는 영역 | 담당 범위 | 연결된 오퍼레이터 |', '|---|---|---|---|',
    '| a | memo, ui | x | op |', '| b | memo | y | op |', '| c | infra | z | op |',
  ].join('\n');
  assert.deepEqual(matchAdvisors(list, 'memo').map((a) => a.name), ['a', 'b']);
  assert.deepEqual(matchAdvisors(list, 'ui').map((a) => a.name), ['a']);
});

test('대역 에이전트 정의: advisor 이름, 읽기·전용 폴더 쓰기·조언 판정 명령, 세 파일을 가리킨다(ADR 0006)', () => {
  const def = read('advisor-stub.md');
  assert.match(def, /^name: advisor$/m);
  assert.match(def, /^tools: Read, Write, Bash$/m);
  assert.ok(def.includes('{{RUN}}/reviewer-inbox/<id>.md'));
  assert.ok(def.includes('없으면 `stub-<방식>`을 쓴다'), '코디네이터가 준 조언 id를 쓰고, 없을 때만 고정 id');
  assert.ok(def.includes('node {{HARNESS}}/operator/run-reviewer.mjs --advice {{RUN}}/reviewer-inbox/<id>.md --advice-id <id>'));
  assert.ok(def.includes('같은 파일, 같은 id로 한 번만'), '거부되면 한 번 더 판정받는다(시나리오 6·12)');
  for (const f of Object.values(MODES)) {
    assert.ok(def.includes(`stubs/proposals/${f}.md`), f);
    assert.ok(read(`proposals/${f}.md`).length > 0);
  }
});

// ---------- 대역을 advisor 자리에 설치한다(setup --advisor-stub) ----------
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const setupMjs = join(stubs, '..', 'setup.mjs');
const install = (extra) => {
  const run = join(mkdtempSync(join(tmpdir(), 'advstub-')), 'run');
  const r = spawnSync(process.execPath, [setupMjs, '--run', run, '--repo', 'owner/stub-issues', '--no-clone', ...extra], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(join(run, '.claude', 'agents', 'advisor.md'), 'utf8');
};

test('setup --advisor-stub은 advisor 자리에 대역을 설치하고, 없으면 실제 advisor 정의를 쓴다', () => {
  const stub = install(['--advisor-stub']);
  assert.ok(stub.includes('stubs/proposals/'));
  assert.doesNotMatch(stub, /\{\{[A-Z_]+\}\}/);
  assert.ok(!install([]).includes('stubs/proposals/'));
});
