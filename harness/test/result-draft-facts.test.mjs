// 결정 8-42: 결과 보고서 초안이 워커 기록(workers.jsonl)과 git에서 사실 칸을 미리 채운다.
// 기록으로 증명할 수 없는 칸(오퍼레이터 편집 여부, 완료가 아닐 때의 막힘 사유, 기록에 없는 대체 사유)은 빈칸(<...>)으로 둔다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { main as draftMain } from '../operator/result-draft.mjs';
import { reportProblems, issueCriteria } from '../operator/jev-review.mjs';

const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 무시 */ } } });

const BODY = ['## 목표', 'x', '', '## 완료 기준', '| 기준 | 확인 방법 |', '|---|---|', '| 정렬이 된다 | `node --test` |', '', '## 의존하는 이슈', '없음', ''].join('\n');
const H = (c) => c.repeat(40);
const TIP = H('a');
const BASE = H('b');
const MAIN = H('c');

function setup(events) {
  const run = fwd(mkdtempSync(`${fwd(tmpdir())}/draft-facts-`));
  made.push(run);
  mkdirSync(`${run}/issues`, { recursive: true });
  mkdirSync(`${run}/handoffs/h5`, { recursive: true });
  writeFileSync(`${run}/harness.json`, JSON.stringify({ designatedRepo: 'o/r', issuesClone: `${run}/issues`, targetProject: `${run}/memo` }));
  if (events) writeFileSync(`${run}/handoffs/h5/workers.jsonl`, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return run;
}
// 가짜 git: 이슈 브랜치 끝은 TIP, main은 MAIN, 그 사이 변경 파일은 두 개.
const calls = [];
const git = (args) => {
  calls.push(args);
  if (args[0] === 'rev-parse') return args.at(-1) === 'refs/heads/main' ? MAIN : TIP;
  if (args[0] === 'for-each-ref') return `${MAIN}\n${TIP}`;
  if (args[0] === 'diff') return 'src/memo.js\ntest/sort.test.mjs\n';
  throw new Error(`예상하지 못한 git: ${args.join(' ')}`);
};
async function draft(run, issue = 9) {
  const out = [];
  const code = await draftMain(['--handoff', 'h5', '--issue', String(issue)], { HARNESS_RUN_DIR: run }, { write: (l) => out.push(l), fetchBody: async () => BODY, git });
  assert.equal(code, 0, out.join());
  return readFileSync(out[0], 'utf8');
}
const line = (text, head) => text.split('\n').find((l) => l.startsWith(`- ${head}`));

test('8-42: 완료한 워커의 기록으로 모델·실제 워커 모델·시도 횟수·변경 파일·main 해시를 채운다', async () => {
  const run = setup([
    { event: 'start', issue: 9, requestedModel: 'claude', model: 'claude', base: 'main', baseCommit: BASE, mainBefore: MAIN },
    { event: 'end', issue: 9, attempts: 1, model: 'claude', status: '완료', actualModel: 'anthropic/x', mainAfter: MAIN },
  ]);
  const t = await draft(run);
  assert.equal(line(t, '모델:'), '- 모델: claude → claude (대체 없음)');
  assert.equal(line(t, '실제 워커 모델:'), '- 실제 워커 모델: claude', '러너 타입(model)이지 actualModel이 아니다');
  assert.equal(line(t, '시도 횟수:'), '- 시도 횟수: 1, 막힘 사유: 없음');
  assert.equal(line(t, '사후 검사 자료:'), `- 사후 검사 자료: 변경 파일 src/memo.js, test/sort.test.mjs; main 하달 시작 ${MAIN}, 지금 ${MAIN}; 오퍼레이터 편집 여부: <있음 또는 없음>`);
  assert.ok(calls.some((a) => a[0] === 'diff' && a.includes(BASE) && a.includes(TIP)), '변경 파일은 워커 시작 커밋과 이슈 브랜치 끝 사이');
  // 판정 칸만 채우면 리뷰어 코드 검사를 통과한다.
  const filled = t.replace('<충족 또는 미충족>', '충족').replace('<파일:줄, 테스트 이름, 명령과 결과>', '"node --test" 통과');
  assert.deepEqual(reportProblems({ report: filled, hash: TIP, criteria: issueCriteria(BODY), fileExists: () => true }), []);
});

test('8-42: 대체가 기록돼 있으면 사유를 쓰고, 질문으로 두 번 부른 워커는 시도를 더한다', async () => {
  const run = setup([
    { event: 'start', issue: 9, requestedModel: 'gemini', model: 'claude', replacedFrom: 'gemini', replacedReason: 'gemini CLI 없음', base: 'main', baseCommit: BASE, mainBefore: MAIN },
    { event: 'end', issue: 9, attempts: 1, model: 'claude', status: '결정필요' },
    { event: 'start', issue: 9, requestedModel: 'gemini', model: 'claude', replacedFrom: 'gemini', replacedReason: 'gemini CLI 없음', base: 'main', baseCommit: BASE, mainBefore: MAIN },
    { event: 'end', issue: 9, attempts: 2, model: 'claude', status: '완료' },
  ]);
  const t = await draft(run);
  assert.equal(line(t, '모델:'), '- 모델: gemini → claude (대체 사유: gemini CLI 없음)');
  assert.equal(line(t, '시도 횟수:'), '- 시도 횟수: 3, 막힘 사유: 없음');
});

test('8-42: 증명할 수 없는 칸은 빈칸으로 둔다(막힌 워커, 사유 없는 대체, 옛 기록)', async () => {
  const blocked = await draft(setup([
    { event: 'start', issue: 9, requestedModel: 'gemini', model: 'claude', base: 'main', baseCommit: BASE },
    { event: 'end', issue: 9, attempts: 3, model: 'claude', status: '막힘' },
  ]));
  assert.equal(line(blocked, '모델:'), '- 모델: gemini → claude (대체 사유: <run-worker 출력의 replacedReason>)');
  assert.equal(line(blocked, '시도 횟수:'), '- 시도 횟수: 3, 막힘 사유: <막힘 사유>');
  assert.match(line(blocked, '사후 검사 자료:'), /main 하달 시작 <해시>, 지금 c{40}/, '옛 기록에는 mainBefore가 없다');
  const none = await draft(setup(null), 9);
  assert.equal(line(none, '모델:'), '- 모델: <지정 모델> → <실제 모델> (대체 사유: run-worker 출력의 replacedReason, 없으면 "대체 없음")');
  assert.equal(line(none, '실제 워커 모델:'), '- 실제 워커 모델: <run-worker 출력의 model 값>');
  const other = await draft(setup([{ event: 'start', issue: 3, requestedModel: 'claude', model: 'claude' }]), 9);
  assert.equal(line(other, '시도 횟수:'), '- 시도 횟수: <워커 시도 횟수>, 막힘 사유: <없으면 "없음">', '다른 이슈의 기록은 쓰지 않는다');
});
