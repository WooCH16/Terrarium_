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
  // 코디네이터 터미널(관제탑의 ORCHESTRA 칸)
  terminal: {
    // xterm 파일의 위치(앱 의존성). 관제탑 페이지는 저장소 루트에 있어 상대 경로로는 닿지 않는다.
    base: ipcRenderer.sendSync('term:base'),
    start: (opts) => ipcRenderer.invoke('term:start', opts),
    input: (data) => ipcRenderer.send('term:input', data),
    resize: (cols, rows) => ipcRenderer.send('term:resize', { cols, rows }),
    onData: (fn) => listen('term:data', fn),
    onExit: (fn) => listen('term:exit', fn),
    onRetry: (fn) => listen('term:retry', fn),
    openSettings: (tab) => ipcRenderer.invoke('settings:open', { tab }),
  },
});
