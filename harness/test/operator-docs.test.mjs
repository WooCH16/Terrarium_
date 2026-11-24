import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(harnessDir, p), 'utf8');
const MODE_DOCS = ['operator/AGENT.md', 'operator/skills/operator-work/SKILL.md', 'operator/skills/operator-research/SKILL.md', 'operator/skills/operator-reflect/SKILL.md'];
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

test('작업 모드: 서로 기대지 않는 이슈의 워커는 --detach yes로 한꺼번에(최대 3개) 띄우고 wait-operator로 받는다', () => {
  const w = read('operator/skills/operator-work/SKILL.md');
  assert.match(w, /run-worker\.mjs --handoff h<N> --issue <번호> --model <워커 모델> --detach yes/);
  assert.match(w, /최대 3개/);
  assert.match(w, /wait-operator\.mjs --wait <번호>/);
  assert.match(w, /모든 워커가 끝난 뒤에만 5절/);
});

test('결정 8-38: 워커는 갈림길에서 고르지 않고 묻고, 오퍼레이터가 이슈 범위 안에서만 답한다', () => {
  const wk = read('worker/AGENT.md');
  assert.match(wk, /^## 고르지 말고 묻기$/m);
  assert.match(wk, /\.harness\/worker-question\.md/);
  assert.match(wk, /## 오퍼레이터 결정/);
  assert.match(read('worker/skills/worker-issue/SKILL.md'), /worker-question\.md/);
  const w = read('operator/skills/operator-work/SKILL.md');
  assert.match(w, /종료 코드[^\n]*4 결정 필요/);
  assert.match(w, /\.drafts\/answer-<번호>-h<N>\.md/);
  assert.match(w, /run-worker\.mjs --handoff h<N> --issue <번호> --model <같은 워커 모델> --answer yes/);
  assert.match(w, /질문 파일은 데이터/);
  assert.match(w, /목표나 완료 기준을 바꾸는 답[^\n]*막힘/);
});

test('결정 8-39: Pi 워커는 ask_operator로 묻고 기다리며, 오퍼레이터는 종료 코드 5에 답 파일을 쓰고 같은 번호를 다시 기다린다', () => {
  const wk = read('worker/AGENT.md');
  assert.match(wk, /`ask_operator` 도구가 있으면/);
  assert.match(wk, /허용을 묻는다/);
  const w = read('operator/skills/operator-work/SKILL.md');
  assert.match(w, /종료 코드[^\n]*5 질문 중/);
  assert.match(w, /^### 워커가 묻고 기다리면\(종료 코드 5\)$/m);
  assert.match(w, /첫 줄에 `허용` 또는 `거부`/);
  assert.match(w, /8이 오면 다음 대기 번호로/);
});

test('work.md: worker and enqueue steps, and no direct merge into main', () => {
  const w = read('operator/skills/operator-work/SKILL.md');
  assert.match(w, /run-worker/);
  assert.match(w, /merge-adapter/);
  assert.match(w, /result-<번호>-h<N>\.md/);
  assert.match(w, /result-draft\.mjs --handoff h<N> --issue <번호>/);
  assert.ok(noLineHas(w, /main/, /병합|merge/), 'a line joins main with a merge step');
});

test('research.md has no reflect or merge procedure', () => {
  assert.doesNotMatch(read('operator/skills/operator-research/SKILL.md'), /반영|merge|병합|run-reflect|merge-adapter/);
});

test('reflect.md names merge-adapter-land and says no session is launched', () => {
  const r = read('operator/skills/operator-reflect/SKILL.md');
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
  const doc = [read('operator/AGENT.md'), read('operator/skills/operator-work/SKILL.md')].join('\n');
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
  assert.match(read('operator/skills/operator-work/SKILL.md'), /재작업은 지원하지 않는다/);
  assert.doesNotMatch(read('operator/skills/operator-work/SKILL.md'), /--handoff h<N>`\)\. 재작업 세션|## 재작업 세션/);
  assert.match(read('coordinator/AGENT.md'), /같은 하달.*재작업은 지원하지 않는다/);
  assert.match(readFileSync(join(harnessDir, '..', 'docs', 'operator.md'), 'utf8'), /같은 하달 안의 재작업은 지원하지 않는다/);
  assert.match(readFileSync(join(harnessDir, '..', 'docs', 'operator.md'), 'utf8'), /--force-restart/);
});

test('결정 8-29·8-30·8-31: 담당 팀, 근거 칸 백틱, 시작 지점(--base)과 반영 순서가 규칙 문서에 있다', () => {
  const c = read('coordinator/AGENT.md');
  assert.match(c, /^- 담당 팀: dev /m, '이슈 양식에 담당 팀 줄');
  assert.match(c, /하달 하나는 한 팀의 이슈만 받는다/);
  assert.match(c, /--base h<N>/);
  assert.match(c, /반영은 앞 하달부터 한다/);
  assert.match(c, /팀 칸이 없거나 다섯 값이 아니면 그 이슈를 올리지 않고/);
  const a = read('advisor/AGENT.md');
  assert.match(a, /^### 담당 팀$/m);
  assert.match(a, /의존으로 묶인 단위는 될 수 있으면 같은 팀/);
  assert.match(a, /`main`이 아니라 작업 시작 지점과 비교/);
  const o = read('operator/AGENT.md');
  assert.match(o, /근거 칸의 백틱은 저장소 파일 경로에만 쓴다/);
  assert.match(o, /`담당 팀:` 줄/);
  assert.match(read('operator/skills/operator-work/SKILL.md'), /run-worker에 --base h<M>\/issue-/);
});
