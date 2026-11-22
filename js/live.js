// 데스크톱 앱에서만: 목 백엔드(api.js) 대신 지금 실행 폴더의 실제 상태를 넣는다(결정 8-29, ADR 0012, ADR 0011).
// 카드 다섯 = 역할 오퍼레이터(dev·design·tester·plan·sec, 빈 자리 없음), 워커 = 그 팀 하달에서 워커를 부른 이슈. 읽기만 한다(상태 바꾸기·대화 보내기는 받지 않는다).
// 브라우저로 열면 아무것도 하지 않고 목 데이터가 그대로 돈다. app.js보다 먼저 읽어야 한다.
(function () {
  const T = window.terrarium;
  if (!T || typeof T.towerStatus !== 'function') return;

  let ops = [];
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const find = (id) => ops.find((o) => o.id === id);
  // 카드 이름은 넣지 않는다(app.js의 NAMES가 팀 이름을 쓴다).
  const empty = (id) => ({id: id, state: 'idle', workers: [], log: []});

  function summarize(o) {
    const n = o.workers.length;
    return {id: o.id, name: o.name, state: o.state, workerCount: n,
      working: o.workers.filter((w) => w.state === 'work').length,
      avg: n ? Math.round(o.workers.reduce((a, w) => a + w.progress, 0) / n) : 0};
  }
  const detail = (o) => Object.assign(summarize(o), {workers: o.workers, log: o.log});

  async function route(method, path) {
    if (method !== 'GET') return {status: 403, data: {error: '관제탑은 읽기 전용입니다'}};
    if (path === '/operators') {
      const v = await T.towerStatus();
      ops = (v && Array.isArray(v.operators)) ? v.operators : [];
      return {status: 200, data: ops.map(summarize)};
    }
    const m = path.match(/^\/operators\/(\w+)$/);
    if (m) return {status: 200, data: detail(find(m[1]) || empty(m[1]))};
    if (path === '/summary') {
      const all = ops.flatMap((o) => o.workers);
      return {status: 200, data: {operators: ops.length, workers: all.length,
        working: all.filter((w) => w.state === 'work').length,
        avg: all.length ? Math.round(all.reduce((a, w) => a + w.progress, 0) / all.length) : 0}};
    }
    if (path === '/messages') return {status: 200, data: []};
    return {status: 404, data: {error: 'no route'}};
  }

  ControlApi.request = function (method, path) {
    return route(method, path).then((r) => ({status: r.status, data: clone(r.data)}),
      // 읽기에 실패하면 앞서 받은 카드를 그대로 둔다(app.js는 오류 응답을 받지 않는다).
      () => ({status: 200, data: clone(path === '/operators' ? ops.map(summarize) : detail(empty('dev')))}));
  };
  ControlApi.peekOperator = (id) => clone(detail(find(id) || empty(id)));
})();
