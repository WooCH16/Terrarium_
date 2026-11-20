// 이슈 #13 T10: 코디네이터 규칙(coordinator.md)의 절 제목과 수치가 설정값(coordinator.config.json)과 같은지 본다.
// 대조표는 docs/checks/T10-rules-map.md에 있다. 규칙 문구는 docs/01-overview.md를 그대로 옮긴 것이고,
// 옮긴 줄마다 끝에 `(overview N)` 출처 표시가 있어야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCoordinatorConfig } from '../config.mjs';

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(harnessDir, 'coordinator', 'AGENT.md'), 'utf8');
const overview = readFileSync(join(harnessDir, '..', 'docs', '01-overview.md'), 'utf8');
const config = loadCoordinatorConfig();

// 코드 울타리 밖의 `## `·`### ` 제목으로 문서를 나눈다(이슈 양식 안의 `## 목표` 같은 줄은 제목이 아니다).
function sections(text) {
  const out = new Map();
  let fence = false;
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && /^(#{2,3}) (.+)$/.exec(line);
    if (m) {
      current = m[2].trim();
      out.set(current, []);
    } else if (current) {
      out.get(current).push(line);
    }
  }
  return out;
}
const S = sections(doc);
const body = (heading) => {
  assert.ok(S.has(heading), `coordinator.md에 절 "${heading}"이 있어야 한다`);
  return S.get(heading);
};
const num = (n) => `(?<!\\d)${n}(?!\\d)`;

// 이슈 #13 끝나는 조건 2의 절. [제목, 출처 overview 절]
const REQUIRED = [
  ['정리본 경로 (큰 작업)', ['3.2']],
  ['승인 규칙', ['3.7']],
  ['작업 중 요구가 바뀔 때', ['3.6']],
  ['컴팩션과 보존 노트', ['5.2']],
  ['선호', ['6']],
  ['이슈 취소', ['4.3']],
  ['막힌 이슈의 모음 보고', ['7.3']],
  ['응답 없음 판정', ['7.4']],
];
// 출처 표시: overview 절, 소유자 답 대기, 사실 근거 중 하나
const MARK = /\(overview \d+(\.\d+)?(, \d+(\.\d+)?)*\)|\(이슈 #2 대기|\(근거: /;

test('이슈 #13의 절이 coordinator.md에 있고 각 절이 출처 overview 절을 밝힌다', () => {
  for (const [heading, refs] of REQUIRED) {
    const text = body(heading).join('\n');
    for (const r of refs) assert.match(text, new RegExp(`\\(overview [^)]*${r.replace('.', '\\.')}(?![\\d.])`), `${heading}: overview ${r}`);
  }
});

test('옮긴 절의 규칙 줄(목록·번호 줄)마다 출처 표시가 있다', () => {
  for (const [heading] of REQUIRED) {
    for (const line of body(heading)) {
      if (/^\s*([-*]|\d+\.)\s/.test(line)) assert.match(line, MARK, `${heading}: 출처 표시 없음: ${line}`);
    }
  }
});

test('overview 3.1·7.3에서 옮긴 대화형 줄에 출처 표시가 있고, 3.5의 부족함은 조언 판정의 거부로만 다룬다(소유자 결정 8-3)', () => {
  const talk = body('대화형과 작업형').join('\n');
  assert.match(talk, /승인 절차도 없다\. \(overview 3\.1\)/);
  assert.match(talk, /스스로 작업을 시작하지 않는다\. \(overview 3\.1\)/);
  assert.match(talk, /숨기지 않고 알린다\. \(overview 7\.3\)/);
  const direct = body('직접 지시 경로').join('\n');
  assert.match(direct, /부족함은 조언 판정의 거부로 다루고[^\n]*소유자 결정 8-3\)/);
  assert.doesNotMatch(direct, /그래도 부족하면|1회 다시 묻는다/);
});

