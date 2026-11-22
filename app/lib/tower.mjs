// 관제탑 화면(ADR 0011, ADR 0012)에 실제 상태를 넣는다. 읽기만 한다.
// 카드 다섯은 늘 그 자리의 역할 오퍼레이터다(결정 8-29, 8-19를 고침): dev 개발팀, design 디자인, tester 테스터, plan 기획, sec 보안팀. 빈 자리는 없다.
// 카드 이름은 넣지 않는다. 화면(js/app.js의 NAMES)이 소유자가 정한 이름을 쓴다.
// 그 팀의 하달(하달 기록 dispatch.json의 team이 그 자리인 것)만 본다. 팀 없는 옛 하달은 카드에 넣지 않는다(지어내지 않는다).
// 워커 상자 = 보여 줄 하달에서 워커를 부른 이슈 하나(workers.jsonl의 start). 막대는 이슈 라벨의 단계다.

export const SLOTS = ['dev', 'design', 'tester', 'plan', 'sec'];

// 이슈 상태 라벨 → 단계(막대 길이). 하네스에는 진행률 숫자가 없어서 단계로만 보여 준다.
export const STAGE = { 대기: 0, 진행중: 30, 미완료: 30, 보류: 30, 막힘: 30, 리뷰대기: 60, 허용됨: 90, 반영됨: 100, 취소: 100, 거부목록: 100 };

const hhmm = (iso) => {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (h) => Number(String(h.name).slice(1));

// 작업 없이 호출(결정 8-29): 하달 기록이 있고 끝났는데, 작업 모드이고, 워커를 하나도 띄우지 않은 하달. 멈춘 하달·도는 하달·조사 하달·옛 하달은 아니다.
export function workless(h) {
  const d = h.dispatch;
  if (!d || d.mode !== 'work' || !d.endedAt || h.running || h.stopped) return false;
  return (h.workers ?? []).length === 0;
}
// 사유: 세션 전에 모두 빠짐(뺀 사유를 그대로) 또는 세션은 떴지만 워커를 부르지 않음·세션 실패.
function worklessReason(h) {
  const d = h.dispatch;
  if (d.live && d.live.length === 0 && d.excluded.length > 0) return d.excluded.map((x) => `#${x.issue} ${x.reason}`).join(', ');
  return d.sessionOk === false ? '세션 실패' : '워커를 부르지 않음';
}

function workerBox(w, h, issues) {
  const issue = issues.find((i) => i.number === w.issue);
  const label = issue?.label ?? '라벨 없음';
  let state = 'idle';
  if (h.running && !w.done) state = 'work';
  else if (w.status === '막힘' || w.status === '실패') state = 'pause';
  const name = `#${w.issue} ${w.model ?? '모델 모름'}${w.attempts ? ` ${w.attempts}회` : ''}`;
  return { id: `#${w.issue}`, name: cut(name, 18), state, progress: STAGE[label] ?? 0, title: issue?.title ?? '' };
}

function teamCard(slot, all, issues, legacy) {
  const mine = all.filter((h) => h.team === slot).sort((a, b) => num(b) - num(a)); // 최근 것이 앞
  const head = legacy > 0 ? [`팀 없는 옛 하달 ${legacy}개는 설정 창 진행 기록에`] : [];
  if (mine.length === 0) return { id: slot, state: 'idle', workers: [], log: [...head, '아직 호출된 적 없음'] };
  const running = mine.find((h) => h.running);
  const latest = mine[0];
  // 일시정지는 가장 최근 하달만 본다(오래전에 멈춘 하달 하나로 팀이 계속 멈춤으로 보이지 않게).
  const state = running ? 'work' : (latest.stopped || latest.orphaned) ? 'pause' : 'idle';
  const shown = running ?? latest;
  const workers = (shown.workers ?? []).map((w) => workerBox(w, shown, issues));
  const count = (h) => (h.workers ?? []).length;
  const total = `누적 · 호출 ${mine.length}회 · 작업 없이 ${mine.filter(workless).length}회 · 워커 ${mine.reduce((a, h) => a + count(h), 0)}명`;
  const live = shown.dispatch?.live ?? shown.issues ?? [];
  const recent = `${shown.name} ${hhmm(shown.startedAt)}~${shown.running ? '' : hhmm(shown.endedAt)} · 이슈 ${live.map((n) => `#${n}`).join(', ') || '없음'} · 워커 ${count(shown)}명`;
  let now;
  if (shown.running) now = '지금 · 도는 중';
  else if (shown.stopped) now = `${hhmm(shown.stoppedAt ?? shown.endedAt)} · 멈춤(stop-operator)`;
  else if (shown.orphaned) now = '끝난 기록 없이 프로세스가 없음(중간에 끊김). stop-operator로 정리하세요';
  else if (workless(shown)) now = `작업 없이 호출됨 · ${worklessReason(shown)}`;
  else now = `${hhmm(shown.endedAt)} · 끝남`;
  return { id: slot, state, workers, log: [...head, total, cut(recent, 70), cut(now, 70)] };
}

// status = readStatus() 결과(없으면 null). error = 읽기 실패 메시지.
export function towerView(status, error = null) {
  if (!status) {
    const note = error ? `상태를 못 읽음: ${cut(String(error), 60)}` : '실행 폴더를 고르세요';
    return { operators: SLOTS.map((s) => ({ id: s, state: 'idle', workers: [], log: [note] })), note };
  }
  const legacy = status.handoffs.filter((h) => !h.team).length;
  const operators = SLOTS.map((slot) => teamCard(slot, status.handoffs, status.issues, legacy));
  if (status.issuesError) for (const o of operators) o.log.push(`이슈를 못 읽음: ${cut(status.issuesError, 50)}`);
  return { operators, note: null };
}
