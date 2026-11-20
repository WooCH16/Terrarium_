// run-8에서 드러난 결함의 시험: 보고서 초안(R8-2), 재작업 횟수(R8-3), 같은 하달의 의존 이슈 기준 브랜치(R8-4).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { main as draftMain, draftText } from '../operator/result-draft.mjs';
import { reviewedReports } from '../operator/run-operator.mjs';
import { reportProblems, issueCriteria } from '../operator/jev-review.mjs';
import { decide } from '../policy.mjs';

const fwd = (p) => p.split(String.fromCharCode(92)).join('/');
const made = [];
after(() => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 무시 */ } } });

const BODY = [
  '## 목표', 'x', '',
  '## 완료 기준',
  '| 기준 | 확인 방법 |', '|---|---|',
  "| `listMemos(store, { sort: 'title' })`가 제목 오름차순으로 돌려준다 | `node --test test/sort.test.mjs` |",
  '| 기존 시험을 포함한 전체 시험이 모두 통과한다 | `node --test` |', '',
  '## 의존하는 이슈', '없음', '',
].join('\n');

test('R8-2: 보고서 초안은 이슈의 기준을 글자 그대로 옮기고, 칸만 채우면 리뷰어 코드 검사를 통과한다', async () => {
  const run = fwd(mkdtempSync(`${fwd(tmpdir())}/draft-`));
  made.push(run);
  mkdirSync(`${run}/issues`, { recursive: true });
  writeFileSync(`${run}/harness.json`, JSON.stringify({ designatedRepo: 'o/r', issuesClone: `${run}/issues`, targetProject: `${run}/memo` }));
  const out = [];
  const hash = 'a'.repeat(40);
  const code = await draftMain(['--handoff', 'h3', '--issue', '13'], { HARNESS_RUN_DIR: run }, { write: (l) => out.push(l), fetchBody: async () => BODY, git: () => hash });
  assert.equal(code, 0, out.join());
  assert.deepEqual(out, [`${run}/issues/.drafts/result-13-h3.md`]);
  const filled = readFileSync(out[0], 'utf8').replaceAll('<충족 또는 미충족>', '충족').replaceAll('<파일:줄, 테스트 이름, 명령과 결과>', '`test/sort.test.mjs:12`');
  const problems = reportProblems({ report: filled, hash, criteria: issueCriteria(BODY), fileExists: () => true });
  assert.deepEqual(problems, []);
  assert.equal(await draftMain(['--handoff', 'h3'], { HARNESS_RUN_DIR: run }, { write: () => {} }), 2);
  assert.equal(await draftMain(['--handoff', 'h3', '--issue', '13'], { HARNESS_RUN_DIR: run }, { write: () => {}, fetchBody: async () => '## 목표\nx' }), 2);
  assert.match(draftText({ issue: 1, criteria: ['a'], commit: null }), /^커밋 해시: 없음$/m);
});

test('R8-3: 재작업 횟수는 리뷰어 판정을 받은 보고서로 센다(판정 없는 실패 보고서는 세지 않는다)', () => {
  const c = (body) => ({ body });
  assert.equal(reviewedReports([c('## 결과 보고서\n막힘'), c('## 결과 보고서\n막힘'), c('## 결과 보고서\nx'), c('## 리뷰어 판정: 거부\n...')]), 1);
  assert.equal(reviewedReports([c('## 결과 보고서'), c('## 리뷰어 판정: 허용'), c('## 결과 보고서'), c('## 리뷰어 판정: 거부'), c('## 결과 보고서')]), 2);
  assert.equal(reviewedReports([c('기타'), c('## 리뷰어 판정: 허용')]), 0);
});

test('R8-4: 오퍼레이터는 같은 하달의 통합 브랜치를 기준으로 워커를 부를 수 있고, 보고서 초안 스크립트를 실행할 수 있다', () => {
  const run = 'C:/run';
  const config = { harnessDir: 'C:/h', runDir: run, issuesClone: `${run}/issues`, targetProject: `${run}/memo`, designatedRepo: 'o/r', role: 'operator-work', handoff: 'h3' };
  const bash = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: run }, config, { visibility: () => 'PRIVATE', readFile: () => { throw new Error('x'); } });
  assert.equal(bash('node C:/h/operator/run-worker.mjs --handoff h3 --issue 14 --model claude --base h3/issue-13').allow, true);
  assert.equal(bash('node C:/h/operator/result-draft.mjs --handoff h3 --issue 14').allow, true);
  assert.equal(bash('node C:/h/operator/run-worker.mjs --handoff h3 --issue 14 --model claude --base integration/h3').allow, false, '통합 브랜치는 범위에 병합 커밋을 넣는다(run-11)');
  assert.equal(bash('node C:/h/operator/result-draft.mjs --handoff h2 --issue 14').allow, false);
});

test('fable 조언 2: 재작업 한도를 넘은 이슈는 거부목록(규칙 9번·시나리오 9), 합치기 시험 환경은 허용 목록', async () => {
  const src = readFileSync(new URL('../operator/run-operator.mjs', import.meta.url), 'utf8');
  assert.match(src, /reviewed > operatorConfig\.rejectLimit\) \{ await gh\.setState\(n, LABEL\.거부목록\)/);
  const { workerEnv } = await import('../operator/run-worker.mjs');
  const merge = readFileSync(new URL('../operator/merge-adapter.mjs', import.meta.url), 'utf8');
  assert.match(merge, /const env = workerEnv\(base\);/);
  assert.equal(workerEnv({ TYPESAFE_API_KEY: 'x', PATH: 'p' }).TYPESAFE_API_KEY, undefined);
});

test('fable 조언 2: 보고서 초안은 워커가 커밋을 못 냈으면(브랜치 끝이 main이나 다른 이슈 브랜치와 같음) 해시를 없음으로', async () => {
  const run = fwd(mkdtempSync(`${fwd(tmpdir())}/draft2-`));
  made.push(run);
  writeFileSync(`${run}/harness.json`, JSON.stringify({ designatedRepo: 'o/r', issuesClone: `${run}/issues`, targetProject: `${run}/memo` }));
  const main = 'b'.repeat(40);
  const git = (args) => (args[0] === 'for-each-ref' ? `${main}\n${'c'.repeat(40)}` : main);
  const out = [];
  assert.equal(await draftMain(['--handoff', 'h1', '--issue', '5'], { HARNESS_RUN_DIR: run }, { write: (l) => out.push(l), fetchBody: async () => BODY, git }), 0);
  assert.match(readFileSync(out[0], 'utf8'), /^커밋 해시: 없음$/m);
});
