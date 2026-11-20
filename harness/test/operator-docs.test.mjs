import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(harnessDir, p), 'utf8');
const MODE_DOCS = ['operator/AGENT.md', 'operator/work.md', 'operator/research.md', 'operator/reflect.md'];
const noLineHas = (text, a, b) => text.split('\n').every((l) => !(a.test(l) && b.test(l)));

test('mode docs exist and contain no unfilled {{...}} placeholders', () => {
  for (const p of MODE_DOCS) {
    assert.ok(existsSync(join(harnessDir, p)), p);
    assert.doesNotMatch(read(p), /\{\{[^}\n]*\}\}/, p);
  }
});

test('no result file name contains "report" (test run 4 lesson)', () => {
  for (const p of MODE_DOCS) assert.doesNotMatch(read(p), /[^\s`'"]*report[^\s`'"]*\.md/i, p);
});

test('work.md: worker and enqueue steps, and no direct merge into main', () => {
  const w = read('operator/work.md');
  assert.match(w, /run-worker/);
  assert.match(w, /merge-adapter/);
  assert.match(w, /result-<번호>-h<N>\.md/);
  assert.match(w, /result-draft\.mjs --handoff h<N> --issue <번호>/);
  assert.ok(noLineHas(w, /main/, /병합|merge/), 'a line joins main with a merge step');
});

test('research.md has no reflect or merge procedure', () => {
  assert.doesNotMatch(read('operator/research.md'), /반영|merge|병합|run-reflect|merge-adapter/);
});

test('reflect.md names merge-adapter-land and says no session is launched', () => {
  const r = read('operator/reflect.md');
  assert.match(r, /merge-adapter-land/);
  assert.match(r, /run-reflect/);
  assert.match(r, /세션을 (띄우지|시작하지) 않/);
});

test('AGENT.md states the residual risk and the reflect-only main rule', () => {
  const a = read('operator/AGENT.md');
  assert.match(a, /샌드박스가 아니다/);
  assert.match(a, /사후/);
  assert.ok(a.split('\n').some((l) => /main/.test(l) && /반영 모드/.test(l)), 'AGENT.md must tie main to reflect mode on one line');
});

test('AGENT.md carries the shared rules (secrets, names, facts, pre-start review, rejection)', () => {
  const a = read('operator/AGENT.md');
  for (const word of ['비밀값', 'h<N>/issue-<번호>', 'integration/h<N>', '사실 칸', '시작 전 검토', '미완료']) {
    assert.ok(a.includes(word), word);
  }
});

test('report format: first line ## 결과 보고서 and one 커밋 해시 line (40 hex)', () => {
  const doc = [read('operator/AGENT.md'), read('operator/work.md')].join('\n');
  assert.match(doc, /## 결과 보고서/);
  assert.match(doc, /커밋 해시: <40자리 소문자 16진수>/);
});

test('coordinator lists the four script shapes and sends research through run-research', () => {
  const c = read('coordinator/AGENT.md');
  for (const shape of ['run-operator.mjs --issues', 'run-research.mjs --issue', 'run-reflect.mjs --handoff', 'stop-operator.mjs --handoff']) {
    assert.ok(c.includes(shape), shape);
  }
  assert.match(c, /이슈를 올리고[^\n]*run-research/);
});

test('coordinator spawns only advisor (ADR 0004: reviewer is not a subagent); operator agent file is gone', () => {
  const c = read('coordinator/AGENT.md');
  assert.match(c, /advisor만 부를 수 있다/);
  assert.doesNotMatch(c, /advisor, reviewer만/);
  assert.doesNotMatch(c, /subagent_type[^\n]*operator|오퍼레이터 하위 에이전트/);
  assert.ok(!existsSync(join(harnessDir, 'agents', 'operator.md')));
});

test('issue template has a ## 의존하는 이슈 section', () => {
  assert.match(read('coordinator/AGENT.md'), /^## 의존하는 이슈$/m);
});

test('coordinator.md: 작업 이슈는 진행중 라벨로 올리고, 보고서 없음은 issuecomment URL 유무로 판단한다', () => {
  const c = read('coordinator/AGENT.md');
  assert.match(c, /--label 진행중/);
  assert.match(c, /#issuecomment-/);
});

test('I3: 같은 하달 재작업은 지원하지 않는다고 work.md·coordinator.md·docs/operator.md가 말한다', () => {
  assert.match(read('operator/work.md'), /재작업은 지원하지 않는다/);
  assert.doesNotMatch(read('operator/work.md'), /--handoff h<N>`\)\. 재작업 세션|## 재작업 세션/);
  assert.match(read('coordinator/AGENT.md'), /같은 하달.*재작업은 지원하지 않는다/);
  assert.match(readFileSync(join(harnessDir, '..', 'docs', 'operator.md'), 'utf8'), /같은 하달 안의 재작업은 지원하지 않는다/);
  assert.match(readFileSync(join(harnessDir, '..', 'docs', 'operator.md'), 'utf8'), /--force-restart/);
});
