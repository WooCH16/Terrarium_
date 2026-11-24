// 관제탑의 한도 창: 연결된 계정마다 읽을 수 있는 한도만 보이고, 읽을 길이 없으면 그렇다고 적는다.
// - Claude(코디네이터): statusline의 5시간·주간 한도와 컨텍스트(구독 계정에서, 첫 답 뒤에만 옴)
// - GitHub: `gh api rate_limit`의 REST API 남은 횟수
// - Pi(anthropic, meta): `pi auth check --json`의 연결 상태. Pi는 한도를 알려 주지 않는다
// - Gemini·Jev 키: 보관 여부. 두 API 모두 남은 한도를 묻는 길이 없다(Jev는 429로만 알림)
// 값은 모두 읽기만 한 것이다. 키 값은 다루지 않는다(있음/없음만).

const hm = (sec) => { const d = new Date(sec * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const md = (sec) => { const d = new Date(sec * 1000); return `${d.getMonth() + 1}/${d.getDate()} ${hm(sec)}`; };
const NO_LIMIT = '제공사가 남은 한도를 알려 주지 않습니다';

// status: coordinator-status.json 내용 | null
// gh: { limit, remaining, reset } | null(못 읽음)
// pi: { anthropic, meta } 각 { status: 'ready'|'not_ready'|'invalid', authType } | null
// keys: { TYPESAFE_API_KEY: bool, GEMINI_API_KEY: bool }
export function buildLimits({ status = null, gh = null, pi = {}, keys = {} } = {}) {
  const rows = [];

  const cm = [];
  if (status?.fiveHour) cm.push({ label: '5시간 한도', pct: status.fiveHour.pct, sub: status.fiveHour.resetsAt ? `resets ${hm(status.fiveHour.resetsAt)}` : '', color: '#f07a73' });
  if (status?.sevenDay) cm.push({ label: '주간 한도', pct: status.sevenDay.pct, sub: status.sevenDay.resetsAt ? `resets ${md(status.sevenDay.resetsAt)}` : '', color: '#f4d58d' });
  if (typeof status?.context === 'number') cm.push({ label: '코디네이터 컨텍스트', pct: status.context, sub: '/compact로 줄임', color: '#6cb6ff' });
  rows.push({
    name: 'Claude', role: '코디네이터·오퍼레이터', state: status ? '연결됨' : '모름', meters: cm,
    note: cm.length ? (status.fiveHour || status.sevenDay ? '' : '한도 막대는 claude.ai Pro·Max 구독 로그인에서만 옵니다') : '코디네이터가 첫 답을 하면 보입니다',
  });

  if (gh && Number.isFinite(gh.limit) && gh.limit > 0) {
    const used = Math.max(0, Math.min(100, Math.round(((gh.limit - gh.remaining) / gh.limit) * 100)));
    rows.push({ name: 'GitHub', role: '이슈·PR(gh)', state: '연결됨', meters: [{ label: `API ${gh.remaining}/${gh.limit} 남음`, pct: used, sub: gh.reset ? `resets ${hm(gh.reset)}` : '', color: '#a8a59c' }], note: '' });
  } else {
    rows.push({ name: 'GitHub', role: '이슈·PR(gh)', state: '모름', meters: [], note: 'gh 로그인을 확인하지 못했습니다(설정 → 계정)' });
  }

  const piRow = (key, name, role) => {
    const p = pi?.[key];
    const state = p?.status === 'ready' ? '연결됨' : p?.status ? '연결 안 됨' : '모름';
    const extra = key === 'anthropic' && p?.authType === 'oauth' ? '. Claude 구독 로그인이라 같은 계정이면 위 Claude 한도를 함께 씁니다' : '';
    rows.push({ name, role, state, meters: [], note: state === '연결됨' ? `${NO_LIMIT}${extra}` : state === '모름' ? 'pi 연결 상태를 확인하지 못했습니다' : 'pi 로그인 필요(설정 → 계정)' });
  };
  piRow('anthropic', 'Pi · Anthropic', 'claude 워커');
  piRow('meta', 'Pi · Meta', 'muse 워커');

  rows.push({ name: 'Gemini', role: 'gemini 워커', state: keys.GEMINI_API_KEY ? '키 있음' : '키 없음', meters: [], note: keys.GEMINI_API_KEY ? NO_LIMIT : '설정 → 계정에서 키를 넣습니다' });
  rows.push({ name: 'Jev(TypeSafe)', role: '리뷰어·라우팅', state: keys.TYPESAFE_API_KEY ? '키 있음' : '키 없음', meters: [], note: keys.TYPESAFE_API_KEY ? `${NO_LIMIT}(넘으면 429로 알림)` : '설정 → 계정에서 키를 넣습니다' });

  return rows;
}
