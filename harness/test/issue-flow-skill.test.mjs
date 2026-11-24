// 결정 8-32, workflow.md 부록 A·B: 코디네이터 대화 자체(묻는 횟수)는 스크립트로 시험할 수 없다.
// 그래서 스킬·규칙에 정해진 문장이 들어 있는지 본다(S1·S2·S5·S7·S10·S11의 "묻는 자리"). 스크립트 동작은 github-flow.test.mjs가 본다.
// setup --refresh가 새 스킬을 실행 폴더에 복사하는지도 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(harnessDir, p), 'utf8').replace(/\r\n/g, '\n');
const flow = read('coordinator/skills/coordinator-issue-flow/SKILL.md');
const agent = read('coordinator/AGENT.md');
const steps = (text) => [...text.matchAll(/^(\d+)\. \*\*([^*]+):\*\*/gm)].map((m) => [Number(m[1]), m[2]]);

test('coordinator-issue-flow: 10단계, 시작·끝 두 번만 묻는다', () => {
  assert.deepEqual(steps(flow).map(([n]) => n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(steps(flow).map(([, t]) => t), ['지시 판단', '조언', '계획 승인', '이슈', '하달', '리뷰·이슈 PR', '하달 PR·CI', '예외', '끝 보고', '트레인']);
  assert.match(flow, /## 사용자에게 묻는 것은 시작·끝 두 번만/);
  assert.match(flow, /그 사이\(4~8단계\)에는 묻지 않는다/);
  for (const s of ['coordinator-direct', 'coordinator-advice', 'coordinator-issues', 'coordinator-handoff', 'coordinator-review', 'coordinator-exceptions', 'coordinator-records', 'coordinator-reflect']) assert.ok(flow.includes(`\`${s}\``), s);
  assert.match(flow, /기존 스킬의 규칙과 부딪히면 기존 스킬을 따른다/);
});

test('S1: 계획 승인은 한 번, 끝 보고에 트레인 승인 질문', () => {
  assert.match(flow, /3\. \*\*계획 승인:\*\*[^\n]*\*\*한 번\*\* 묻는다/);
  assert.match(flow, /9\. \*\*끝 보고:\*\*[^\n]*"결정할 것"\(트레인 승인/);
  assert.match(read('coordinator/skills/coordinator-records/SKILL.md'), /\*\*트레인 승인:\*\* "`run-train --handoffs/);
  assert.match(agent, /## 결정할 것\n1\. <트레인 승인/);
  assert.match(agent, /\| 이슈 \| 상태 \| 담당 팀 \| 하달 \| 이슈 PR \| 하달 PR \| CI \|/);
});

test('S2: 애매한 지시는 조언 전에 한 번 묻고, 답 전에는 이슈·하달 없음', () => {
  assert.match(flow, /1\. \*\*지시 판단:\*\*[^\n]*조언 전에 여기서만 바로 묻는다[^\n]*답이 오기 전에는 이슈도 하달도 만들지 않는다/);
});

test('S4·S5: CI 실패·거부 한도 초과는 묻지 않고 처리해 끝 보고에. 나머지 이슈는 계속', () => {
  const ex = read('coordinator/skills/coordinator-exceptions/SKILL.md');
  assert.match(ex, /## 실행 중에는 멈춰 묻지 않는다 \(결정 8-32\)/);
  assert.match(ex, /\| 거부 한도 초과 \| `run-operator`가 `거부목록`으로 두고 뺀다\. 나머지 이슈는 계속한다 \| 이슈와 마지막 거부 이유 \|/);
  assert.match(ex, /\| 이슈 PR·하달 PR CI 실패 \| `push-branch`가 관련 이슈를 `미완료`로[^|]*재작업\(재작업 한도 안\) \| 한도를 넘었을 때만 \|/);
  assert.match(ex, /3개가 쌓여도 작업 흐름 중에는 멈춰 묻지 않고/);
  assert.match(agent, /작업 흐름\(위 "작업 흐름 \(결정 8-32\)"\) 중에는 1번 조건\(3개\)이 와도 멈춰 묻지 않는다/);
  // "다른 모델로 한 번 더"는 아직 코드가 없다: 문서가 그렇게 밝힌다
  assert.match(ex, /다른 워커 모델로 한 번 더 시키는 길은 아직 없다/);
});

test('S6·S7: 트레인 실패는 부분 머지를 묻고, 승인이 없으면 run-train을 부르지 않는다(규칙이 지킨다)', () => {
  const rf = read('coordinator/skills/coordinator-reflect/SKILL.md');
  assert.match(rf, /승인 없이는 아무것도 부르지 않는다: 하달 PR은 열린 채, `main`은 그대로 둔다\(훅은 승인 여부를 모른다\. 이 규칙이 지킨다\)/);
  assert.match(rf, /1이면 스스로 부분 머지하지 않는다/);
  assert.match(flow, /승인하지 않으면 부르지 않는다: 하달 PR은 열린 채, `main`은 그대로다/);
  assert.match(agent, /\*\*트레인은 사용자가 승인한 뒤에만\*\*[^\n]*훅은 승인 여부를 모른다: 이 규칙이 지킨다\(`run-reflect`와 같다\)/);
});

test('S8: 원격·워크플로 없는 대상은 로컬 흐름과 "CI 없음"', () => {
  assert.match(flow, /\| 4 \| 대상 원격·워크플로 없음 \| 로컬 흐름[^|]*"CI 없음" \|/);
  assert.match(agent, /\*\*대상 원격이나 워크플로가 없으면\*\*[^\n]*"CI 없음"/);
});

test('S10: 주관적 지시는 대리 기준으로 진행, 끝 보고에 바꾼 기준과 원래 목표', () => {
  assert.match(flow, /주관적인 기준은 묻지 않고 대리 기준으로 바꾼다\(결정 8-27\)\. 바꾼 기준과 원래 목표는 끝 보고의 "결정할 것"에 적는다/);
  assert.match(read('coordinator/skills/coordinator-exceptions/SKILL.md'), /\| 주관적 기준 \| 결정 8-27대로 대리 기준으로 바꿔 진행 \| 바꾼 기준과 원래 목표 \|/);
});

test('S11: "#<번호> 맡겨" 입구는 그 이슈만 하달부터 끝 보고까지', () => {
  assert.match(flow, /`#<번호> 맡겨`: 이미 있는 이슈 하나만 맡는다\. 그 이슈만 5단계\(하달\)부터 시작해 끝 보고까지 간다/);
});

test('규칙: 권한 절에 두 스크립트, 직접 push·gh pr·gh workflow는 훅이 막는다고 적는다', () => {
  assert.match(agent, /`node \{\{HARNESS\}\}\/operator\/push-branch\.mjs --branch <h<N>\/issue-<번호> \| integration\/h<N>>`/);
  assert.match(agent, /`node \{\{HARNESS\}\}\/operator\/run-train\.mjs --handoffs h<N>\[,h<M>\.\.\.\]` \(머지 트레인 시작: 사용자가 트레인을 승인한 뒤에만/);
  assert.match(agent, /직접 `git push`, `gh pr`, `gh workflow`, `gh run`, `gh api`는 훅이 막는다/);
  const op = read('operator/skills/operator-work/SKILL.md');
  assert.match(op, /이 세션은 대상 저장소 원격에 올리지 않는다/);
  assert.match(read('operator/skills/operator-reflect/SKILL.md'), /run-train\.mjs --handoffs/);
});

test('setup --refresh가 새 스킬(coordinator-issue-flow)을 실행 폴더에 채워 복사한다', { timeout: 60000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-skill-'));
  try {
    const run = join(root, 'run');
    const first = spawnSync(process.execPath, [join(harnessDir, 'setup.mjs'), '--run', run, '--repo', 'owner/harness-issues', '--no-clone'], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    rmSync(join(run, '.claude', 'skills', 'coordinator-issue-flow'), { recursive: true, force: true });
    const r = spawnSync(process.execPath, [join(harnessDir, 'setup.mjs'), '--run', run, '--repo', 'owner/harness-issues', '--refresh'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const f = join(run, '.claude', 'skills', 'coordinator-issue-flow', 'SKILL.md');
    assert.ok(existsSync(f));
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /\{\{[A-Z]+\}\}/);
    assert.match(text, /operator\/push-branch\.mjs --branch h<N>\/issue-<번호>/);
    assert.match(r.stdout, /\.claude\/skills\/coordinator-issue-flow\/SKILL\.md/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('결정 8-34: 맡기기·반복 요청은 끝나는 조건과 예상 결과를 묻고 다듬어 승인받은 뒤 시작한다', () => {
  for (const w of ['끝나는 조건', '예상 결과', '`/goal`', '`/loop`', '분명한 승인', '계획 승인과 **한 번에**', '5단계 전에', '결정 8-34']) assert.ok(flow.includes(w), `스킬에 "${w}"`);
  assert.match(agent, /맡기기·반복 요청.*끝나는 조건과 예상 결과를 묻고 다듬어 승인받는다\(결정 8-34\)/);
});
