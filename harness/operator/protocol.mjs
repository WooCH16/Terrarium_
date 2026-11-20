// 기계가 읽는 한국어 문자열(프로토콜)은 여기에만 둔다(이슈 #28, 소유자 결정 9-2).
// 스크립트끼리 주고받는 표지(댓글 첫 줄, 이슈 본문의 `- 이름: 값` 줄, 표 머리, 상태 라벨)가 한 글자라도 어긋나면 판정·합치기·라우팅이 조용히 틀어진다.
// 사람에게 보이는 안내 문장은 여기 두지 않는다. harness/test/protocol.test.mjs가 이 파일 밖의 하드코딩을 찾는다.

// 상태 라벨(이슈 #2 결정 1)과 상태가 아닌 라벨
export const STATES = Object.freeze(['진행중', '리뷰대기', '허용됨', '미완료', '막힘', '거부목록', '보류', '반영됨', '대기']);
export const CANCEL_LABEL = '취소';
export const NO_LABEL = '라벨 없음';

// 오퍼레이터의 결과 보고서 댓글
export const REPORT_HEAD = '## 결과 보고서';
export const REPORT_SECTIONS = Object.freeze(['기준별 충족 여부', '근거 위치', '변경 요약', '남은 문제']);
export const REPORT_TABLE = Object.freeze(['기준', '충족', '근거 위치']);

// 리뷰어 판정 댓글(ADR 0004 결정 C)
export const VERDICT_HEAD = '## 리뷰어 판정';
export const VERDICT_ALLOW = `${VERDICT_HEAD}: 허용`;
export const VERDICT_REJECT = `${VERDICT_HEAD}: 거부`;
export const ALLOWED_COMMIT = '허용된 커밋';
export const REVIEWER_MODEL = '리뷰어 모델';

// 코디네이터 대조 결과 댓글
export const CHECK_HEAD = '## 코디네이터 대조 결과';

// 이슈 본문·보고서의 `- 이름: 값` 줄
export const WORKER_MODEL = '워커 모델';
export const ACTUAL_WORKER_MODEL = '실제 워커 모델';
export const ISSUE_KIND = '유형';
export const DIFFICULTY = '난이도';
export const PUBLIC_OK = '공개 가능';

// 워커 결과 파일(.harness/worker-result.md)의 칸
export const RESULT_FIELDS = Object.freeze(['이슈 번호', '변경 요약', '테스트 명령과 결과', '커밋 해시']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `이름: 값` 줄(앞에 `- `나 `* `가 와도 된다). 값은 첫 묶음.
export const fieldLine = (name) => new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${esc(name)}[ \\t]*:`);
// `허용된 커밋: <40자리>` 줄
export const ALLOWED_COMMIT_LINE = new RegExp(`^${esc(ALLOWED_COMMIT)}: ([0-9a-f]{40})[ \\t]*$`);
// 라벨을 이름으로 쓴다: LABEL.막힘 처럼. 스크립트는 라벨 글자를 직접 쓰지 않는다.
export const LABEL = Object.freeze(Object.fromEntries([...STATES, CANCEL_LABEL].map((s) => [s, s])));
