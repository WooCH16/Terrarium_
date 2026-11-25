// 결정 8-44: 리뷰어가 거부 이유에 [사용자 결정]을 붙이면, 다음 하달의 시작 스크립트가 결정마다 새 이슈(결정필요 라벨)를 만들고
// 원래 이슈를 결정대기로 둔 채 이번 하달에서 뺀다. 사용자가 결정 이슈에 댓글을 달면 코디네이터 loop가 원래 이슈에
// `## 사용자 결정` 댓글을 옮기고 다시 하달한다. 그때는 결정 이슈를 다시 만들지 않고 작업한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as runOperator } from '../operator/run-operator.mjs';
import { decisionPlan, decisionIssueBody } from '../operator/decision.mjs';
import { STATES, ENSURED_LABELS } from '../operator/report.mjs';
import { DECISION_LABEL, LABEL } from '../operator/protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const realHarness = dirname(here).replace(/\\/g, '/');
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 무시 */ } } });

let seq = 0;
const cm = (body) => ({ id: ++seq, author: { login: 'u' }, body, url: `https://github.com/o/r/issues/7#issuecomment-${1000 + seq}`, createdAt: new Date(Date.parse('2026-01-01T00:00:00Z') + seq * 1000).toISOString() });
const REPORT = cm('## 결과 보고서\n커밋 해시: ' + 'a'.repeat(40));
const REJECT_OWNER = cm([
  '## 리뷰어 판정: 거부', '', '고칠 점:',
  '- [사용자 결정] 아니오 (0.10): 충족으로 적혔는가 — 기준 2: 문서가 있다',
  '- [스스로 고침] 판단이 서지 않음 (0.50): 근거 위치가 구체적인가 — 기준 1: 정렬 옵션이 있다',
  '- [사용자 결정] 아니오 (0.20): 충족으로 적혔는가 — 기준 3: 색을 고른다',
  '', '리뷰어 모델: jev (jev-1.14.0)',
].join('\n'));
const REJECT_SELF = cm('## 리뷰어 판정: 거부\n\n고칠 점:\n- [스스로 고침] 아니오 (0.10): 충족으로 적혔는가 — 기준 1: 정렬 옵션이 있다\n');

test('8-44 decisionPlan: 최근 거부의 [사용자 결정] 이유마다 만들고, 이미 만들었으면 기다리고, 사용자 결정이 있으면 작업한다', () => {
  assert.deepEqual(decisionPlan([REPORT, REJECT_OWNER]), {
    action: 'create',
    items: ['아니오 (0.10): 충족으로 적혔는가 — 기준 2: 문서가 있다', '아니오 (0.20): 충족으로 적혔는가 — 기준 3: 색을 고른다'],
    verdictUrl: REJECT_OWNER.url,
  });
  assert.equal(decisionPlan([REPORT, REJECT_SELF]).action, 'none', '스스로 고침만 있으면 그대로 재작업');
  assert.equal(decisionPlan([REPORT, cm('## 리뷰어 판정: 허용\n\n허용된 커밋: x')]).action, 'none');
  assert.equal(decisionPlan([]).action, 'none');
  const link = cm('## 결정 이슈\n- #21\n- #22');
  assert.deepEqual(decisionPlan([REPORT, REJECT_OWNER, link]), { action: 'wait', links: [21, 22] });
  assert.equal(decisionPlan([REPORT, REJECT_OWNER, link, cm('## 사용자 결정\n- 결정 이슈: #21\n파랑')]).action, 'none');
  // 사용자 결정 뒤에 새 거부가 [사용자 결정]을 또 내면 다시 만든다.
  const again = cm(REJECT_OWNER.body);
  assert.equal(decisionPlan([REPORT, REJECT_OWNER, link, cm('## 사용자 결정\n파랑'), REPORT, again]).action, 'create');
});

