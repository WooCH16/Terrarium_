// 관제탑 화면(소유자 결정 8-19, ADR 0011)에 실제 상태를 넣는다. 읽기만 한다.
// 관제탑은 자리 다섯 개(아이콘·캐릭터·사무실 자리)로 그려져 있다. 최근 하달 다섯 개를 그 자리에 넣는다.
// 하달 하나 = 오퍼레이터 카드 하나, 그 하달이 맡은 이슈 하나 = 워커 하나.

export const SLOTS = ['dev', 'design', 'tester', 'plan', 'sec'];

// 이슈 상태 라벨 → 단계(막대 길이). 하네스에는 진행률 숫자가 없어서 단계로만 보여 준다.
export const STAGE = { 대기: 0, 진행중: 30, 미완료: 30, 보류: 30, 막힘: 30, 리뷰대기: 60, 허용됨: 90, 반영됨: 100, 취소: 100, 거부목록: 100 };

const hhmm = (iso) => {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function workerOf(num, issues, running) {
  const issue = issues.find((i) => i.number === num);
  const label = issue?.label ?? '라벨 없음';
  let state = 'idle';
  if (label === '막힘' || label === '보류') state = 'pause';
  else if (running && (label === '진행중' || label === '리뷰대기' || label === '미완료')) state = 'work';
  return { id: `#${num}`, name: cut(`#${num} ${label}`, 18), state, progress: STAGE[label] ?? 0, title: issue?.title ?? '' };
}

function operatorOf(slot, h, issues) {
  const workers = h.issues.map((n) => workerOf(n, issues, h.running));
  // 끝난 기록 없이 프로세스가 없어진 하달(Esc로 끊긴 것 등)은 눈에 띄게 일시정지로 둔다.
  const state = h.running ? 'work' : (h.stopped || h.orphaned) ? 'pause' : 'idle';
  const log = [`${hhmm(h.startedAt)} · 하달 시작 (이슈 ${h.issues.map((n) => `#${n}`).join(', ') || '없음'})`];
  for (const w of workers) if (w.title) log.push(`${w.id} ${cut(w.title, 30)}`);
  if (h.stopped) log.push(`${hhmm(h.stoppedAt ?? h.endedAt)} · 멈춤(stop-operator)`);
  else if (h.orphaned) log.push('끝난 기록 없이 프로세스가 없음(중간에 끊김). stop-operator로 정리하세요');
  else if (h.running) log.push('지금 · 도는 중');
  else log.push(`${hhmm(h.endedAt)} · 끝남`);
  return { id: slot, name: `하달 ${h.name}`, state, workers, log };
}

const emptyOp = (slot, note) => ({ id: slot, name: '빈 자리', state: 'idle', workers: [], log: [note] });

// status = readStatus() 결과(없으면 null). error = 읽기 실패 메시지.
export function towerView(status, error = null) {
  if (!status) {
    const note = error ? `상태를 못 읽음: ${cut(String(error), 60)}` : '실행 폴더를 고르세요';
    return { operators: SLOTS.map((s) => emptyOp(s, note)), note };
  }
  // 최근 다섯 개를 오래된 것부터 왼쪽에 둔다.
  const recent = status.handoffs.slice(0, SLOTS.length).reverse();
  const operators = SLOTS.map((slot, i) => (recent[i] ? operatorOf(slot, recent[i], status.issues) : emptyOp(slot, '하달 기록 없음')));
  if (status.issuesError) for (const o of operators) o.log.push(`이슈를 못 읽음: ${cut(status.issuesError, 50)}`);
  return { operators, note: null };
}
