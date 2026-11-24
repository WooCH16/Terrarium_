// 리뷰어(Jev) 질문 문구의 기준은 harness/reviewer/AGENT.md의 `## Jev 질문` 절이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQuestions, QUESTION_NAMES, REVIEWER_DOC, reportQuestions, proposalQuestions } from '../operator/jev-review.mjs';

const doc = readFileSync(REVIEWER_DOC, 'utf8');

test('리뷰어 문서: 네 질문(met, evidence, decidable, checkable)에 묻는 말·예·아니오가 다 있다', () => {
  const q = parseQuestions(doc);
  for (const n of QUESTION_NAMES) for (const k of ['ask', 'yes', 'no']) assert.ok(q[n][k], `${n}.${k}`);
});

test('리뷰어 질문: 문서의 문장에 기준·확인 방법이 그대로 들어간다($ 같은 글자도)', () => {
  const r = reportQuestions(['출력에 $1 이 나온다']);
  assert.equal(r.met_1.type, 'noul');
  assert.equal(r.met_1.instructions, 'Does `report` mark this completion criterion as met? Criterion: "출력에 $1 이 나온다"');
  assert.equal(r.evidence_1.criteria.false, 'For this criterion the report gives no location, or only a general statement such as "done" or "checked".');
  const p = proposalQuestions([{ rows: [['기준 A', '`node t.mjs`']] }]);
  assert.equal(p.decidable_1_1.instructions, 'Could a reviewer decide, by looking at the finished work, whether this criterion is met or not? Criterion: "기준 A"');
  assert.equal(p.checkable_1_1.instructions, 'Is this check something a person can actually run or look at? Check: "`node t.mjs`"');
});

test('리뷰어 문서: 질문 절이 없거나 줄이 빠지면 판정하지 않고 오류다', () => {
  assert.throws(() => parseQuestions('# 리뷰어\n'), /Jev 질문/);
  const broken = doc.replace(/^- 아니오: The check is missing.*$/m, '');
  assert.throws(() => parseQuestions(broken), /checkable/);
});