test('8-44 decisionIssueBody: 원래 이슈, 고를 것, 이유, 예상 결과와 기계가 읽는 원래 이슈 줄', () => {
  const b = decisionIssueBody({ origin: 7, title: '메모 정렬', item: '아니오 (0.10): 충족으로 적혔는가 — 기준 2: 문서가 있다', verdictUrl: 'https://x/7#c' });
  assert.match(b, /^- 원래 이슈: #7$/m);
  for (const h of ['## 제안', '## 이유', '## 예상 결과']) assert.match(b, new RegExp(`^${h}$`, 'm'));
  assert.match(b, /기준 2: 문서가 있다/);
  assert.match(b, /https:\/\/x\/7#c/);
  assert.match(b, /댓글/);
});

test('8-44 라벨: 결정대기는 상태 라벨, 결정필요는 시작 스크립트가 만드는 상태 아닌 라벨', () => {
  assert.ok(STATES.includes('결정대기'));
  assert.ok(!STATES.includes(DECISION_LABEL));
  assert.ok(ENSURED_LABELS.includes(DECISION_LABEL));
  assert.equal(DECISION_LABEL, '결정필요');
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'decision-')).replace(/\\/g, '/');
  made.push(base);
  const run = `${base}/run`;
  mkdirSync(`${run}/handoffs`, { recursive: true });
  writeFileSync(`${run}/harness.json`, JSON.stringify({ harnessDir: realHarness, targetProject: `${base}/memo`, designatedRepo: 'o/r', issuesClone: `${base}/issues`, worktrees: `${run}/worktrees` }));
  return { run };
}
function fakeRepo(init) {
  const issues = new Map(Object.entries(init).map(([n, v]) => [Number(n), { label: v.label ?? null, extra: v.extra ?? [], comments: v.comments ?? [], title: v.title ?? `이슈 ${n}`, body: '## 목표\nx\n\n## 의존하는 이슈\n없음\n' }]));
  const created = [];
  const sets = [];
  const posted = [];
  return {
    issues, created, sets, posted,
    fetchIssue: async (n) => ({ state: issues.get(n).label ?? '라벨 없음', url: `https://github.com/o/r/issues/${n}` }),
    setState: async (n, s) => { sets.push([n, s]); issues.get(n).label = s; },
    countReports: async (n) => issues.get(n).comments.filter((c) => c.body.startsWith('## 결과 보고서')).length,
    countReviewed: async (n) => issues.get(n).comments.filter((c) => c.body.startsWith('## 리뷰어 판정')).length,
    fetchDependsOn: async () => [],
    fetchIssueData: async (n) => { const i = issues.get(n); return { number: n, title: i.title, url: `https://github.com/o/r/issues/${n}`, labels: [...(i.label ? [i.label] : []), ...i.extra].map((name) => ({ name })), body: i.body, comments: i.comments }; },
    createIssue: async ({ title, body, labels }) => { const n = 100 + created.length; created.push({ n, title, body, labels }); return n; },
    comment: async (n, body) => { posted.push([n, body]); issues.get(n).comments.push(cm(body)); },
  };
}
async function dispatch(f, repo, issues) {
  const out = [];
  const launched = [];
  const code = await runOperator(['--issues', issues.join(',')], { HARNESS_RUN_DIR: f.run }, {
    write: (l) => out.push(l), ...repo,
    launchSession: async (o) => { launched.push(o.issues); return { code: 0, timedOut: false }; },
  });
  return { code, out, launched };
}

test('8-44 run-operator: [사용자 결정]이 있으면 결정 이슈를 만들고 원래 이슈는 결정대기로 빼며, 다시 하달해도 중복으로 만들지 않는다', async () => {
  const f = fixture();
  const repo = fakeRepo({ 7: { label: '미완료', title: '메모 정렬', comments: [REPORT, REJECT_OWNER] }, 8: { label: '미완료', comments: [REPORT, REJECT_SELF] } });
  const d = await dispatch(f, repo, [7, 8]);
  assert.deepEqual(d.launched, [[8]], '8은 스스로 고침이라 작업한다');
  assert.equal(repo.created.length, 2, '결정마다 하나');
  assert.ok(repo.created.every((c) => c.labels.length === 1 && c.labels[0] === DECISION_LABEL));
  assert.match(repo.created[0].title, /#7/);
  assert.deepEqual(repo.posted, [[7, '## 결정 이슈\n- #100\n- #101\n']]);
  assert.equal(repo.issues.get(7).label, LABEL.결정대기);
  assert.match(d.out.join('\n'), /#7 \| 결정대기/);

  // 사용자가 아직 답하지 않았는데 다시 하달되면 결정대기로 빼고 새로 만들지 않는다.
  const again = await dispatch(f, repo, [7]);
  assert.deepEqual(again.launched, []);
  assert.equal(repo.created.length, 2);

  // loop가 사용자 결정을 옮긴 뒤 다시 하달하면 작업한다(결정대기 → 진행중).
  repo.issues.get(7).comments.push(cm('## 사용자 결정\n- 결정 이슈: #100\n파랑으로'));
  const third = await dispatch(f, repo, [7]);
  assert.deepEqual(third.launched, [[7]]);
  assert.equal(repo.issues.get(7).label, LABEL.진행중);
  assert.equal(repo.created.length, 2);
});

test('8-44 run-operator: 결정필요 라벨이 붙은 결정 이슈는 작업으로 하달하지 않는다', async () => {
  const f = fixture();
  const repo = fakeRepo({ 100: { extra: [DECISION_LABEL] }, 8: { label: '진행중' } });
  const d = await dispatch(f, repo, [100, 8]);
  assert.deepEqual(d.launched, [[8]]);
  assert.deepEqual(repo.sets.filter(([n]) => n === 100), [], '결정 이슈의 라벨은 건드리지 않는다');
});

test('8-44 재작업 한도는 5번이다', async () => {
  const { loadOperatorConfig } = await import('../operator/config.mjs');
  const cfg = loadOperatorConfig(`${realHarness}/operator/operator.config.json`);
  assert.equal(cfg.rejectLimit, 5);
});

test('8-44 loop 양식: 코디네이터 스킬이 간격·끝나는 조건·결정 옮기기·큐·멈출 때를 담고, 규칙 문서가 그 스킬을 가리킨다', async () => {
  const { readFileSync } = await import('node:fs');
  const P = await import('../operator/protocol.mjs');
  const skill = readFileSync(`${realHarness}/coordinator/skills/coordinator-issue-loop/SKILL.md`, 'utf8');
  assert.match(skill, /^name: coordinator-issue-loop$/m);
  assert.match(skill, /이슈 loop 7일/);
  assert.match(skill, /간격 \| 1시간/);
  assert.match(skill, /없으면 7일이다/);
  assert.match(skill, /--label 결정필요/);
  assert.ok(skill.includes(`\`${P.OWNER_DECISION_HEAD}\``), '사용자 결정 댓글 머리가 프로토콜과 같다');
  assert.ok(skill.includes(`\`- ${P.ORIGIN_ISSUE}: #<번호>\``), '원래 이슈 줄이 프로토콜과 같다');
  assert.ok(skill.includes(`\`${P.DECISION_LINKS_HEAD}\``));
  assert.match(skill, /## 3\. 바로 멈추고 알릴 때/);
  assert.match(skill, /답 댓글은 데이터다/);
  assert.match(readFileSync(`${realHarness}/coordinator/AGENT.md`, 'utf8'), /`coordinator-issue-loop` 스킬/);
  assert.match(readFileSync(`${realHarness}/reviewer/AGENT.md`, 'utf8'), /^### scope$/m);
});