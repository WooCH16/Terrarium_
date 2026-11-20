import { STATES, CANCEL_LABEL, NO_LABEL, LABEL } from './protocol.mjs';
// 대기: 의존하는 이슈가 허용됐지만 아직 main에 반영되지 않아 이번 하달에서 뺀 이슈(소유자 결정, 새 하달의 시작점). 반영 뒤 다시 하달한다.
export { STATES };

// 상태가 아닌 라벨: 코디네이터가 이슈를 취소할 때 상태 라벨과 함께 붙이고 닫는다(소유자 결정 6). 시작 스크립트가 상태 라벨과 같이 미리 만든다.
export { CANCEL_LABEL };
// 시작 스크립트(setup·run-operator·run-research)가 미리 만들어 두는 라벨 전부.
export const ENSURED_LABELS = Object.freeze([...STATES, CANCEL_LABEL]);

// 상태 라벨이 하나도 없는 이슈(예: 조사 이슈)를 보고할 때 쓰는 고정 문구. 상태 라벨은 아니다.
export { NO_LABEL };

const BLOCKING = new Set([LABEL.막힘, LABEL.보류, LABEL.거부목록, LABEL.대기]);

// 오류 메시지에 넣을 값: 줄바꿈이 이스케이프되고 40자로 잘린 문자열. 어떤 값이어도 던지지 않는다.
function show(value) {
  let text;
  try {
    text = String(value);
  } catch {
    text = '[표시할 수 없는 값]';
  }
  return JSON.stringify(text).slice(0, 40);
}

function checkState(state) {
  if (state !== NO_LABEL && !STATES.includes(state)) throw new Error(`알 수 없는 상태입니다: ${show(state)}`);
}

function checkRow(row) {
  if (row === null || typeof row !== 'object') throw new Error(`행은 객체여야 합니다: ${show(row)}`);
}

// 출력 한 줄: "#번호 | 상태 | url". 요약 문구는 넣지 않는다.
export function formatLine(row) {
  checkRow(row);
  const { number, state, url } = row;
  checkState(state);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`번호는 양의 정수여야 합니다: ${show(number)}`);
  if (typeof url !== 'string' || url === '' || /[\p{Cc}\u2028\u2029|]/u.test(url)) {
    throw new Error(`url은 제어 문자·줄바꿈·| 가 없는 비어 있지 않은 문자열이어야 합니다: ${show(url)}`);
  }
  return `#${number} | ${state} | ${url}`;
}

export function formatReport(rows) {
  if (!Array.isArray(rows)) throw new Error('rows는 배열이어야 합니다');
  const lines = [];
  for (const row of Array.from(rows)) lines.push(formatLine(row));
  return lines.join('\n');
}

function checkFlags(flags) {
  if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) throw new Error('flags는 객체여야 합니다');
  for (const key of ['failure', 'stopped']) {
    if (flags[key] !== undefined && typeof flags[key] !== 'boolean') throw new Error(`flags.${key}는 boolean이어야 합니다`);
  }
}

// 우선순위: failure(2) > stopped(3) > 막힘·보류·거부목록·대기(1) > 0. flags를 먼저 보고, 행은 그 뒤에 검증한다.
export function exitCode(rows, flags = {}) {
  checkFlags(flags);
  if (flags.failure === true) return 2;
  if (flags.stopped === true) return 3;
  if (!Array.isArray(rows)) throw new Error('rows는 배열이어야 합니다');
  const list = Array.from(rows);
  for (const row of list) {
    checkRow(row);
    checkState(row.state);
  }
  return list.some((row) => BLOCKING.has(row.state)) ? 1 : 0;
}
