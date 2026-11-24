// 렌더러에 여는 API는 이것뿐이다(contextIsolation). Node·파일 시스템은 열지 않는다.
// 관제탑 화면은 terminal 묶음만, 설정 창은 나머지를 쓴다.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld('terrarium', {
  preflight: (repo) => ipcRenderer.invoke('preflight', { repo }),
  keyStatus: () => ipcRenderer.invoke('keys:status'),
  setKey: (name, value) => ipcRenderer.invoke('keys:set', { name, value }),
  openLogin: (which) => ipcRenderer.invoke('login:open', { which }),
  pickProject: () => ipcRenderer.invoke('project:pick'),
  install: (input) => ipcRenderer.invoke('install', input),
  listRuns: () => ipcRenderer.invoke('runs:list'),
  selectRun: (run) => ipcRenderer.invoke('runs:select', { run }),
  addRun: () => ipcRenderer.invoke('runs:add'),
  status: (run) => ipcRenderer.invoke('status', { run }),
  openUrl: (url) => ipcRenderer.invoke('open:url', { url }),
  onSettingsTab: (fn) => listen('settings:tab', fn),
  // 설정 화면(본창 안): 기억한 값 읽기, [저장], 관제탑으로 돌아가기
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  // 관제탑(app/tower): 하네스 기록에서 나온 세션 이벤트(읽기 전용). 이벤트 모양은 docs/app-screen.md
  orchestrator: {
    onEvent: (fn) => {
      const l = (_e, ev) => fn(ev);
      ipcRenderer.on('orchestrator:event', l);
      return () => ipcRenderer.removeListener('orchestrator:event', l);
    },
  },
  // 관제탑 위쪽 칸: 코디네이터 정보, 사용량, 계정, 실행 폴더(실제로 읽은 값만)
  app: { info: () => ipcRenderer.invoke('app:info') },
  usage: { get: () => ipcRenderer.invoke('usage:get') },
  account: { get: () => ipcRenderer.invoke('account:get') },
  folders: {
    list: () => ipcRenderer.invoke('folders:list'),
    select: (path) => ipcRenderer.invoke('folders:select', { path }),
    pick: () => ipcRenderer.invoke('folders:pick'),
  },
  // 코디네이터 터미널(관제탑의 코디네이터 창)
  terminal: {
    // xterm 파일의 위치(앱 의존성, 설치본은 app.asar 안)
    base: ipcRenderer.sendSync('term:base'),
    start: (opts) => ipcRenderer.invoke('term:start', opts),
    input: (data) => ipcRenderer.send('term:input', data),
    resize: (cols, rows) => ipcRenderer.send('term:resize', { cols, rows }),
    onData: (fn) => listen('term:data', fn),
    onExit: (fn) => listen('term:exit', fn),
    onRetry: (fn) => listen('term:retry', fn),
    openSettings: (tab) => ipcRenderer.invoke('settings:open', { tab }),
    // /testgo: 화면 시험(가짜 세션 이벤트, 3분 뒤 원래 화면)
    testgo: () => ipcRenderer.send('testgo:start'),
  },
});
