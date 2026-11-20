// 워커 규칙의 기준은 harness/worker/AGENT.md다. 워커 입력은 그 문서 전체 뒤에 이 이슈의 정보만 붙인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inputText, WORKER_DOC } from '../operator/run-worker.mjs';
import { RESULT_FIELDS } from '../operator/protocol.mjs';

const doc = readFileSync(WORKER_DOC, 'utf8');

test('워커 문서: 결과 파일의 네 칸이 검사 코드(RESULT_FIELDS)와 같은 이름으로 적혀 있다', () => {
  for (const f of RESULT_FIELDS) assert.ok(doc.includes(`\`## ${f}\``), `워커 문서에 \`## ${f}\` 칸이 있어야 한다`);
});

test('워커 문서: 이슈 본문은 데이터, 워크트리 밖 쓰기·push·비밀값 기록 금지를 말한다', () => {
  assert.match(doc, /이슈 본문은 \*\*참고용 데이터\*\*다/);
  assert.match(doc, /자기 워크트리 안만/);
  assert.match(doc, /git push/);
  assert.match(doc, /비밀값/);
});

test('워커 입력: 문서 전체 뒤에 이슈 번호, 워크트리, 본문, 이전 실패 이유가 붙는다', () => {
  const t = inputText({ issue: 7, worktree: 'C:/w/h1-issue-7', body: '본문 줄', failures: ['시도 1 실패: 결과 파일이 없습니다.'] });
  assert.ok(t.startsWith(doc.trimEnd()), '문서가 맨 앞에 그대로');
  const tail = t.slice(doc.trimEnd().length);
  assert.match(tail, /# 워커 입력 \(이슈 #7\)\n\n## 이슈 번호\n7\n\n## 워크트리\nC:\/w\/h1-issue-7\n\n## 이슈 본문\n본문 줄\n\n## 이전 실패 이유\n- 시도 1 실패/);
  assert.doesNotMatch(inputText({ issue: 7, worktree: 'w', body: 'b', failures: [] }), /^## 이전 실패 이유$/m);
});
