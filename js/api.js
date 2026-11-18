// 목(mock) 백엔드. 실제 서버가 생기면 request()만 fetch로 바꾸면 된다.
// request(method, path, body) -> Promise<{status, data}>
const ControlApi = (function () {
  const db = {
    operators: [
      {id: 'dev', name: '개발팀', state: 'work', log: ['14:02 · 오케스트라로부터 작업 2건 접수', '14:05 · API 구현 워커 호출', '14:21 · 쿼리 최적화 성능 측정 중'],
        workers: [{id: 'dev-1', name: 'API 구현', state: 'work', progress: 72}, {id: 'dev-2', name: '쿼리 최적화', state: 'work', progress: 40}, {id: 'dev-3', name: '모듈 리팩터링', state: 'idle', progress: 0}, {id: 'dev-4', name: '배포 점검', state: 'idle', progress: 100}]},
      {id: 'design', name: '디자인', state: 'idle', log: ['13:40 · 아이콘 정리 전달 완료', '13:52 · 시안 제작 대기열 등록', '14:00 · 새 지시 대기 중'],
        workers: [{id: 'design-1', name: '시안 제작', state: 'idle', progress: 0}, {id: 'design-2', name: '아이콘 정리', state: 'idle', progress: 100}]},
      {id: 'tester', name: '테스터', state: 'work', log: ['14:03 · 개발팀 빌드 수신', '14:10 · 단위 테스트 142건 중 78건 통과', '14:18 · 출력 검증 워커 호출'],
        workers: [{id: 'tester-1', name: '단위 테스트', state: 'work', progress: 55}, {id: 'tester-2', name: '출력 검증', state: 'work', progress: 30}, {id: 'tester-3', name: '회귀 테스트', state: 'idle', progress: 0}]},
      {id: 'plan', name: '기획', state: 'idle', log: ['13:30 · 요구사항 정리 완료', '13:45 · 오케스트라에 결과 보고', '14:00 · 새 지시 대기 중'],
        workers: [{id: 'plan-1', name: '구조 정의', state: 'idle', progress: 0}, {id: 'plan-2', name: '요구사항 정리', state: 'idle', progress: 100}]},
      {id: 'sec', name: '보안팀', state: 'pause', log: ['13:20 · 시크릿 검사 완료', '13:48 · 취약점 스캔 35%에서 일시정지', '13:48 · 재개 지시 대기 중'],
        workers: [{id: 'sec-1', name: '취약점 스캔', state: 'pause', progress: 35}, {id: 'sec-2', name: '권한 점검', state: 'idle', progress: 0}, {id: 'sec-3', name: '시크릿 검사', state: 'idle', progress: 100}]}
    ],
    messages: [
      {from: 'orchestra', text: '시스템 가동 · 오퍼레이터 5기 연결 완료.'},
      {from: 'user', text: '이번 주 리포트 초안부터 시작해줘.'},
      {from: 'orchestra', text: '접수했습니다. 작업을 분해해 개발팀과 테스터에 배정합니다.'},
      {from: 'orchestra', text: '디자인, 기획, 보안팀은 대기 중입니다. 추가 지시를 기다립니다.'}
    ]
  };
  const STATE_LABEL = {work: '작업중', pause: '일시정지', idle: '대기중'};
  const KEYWORDS = [['개발', 'dev'], ['디자인', 'design'], ['테스', 'tester'], ['기획', 'plan'], ['보안', 'sec']];
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const find = (id) => db.operators.find((o) => o.id === id);

  function summarize(o) {
    const n = o.workers.length;
    return {id: o.id, name: o.name, state: o.state, workerCount: n,
      working: o.workers.filter((w) => w.state === 'work').length,
      avg: n ? Math.round(o.workers.reduce((a, w) => a + w.progress, 0) / n) : 0};
  }
  const detail = (o) => Object.assign(summarize(o), {workers: o.workers, log: o.log});

  function setOpState(o, state) {
    if (o.state !== state) o.log.push('지금 · 상태 변경: ' + STATE_LABEL[state]);
    o.state = state;
    if (state === 'work') {
      if (!o.workers.some((w) => w.state === 'work')) {
        const w = o.workers.find((x) => x.progress < 100);
        if (w) w.state = 'work';
      }
      return;
    }
    o.workers.forEach((w) => {
      if (w.state === 'work' || w.state === 'pause') w.state = (state === 'pause' && w.state === 'work') ? 'pause' : 'idle';
    });
    if (state === 'pause') {
      o.workers.forEach((w) => { if (w.state === 'idle' && w.progress > 0 && w.progress < 100) w.state = 'pause'; });
    }
  }

  function postMessage(body) {
    const text = String((body && body.text) || '').trim();
    db.messages.push({from: 'user', text: text});
    let ids = KEYWORDS.filter((p) => text.indexOf(p[0]) >= 0).map((p) => p[1]);
    if (/전체|모두|다들/.test(text)) ids = db.operators.map((o) => o.id);
    const action = /일시정지|정지|멈춰/.test(text) ? 'pause' : (/대기|쉬어|쉬게/.test(text) ? 'idle' : 'work');
    if (!ids.length && action === 'work') ids = ['dev', 'tester'];
    let reply;
    if (!ids.length) {
      reply = '대상 팀을 알려주세요. 예: "보안팀 일시정지"';
    } else {
      const names = ids.map((id) => { const o = find(id); setOpState(o, action); return o.name; });
      const tail = action === 'work' ? '에 작업을 배정했습니다.' : (action === 'pause' ? '을(를) 일시정지했습니다.' : '을(를) 대기 상태로 전환했습니다.');
      reply = '접수했습니다. ' + names.join(', ') + tail;
    }
    db.messages.push({from: 'orchestra', text: reply});
    return {messages: db.messages, operators: db.operators.map(summarize)};
  }

  function route(method, path, body) {
    if (method === 'GET' && path === '/operators') {
      // 폴링할 때마다 작업중 워커의 진행률이 조금씩 오른다
      db.operators.forEach((o) => o.workers.forEach((w) => {
        if (w.state === 'work' && w.progress < 99) w.progress = Math.min(99, w.progress + 1 + Math.floor(Math.random() * 2));
      }));
      return db.operators.map(summarize);
    }
    const m = path.match(/^\/operators\/(\w+)$/);
    if (m) {
      const o = find(m[1]);
      if (!o) throw new Error('operator not found');
      if (method === 'GET') return detail(o);
      if (method === 'PATCH') { setOpState(o, body.state); return summarize(o); }
    }
    if (method === 'GET' && path === '/summary') {
      const all = db.operators.flatMap((o) => o.workers);
      return {operators: db.operators.length, workers: all.length,
        working: all.filter((w) => w.state === 'work').length,
        avg: Math.round(all.reduce((a, w) => a + w.progress, 0) / all.length)};
    }
    if (method === 'GET' && path === '/messages') return db.messages;
    if (method === 'POST' && path === '/orchestra/messages') return postMessage(body);
    throw new Error('no route');
  }

  let onLog = function () {};

  function request(method, path, body) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      setTimeout(() => {
        let status = 200, data;
        try { data = route(method, path, body); } catch (e) { status = 404; data = {error: String(e.message || e)}; }
        onLog(method + ' ' + path + '  ' + status + '  ' + (Date.now() - t0) + 'ms');
        resolve({status: status, data: clone(data)});
      }, 160 + Math.floor(Math.random() * 120));
    });
  }

  return {
    request: request,
    // 화면 전환 직후 빈 화면을 피하기 위한 동기 스냅샷
    peekOperator: (id) => clone(detail(find(id))),
    setLogger: (fn) => { onLog = fn; }
  };
})();
