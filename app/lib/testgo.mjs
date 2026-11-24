// /testgo: 관제탑 화면 시험(모양 보기용). 코디네이터 터미널에 /testgo를 치면 코디네이터에는 보내지 않고 이 시간표대로
// 가짜 세션 이벤트를 화면에만 보낸다. 하네스·모델·GitHub는 부르지 않고, 실행 폴더에 아무것도 쓰지 않는다.
//   어드바이저 3명, 오퍼레이터 다섯 팀 전부, 워커는 한 명씩 늘어난다(n번째 팀 오퍼레이터 아래 n명: 1+2+3+4+5 = 15명).
//   Jev는 일정 간격으로 어드바이저 쪽과 오퍼레이터 쪽이 번갈아 켜진다.
//   durationMs(기본 3분)가 지나면 test.end를 보내고, 앱은 시험 전 화면(진짜 흐름)으로 돌아간다.
import { TEAM_NAMES, operatorLabel } from './flow.mjs';

export const TESTGO_COMMAND = '/testgo';
const MODELS = ['claude', 'gemini', 'muse', 'codex'];

// [{ at(ms), ev }] 시간 순. runId는 이벤트마다 같다.
export function testgoTimeline({ runId = 'testgo', durationMs = 180000, stepMs = 4000, jevEveryMs = 12000, jevMs = 4000 } = {}) {
  const out = [];
  const at = (t, ev) => { if (t < durationMs) out.push({ at: Math.round(t), ev: { runId, ...ev } }); };
  const log = (t, text, tone = 'info') => at(t, { type: 'coordinator.log', text, tone });
  const spawn = (t, session, status = 'WORKING', text) => {
    at(t, { type: 'session.spawned', session });
    at(t + 300, { type: 'session.status', id: session.id, status });
    if (text) at(t + 350, { type: 'session.output', id: session.id, text });
  };
  const min = Math.round(durationMs / 60000 * 10) / 10;
  at(0, { type: 'run.started', text: `${TESTGO_COMMAND} 화면 시험` });
  at(0, { type: 'coordinator.status', status: 'DELEGATING' });
  log(0, `❯ ${TESTGO_COMMAND} · 화면 시험(${min}분 뒤 원래 화면으로 돌아감, 코디네이터에는 보내지 않음)`, 'user');

  // 어드바이저 3명
  for (let k = 1; k <= 3; k++) {
    spawn(400 * k, { id: `adv-${k}`, role: 'advisor', parentId: null, label: `Advisor ${k}`, model: 'claude', task: `시험 조언 ${k}` }, 'WORKING', '제안문 쓰는 중…');
  }
  log(400, '→ Advisor 3명 호출', 'advisor');

  // 오퍼레이터: 다섯 팀 전부
  const teams = Object.keys(TEAM_NAMES);
  teams.forEach((team, i) => {
    const t = 2000 + i * 500;
    spawn(t, { id: `op-${team}`, role: 'operator', parentId: null, label: operatorLabel(team), team, handoff: `t${i + 1}`, model: 'claude', task: `t${i + 1} 시험 하달` }, 'WORKING', '이슈를 살피는 중…');
    log(t, `→ ${operatorLabel(team)} · t${i + 1} 시험 하달`, 'operator');
  });

  // 워커: 한 명씩 늘어난다. n번째 팀 오퍼레이터 아래 n명.
  let t = 2000 + teams.length * 500 + stepMs;
  let issue = 100;
  let total = 0;
  teams.forEach((team, i) => {
    for (let k = 1; k <= i + 1; k++) {
      issue += 1;
      total += 1;
      const model = MODELS[(total - 1) % MODELS.length];
      spawn(t, { id: `wk-${team}-${issue}`, role: 'worker', parentId: `op-${team}`, label: `Worker #${issue}`, model, task: `이슈 #${issue}` });
      at(t, { type: 'session.output', id: `op-${team}`, text: `→ Worker ${k}명 호출` });
      log(t, `→ Worker #${issue} 호출 · ${model} (워커 ${total}명)`, 'worker');
      t += stepMs;
    }
  });

  // Jev: 일정 간격으로 번갈아 켜진다(jevMs 동안). 어드바이저 쪽일 때는 어드바이저가 판정을 받는 중으로 보인다.
  let side = 'adv';
  for (let j = jevEveryMs; j < durationMs; j += jevEveryMs) {
    at(j, { type: 'jev.active', side, on: true, ms: jevMs });
    if (side === 'adv') {
      log(j, '← Jev 조언 판정(시험)', 'advisor');
      for (let k = 1; k <= 3; k++) {
        at(j, { type: 'session.status', id: `adv-${k}`, status: 'REVIEWING' });
        at(j + jevMs, { type: 'session.status', id: `adv-${k}`, status: 'WORKING' });
      }
    } else log(j, '→ Jev 리뷰어 판정(시험)', 'info');
    side = side === 'adv' ? 'ops' : 'adv';
  }
  out.sort((a, b) => a.at - b.at);
  out.push({ at: durationMs, ev: { runId, type: 'test.end' } });
  return out;
}

// 터미널 입력 한 덩어리에서 /testgo 줄을 찾는다(터미널 렌더러와 같은 규칙, 시험용). line은 지금까지 친 줄.
// 돌려주는 것: { line, forward(코디네이터에 보낼 것), fire(/testgo를 쳤는지) }
export function scanTestgo(line, data) {
  if (/^\x1b./.test(data)) return { line: '', forward: data, fire: false }; // 화살표 등 제어 순서
  let forward = '';
  let fire = false;
  for (const ch of data) {
    if (ch === '\r' && line.trim() === TESTGO_COMMAND) {
      forward += '\x7f'.repeat(line.length); // 코디네이터 입력 칸에 친 글자를 지운다(Enter는 보내지 않는다)
      line = '';
      fire = true;
      continue;
    }
    if (ch === '\r' || ch === '\x03' || ch === '\x15' || ch === '\x1b') line = '';
    else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1);
    else if (ch >= ' ') line = (line + ch).slice(-300);
    forward += ch;
  }
  return { line, forward, fire };
}