// 설정 키 → coordinator.md에서 그 값이 있어야 하는 줄. 줄은 [절 제목, 줄을 고르는 정규식]으로 찾는다.
const BINDINGS = {
  reworkLimitPerIssue: (c) => [['직접 지시 경로', /^9\. \*\*대조:\*\*/, `이슈당 ${num(c.reworkLimitPerIssue)}회`]],
  blockedIssuesReportThreshold: (c) => [['막힌 이슈의 모음 보고', /막힌 이슈가 \*\*/, `\\*\\*${num(c.blockedIssuesReportThreshold)}개\\*\\* 쌓였을 때`]],
  cancelledIssuesCleanupThreshold: (c) => [['이슈 취소', /취소된 이슈가/, `\\*\\*${num(c.cancelledIssuesCleanupThreshold)}개\\*\\* 쌓이면`]],
  preferenceProposalAtRepeat: (c) => [['선호', /추론한 선호/, `같은 요청이 \\*\\*${num(c.preferenceProposalAtRepeat)}번째\\*\\*`]],
  advisorRevisionAfterReject: (c) => [['직접 지시 경로', /거부 후 수정은/, `거부 후 수정은 \\*\\*${num(c.advisorRevisionAfterReject)}회\\*\\*까지`]],
  lightCheck: (c) => [['권한 (훅이 실제로 막는다)', /가벼운 확인:/, `파일 ${num(c.lightCheck.maxFiles)}개 또는 읽기 ${num(c.lightCheck.maxReads)}번`]],
  bigToolOutput: (c) => [['컴팩션과 보존 노트', /큰 도구 출력은 참조로/, `${num(c.bigToolOutput.lines)}줄 또는 ${num(c.bigToolOutput.tokens / 1000)}K 토큰`]],
  recentContextPercent: (c) => [['컴팩션과 보존 노트', /^- 끝:/, `컨텍스트 창의 \\*\\*${num(c.recentContextPercent)}%\\*\\*`]],
  preserveListPercent: (c) => [['컴팩션과 보존 노트', /목록 상한은/, `창의 \\*\\*${num(c.preserveListPercent)}%\\*\\*`]],
  noResponseMinutes: (c) => [['응답 없음 판정', /너무 오래 변화가 없음/, `\\*\\*${num(c.noResponseMinutes)}분\\*\\* 동안`]],
};
// coordinator.md에 없는 값과 그 이유(대조표 참고).
const NOT_IN_RULES = {
  workerModels: '이슈 양식의 `- 워커 모델:` 줄로 config.test.mjs가 본다',
  researchRetry: 'overview 7.5는 ADR 0003으로 판정 기준을 다시 정해야 해서 옮기지 않았다(대조표 시나리오 11)',
  researchResult: '조사 결과의 크기는 오퍼레이터가 지킨다(operator.md 7, 10.5)',
};

function mismatches(text, cfg) {
  const secs = sections(text);
  const out = [];
  for (const [key, make] of Object.entries(BINDINGS)) {
    for (const [heading, pick, want] of make(cfg)) {
      const lines = (secs.get(heading) ?? []).filter((l) => pick.test(l));
      if (lines.length !== 1) { out.push(`${key}: "${heading}"에서 ${pick} 줄이 ${lines.length}개`); continue; }
      if (!new RegExp(want).test(lines[0])) out.push(`${key}: ${lines[0].trim()} 에 ${want}가 없다`);
    }
  }
  return out;
}

test('설정의 모든 키가 규칙 줄에 묶여 있거나 제외 이유가 있다', () => {
  const keys = Object.keys(config).sort();
  const covered = [...Object.keys(BINDINGS), ...Object.keys(NOT_IN_RULES)].sort();
  assert.deepEqual(covered, keys);
});

test('coordinator.md의 수치가 coordinator.config.json과 같다', () => {
  assert.deepEqual(mismatches(doc, config), []);
});

test('설정값을 바꾼 사본으로는 수치 대조가 실패한다(대조가 실제로 값을 본다)', () => {
  const bump = (v) => (typeof v === 'number' ? (v === 1000 ? 3000 : v + 1) : v);
  for (const key of Object.keys(BINDINGS)) {
    const copy = structuredClone(config);
    if (typeof copy[key] === 'number') copy[key] = bump(copy[key]);
    else for (const k of Object.keys(copy[key])) copy[key][k] = k === 'tokens' ? copy[key][k] + 1000 : bump(copy[key][k]);
    assert.ok(mismatches(doc, copy).some((m) => m.startsWith(`${key}:`)), `${key}를 바꿔도 실패하지 않는다`);
  }
});

// overview 8절 표의 값도 설정과 같아야 한다(규칙의 출처가 같은 값을 말하는지).
test('overview 8절 수치 표가 설정값과 같다', () => {
  const rows = new Map();
  for (const line of overview.split(/\r?\n/)) {
    const m = /^\| ([^|]+) \| ([^|]+) \| [^|]+ \|$/.exec(line);
    if (m) rows.set(m[1].trim(), m[2].trim());
  }
  const c = config;
  const want = [
    ['재작업 한도', `이슈당 ${c.reworkLimitPerIssue}회`],
    ['막힌 이슈 모음 보고', `${c.blockedIssuesReportThreshold}개`],
    ['취소 이슈 정리', `${c.cancelledIssuesCleanupThreshold}개`],
    ['선호 추론 제안', `같은 요청 ${c.preferenceProposalAtRepeat}번째`],
    ['리뷰어 거부 후 조언 수정', `${c.advisorRevisionAfterReject}회`],
    ['가벼운 확인 한도', `파일 ${c.lightCheck.maxFiles}개 또는 읽기 ${c.lightCheck.maxReads}번`],
    ['조사 재요청', `${c.researchRetry}회`],
    ['조사 결과 크기 상한', `${c.researchResult.maxLines}줄 또는 ${c.researchResult.maxTokens / 1000}K 토큰`],
    ['큰 도구 출력 기준', `${c.bigToolOutput.lines}줄 또는 ${c.bigToolOutput.tokens / 1000}K 토큰`],
    ['최근 대화 원문 유지', `컨텍스트 창의 ${c.recentContextPercent}%`],
    ['보존 목록 상한', `컨텍스트 창의 ${c.preserveListPercent}%`],
    ['응답 없음의 시간 값', `${c.noResponseMinutes}분`],
  ];
  for (const [name, value] of want) {
    assert.ok(rows.has(name), `overview 8절에 ${name} 줄`);
    assert.ok(rows.get(name).startsWith(value), `${name}: ${rows.get(name)} (기대 ${value})`);
  }
});
