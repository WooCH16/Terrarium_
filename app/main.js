// Terrarium 데스크톱 앱의 메인 프로세스(ADR 0010).
// 렌더러는 Node에 직접 닿지 않는다(contextIsolation, sandbox, preload.cjs의 좁은 API만).
// 본창은 관제탑 화면(app/tower: 코디네이터 창 안에 진짜 Claude Code 터미널, 하달된 만큼만 뜨는 Operator·Worker 창)이고,
// 설정 화면(계정·설치·진행)은 본창 위에 겹쳐 띄운다.
import { app, BrowserWindow, WebContentsView, Menu, ipcMain, safeStorage, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pty from 'node-pty';
import { CoordinatorTerminal, coordinatorEnv } from './lib/terminal.mjs';
import { KeyStore, KEY_NAMES, KEY_LABELS } from './lib/keys.mjs';
import { readStatus } from './lib/status.mjs';
import { FlowTracker, readFlowSnapshot } from './lib/flow.mjs';
import { testgoTimeline, scanTestgo } from './lib/testgo.mjs';
import { install, checkInstallInput, originRepo } from './lib/install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fwd = (p) => String(p).replace(/\\/g, '/');
// 하네스 폴더: 설치본은 resources/harness(asar 밖), 개발 중에는 저장소의 harness/.
const harnessDir = fwd(app.isPackaged ? join(process.resourcesPath, 'harness') : join(here, '..', 'harness'));
const dataDir = () => fwd(app.getPath('userData'));
const runsDir = () => `${dataDir()}/runs`;
const keys = () => new KeyStore({ file: `${dataDir()}/keys.json`, safe: safeStorage });
const prefsFile = () => `${dataDir()}/prefs.json`;
const readPrefs = () => { try { return JSON.parse(readFileSync(prefsFile(), 'utf8')); } catch { return {}; } };
const writePrefs = (p) => { mkdirSync(dataDir(), { recursive: true }); writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...p })); };

// 하네스 스크립트·gh는 사용자 컴퓨터의 실행 파일로 돈다(Electron의 Node가 아니다).
// 비동기로 부른다: 동기로 부르면 사전 점검·설치 동안 창이 "응답 없음"이 된다(fable 조언 2).
const exec = (bin, args, opts = {}) => new Promise((done) => {
  let stdout = '';
  let stderr = '';
  let child;
  try { child = spawn(bin, args, { windowsHide: true, env: { ...process.env, ...(opts.env ?? {}) } }); } catch (e) { done({ status: null, stdout, stderr, error: e.message }); return; }
  const timer = setTimeout(() => { try { child.kill(); } catch { /* 이미 끝남 */ } }, opts.timeout ?? 60000);
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  child.on('error', (e) => { clearTimeout(timer); done({ status: null, stdout, stderr, error: e.message }); });
  child.on('close', (code) => { clearTimeout(timer); done({ status: code, stdout, stderr }); });
});
const ghExec = async (args) => { const r = await exec('gh', args, { timeout: 30000 }); if (r.status !== 0) throw new Error(r.stderr || r.error || 'gh 실패'); return r.stdout; };
// 프로세스 트리 끝내기(Windows): 코디네이터가 띄운 하달 대기 등이 남지 않게.
const killTree = (pid) => { if (pid) try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 이미 끝남 */ } };

// 사용자의 node 실행 파일(절대 경로). 의사 터미널(node-pty)은 이름만으로는 실행 파일을 찾지 못한다("File not found").
let nodePath = null;
async function nodeBin() {
  if (nodePath) return nodePath;
  const r = await exec(process.platform === 'win32' ? 'where' : 'which', ['node'], { timeout: 10000 });
  nodePath = (r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /node(\.exe)?$/i.test(l))) || 'node';
  return nodePath;
}
async function claudeBin() {
  // 시험용(설치본에서는 무시): 진짜 claude 대신 가짜 코디네이터(app/test/fake-coordinator.mjs)를 띄운다.
  if (!app.isPackaged && process.env.TERRARIUM_FAKE_CLAUDE) return { bin: await nodeBin(), args: [process.env.TERRARIUM_FAKE_CLAUDE] };
  const { launcher } = await import(pathToFileURL(`${harnessDir}/operator/model-exec.mjs`).href);
  const l = launcher('claude', process.env);
  if (!l) return null;
  // npm 셔틀이 .js 진입 파일을 가리키면 launcher는 현재 실행 파일(여기서는 Electron)을 쓴다: 사용자의 node로 바꾼다.
  return l.bin === process.execPath ? { bin: await nodeBin(), args: l.args } : l;
}

// 관제탑 화면(app/tower). React·글꼴·xterm은 앱 의존성(node_modules)에서 읽는다(설치본은 app.asar 안).
const towerPage = join(here, 'tower', 'index.html');
// statusline 명령은 사용자의 node가 돌리므로 설치본에서는 asar 밖(app.asar.unpacked)의 파일을 가리킨다.
const statuslineScript = fwd(join(here, 'lib', 'statusline.mjs')).replace('/app.asar/', '/app.asar.unpacked/');
const statusFile = () => `${dataDir()}/coordinator-status.json`;
// xterm은 앱의 의존성에서 읽는다(설치본은 app.asar 안).
const xtermBase = pathToFileURL(join(here, 'node_modules', '@xterm')).href;
ipcMain.on('term:base', (e) => { e.returnValue = xtermBase; });

let flow = null; // 관제탑 세션 흐름(하네스 기록 → 화면 이벤트)
let win = null; // 관제탑(본창)
let settingsView = null; // 설정 화면: 본창 안에 겹쳐 띄운다(새 창이 아니다). 뒤의 관제탑·코디네이터 터미널은 그대로 산다
let term = null;
const toTower = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const webPreferences = () => ({ preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false });
function guard(w) {
  // 렌더러 안에서 다른 페이지로 가지 않는다. 바깥 링크는 기본 브라우저로 연다.
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

// 관제탑 화면은 스스로 확대·축소한다(휠, 세션이 뜨면 맞춤). 창 배율은 건드리지 않는다.
function towerWindow({ show = true } = {}) {
  const w = new BrowserWindow({ width: 1440, height: 900, minWidth: 720, minHeight: 520, show, title: 'Terrarium', backgroundColor: '#0e0d0b', webPreferences: { ...webPreferences(), backgroundThrottling: false } });
  w.setMenuBarVisibility(false);
  guard(w);
  w.on('resize', fitSettings);
  // 화면을 (다시) 읽으면 지금 실행의 세션을 다시 보낸다.
  w.webContents.on('did-finish-load', () => flow?.replay());
  w.on('closed', () => { if (win === w) win = null; });
  return w;
}
function createWindow() {
  win = towerWindow();
  // 메뉴줄은 숨긴다(설정은 오른쪽 위 톱니). 메뉴의 단축키(다시 읽기, 개발자 도구, 끝내기)는 그대로 쓴다.
  win.loadFile(towerPage);
  startFlow();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '설정', submenu: [
      { label: '계정', click: () => openSettings('accounts') },
      { label: '실행 폴더 설치', click: () => openSettings('install') },
      { label: '진행 기록', click: () => openSettings('progress') },
      { type: 'separator' },
      { role: 'quit', label: '끝내기' },
    ] },
    { label: '보기', submenu: [{ role: 'reload', label: '다시 읽기' }, { role: 'toggleDevTools', label: '개발자 도구' }] },
  ]));
}

// 설정 화면: 계정·설치·진행(관제탑 배치에 없는 화면은 여기에 둔다).
// 관제탑 목록의 [설정] 단추가 부르면 본창 안에서 화면만 바뀐다. [저장] 뒤나 [돌아가기]로 관제탑에 돌아온다.
function fitSettings() {
  if (!settingsView || !win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  settingsView.setBounds({ x: 0, y: 0, width: w, height: h });
}
function openSettings(tab = 'accounts', { project } = {}) {
  if (!win || win.isDestroyed()) return null;
  if (!settingsView || settingsView.webContents.isDestroyed()) {
    settingsView = new WebContentsView({ webPreferences: webPreferences() });
    settingsView.setBackgroundColor('#0E0D0B');
    guard(settingsView);
    settingsView.webContents.loadFile(join(here, 'renderer', 'index.html'), { query: { tab, ...(project ? { project } : {}) } });
  } else {
    // 다시 열 때마다 저장하지 않은 입력을 버리고 지금 값을 다시 읽는다. project가 있으면 설치 탭에 채운다.
    settingsView.webContents.send('settings:tab', project ? { tab, project } : tab);
  }
  win.contentView.addChildView(settingsView);
  fitSettings();
  settingsView.webContents.focus();
  return settingsView;
}
function closeSettings() {
  if (!settingsView || !win || win.isDestroyed()) return;
  win.contentView.removeChildView(settingsView);
  win.webContents.focus();
}

// ---- 계정 (#36) ----
ipcMain.handle('preflight', async (_e, { repo } = {}) => {
  if (repo !== undefined && !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) return { ok: false, error: '지정 저장소는 <소유자>/<이름> 모양이어야 합니다.' };
  const args = [`${harnessDir}/preflight.mjs`, '--json', ...(repo ? ['--repo', repo] : [])];
  const r = await exec('node', args, { timeout: 180000, env: keys().env() });
  if (r.error && r.status === null) return { ok: false, error: `node를 실행하지 못했습니다(${r.error}). Node 22 이상을 설치하세요.` };
  let report;
  try { report = JSON.parse(r.stdout); } catch { return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 500) }; }
  // 대화 시작 잠금(#36): 워커 모델 계정이 하나도 없거나 Jev 키가 없으면 사전 점검이 실패한다. 마지막 결과를 기억한다.
  writePrefs({ preflightOk: report.ok === true, preflightAt: new Date().toISOString() });
  if (report.ok === true) toTower('term:retry', {});
  return { ok: true, report };
});
ipcMain.handle('keys:status', () => ({ names: KEY_NAMES, labels: KEY_LABELS, has: keys().status(), encryption: safeStorage.isEncryptionAvailable?.() }));
ipcMain.handle('keys:set', (_e, { name, value }) => { try { keys().set(name, value); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
const LOGINS = { claude: 'claude', gh: 'gh auth login', 'pi-anthropic': 'pi auth login anthropic', 'pi-meta': 'pi auth login meta' }; // pi-meta: muse 워커(meta/muse-spark-…)
ipcMain.handle('login:open', (_e, { which }) => {
  const cmd = LOGINS[which];
  if (!cmd) return { ok: false, error: '알 수 없는 로그인입니다.' };
  // 로그인은 각 CLI의 대화형 창에서 한다(결정 9-6). 앱은 창만 띄운다.
  // cmd는 현재 폴더의 실행 파일을 먼저 찾으므로 절대 경로(ComSpec)와 앱 데이터 폴더를 쓴다.
  const comspec = process.env.ComSpec || 'C:/Windows/System32/cmd.exe';
  spawn(comspec, ['/c', 'start', '', comspec, '/k', cmd], { cwd: dataDir(), detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { ok: true };
});

// ---- 설치 (#38) ----
ipcMain.handle('project:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: '대상 프로젝트(git 폴더) 고르기', properties: ['openDirectory'] });
  return r.canceled ? null : fwd(r.filePaths[0]);
});
// 렌더러 입력에서는 세 값만 받는다(harnessDir·runsDir를 덮어쓰지 못하게, fable 조언 2).
// 지정 저장소가 없으면 만들지 여기서 묻는다(결정 8-28). 동의는 이 창의 단추로만 받는다(렌더러 입력으로는 만들기를 켤 수 없다). 기본 선택은 만들지 않음.
// 대상 프로젝트의 origin이 GitHub 저장소면 하네스 워크플로(결정 8-32)를 PR 하나로 넣을지 여기서 묻는다. 동의도 이 창의 단추로만 받는다. 기본 선택은 넣지 않음.
// 넣지 않아도 설치는 되고, 하네스는 로컬 흐름(run-reflect)으로 돈다.
ipcMain.handle('install', async (e, input = {}) => {
  const parent = BrowserWindow.fromWebContents(e.sender) ?? win;
  const targetRepo = checkInstallInput({ repo: input.repo, runName: input.runName, project: input.project }) ? null : await originRepo(input.project, exec);
  let addWorkflows = false;
  if (targetRepo) {
    const w = await dialog.showMessageBox(parent, { type: 'question', buttons: ['워크플로 PR 만들기', '넣지 않기'], defaultId: 1, cancelId: 1, message: `대상 저장소 ${targetRepo}에 하네스 워크플로를 넣을까요?`, detail: `이슈 PR, 하달 PR, 머지 트레인, 기본 CI 워크플로를 브랜치 하나와 PR 하나로 올립니다. main에는 쓰지 않고, 머지는 직접 합니다. 넣지 않으면 하네스는 로컬 흐름으로 돌고 끝 보고에 "CI 없음"을 적습니다.` });
    addWorkflows = w.response === 0;
  }
  const base = { harnessDir, runsDir: runsDir(), exec, repo: input.repo, runName: input.runName, project: input.project, targetRepo, addWorkflows };
  const first = await install(base);
  if (!first.missing) return first;
  const c = await dialog.showMessageBox(parent, { type: 'question', buttons: ['비공개로 만들기', '취소'], defaultId: 1, cancelId: 1, message: `지정 저장소 ${input.repo}가 없습니다. 만들까요?`, detail: `gh repo create ${input.repo} --private 로 이 GitHub 계정에 비공개 저장소를 만든 뒤 설치를 이어 갑니다. 이슈, 제안문, 판정, 보고서, 기록 문서가 여기에 쌓입니다.` });
  if (c.response !== 0) return { ok: false, error: `${first.error} 만들지 않았습니다. 저장소를 직접 만들거나 이름을 고친 뒤 다시 설치하세요.` };
  return install({ ...base, createRepo: true });
});
function knownRuns() {
  const dir = runsDir();
  const own = existsSync(dir) ? readdirSync(dir).filter((n) => existsSync(`${dir}/${n}/harness.json`)).map((n) => `${dir}/${n}`) : [];
  // 터미널로 만든 실행 폴더도 열 수 있다(runs:add로 고른 것).
  const extra = (readPrefs().extraRuns ?? []).filter((r) => existsSync(`${r}/harness.json`));
  return [...new Set([...own, ...extra])];
}
// 렌더러가 주는 실행 폴더는 목록에 있는 것만 받는다.
const allowedRun = (run) => typeof run === 'string' && knownRuns().includes(run);
ipcMain.handle('runs:list', () => {
  const runs = knownRuns();
  const cur = readPrefs().currentRun;
  return { runs, current: runs.includes(cur) ? cur : runs[0] ?? null };
});
// 실행 폴더가 아닌 폴더(harness.json 없음): 대상 프로젝트로 설치할지 묻는다. 설치는 설정의 설치 탭에서(값을 채워 넘긴다).
// 돌려주는 값: 'install'(설치 탭으로 넘김), null(취소).
async function askInstallProject(folder) {
  const c = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['설치하러 가기', '취소'], defaultId: 0, cancelId: 1,
    message: '이 프로젝트를 대상 프로젝트로 설치할까요?',
    detail: `${folder}\n\n실행 폴더가 아닙니다(harness.json 없음). 설치하면 새 실행 폴더를 만들고 이 프로젝트를 그 안에 복제해 일합니다. 원본 폴더는 건드리지 않습니다.`,
  });
  if (c.response === 0) { openSettings('install', { project: folder }); return 'install'; }
  return null;
}
// 실행 폴더를 목록에 더한다(다른 하네스 폴더를 쓰면 묻는다). 고르지 않으면 false.
async function addRunFolder(run) {
  let theirs = null;
  try { theirs = fwd(JSON.parse(readFileSync(`${run}/harness.json`, 'utf8')).harnessDir); } catch { /* 아래에서 알린다 */ }
  if (theirs !== harnessDir) {
    const c = await dialog.showMessageBox(win, { type: 'warning', buttons: ['그래도 열기', '취소'], defaultId: 1, cancelId: 1, message: '이 실행 폴더는 다른 하네스 폴더를 씁니다.', detail: `실행 폴더의 하네스: ${theirs ?? '읽지 못함'}\n이 앱의 하네스: ${harnessDir}\n\n같은 버전으로 맞추려면 setup.mjs --refresh를 실행하세요.` });
    if (c.response !== 0) return false;
  }
  writePrefs({ extraRuns: [...new Set([...(readPrefs().extraRuns ?? []), run])] });
  return true;
}
// 폴더 고르기 창 → 실행 폴더면 목록에 더하고 고른다. 일반 프로젝트면 설치할지 묻는다.
async function pickRunFolder() {
  const r = await dialog.showOpenDialog(win, { title: '실행 폴더 열기(일반 프로젝트를 고르면 설치할지 묻습니다)', properties: ['openDirectory'] });
  if (r.canceled) return { ok: false };
  const run = fwd(r.filePaths[0]);
  if (!existsSync(`${run}/harness.json`)) {
    const a = await askInstallProject(run);
    return { ok: false, install: a === 'install' ? run : undefined };
  }
  if (!(await addRunFolder(run))) return { ok: false };
  selectRun(run);
  return { ok: true, run };
}
ipcMain.handle('runs:add', pickRunFolder);
// 실행 폴더를 바꾸면 지금 터미널을 닫고 관제탑에 다시 띄우라고 알린다. 화면의 세션도 그 폴더의 기록으로 새로 센다.
function selectRun(run) {
  const changed = readPrefs().currentRun !== run;
  writePrefs({ currentRun: run });
  if (changed) { stopTerm(); toTower('term:retry', { stopped: true }); resetFlow(); }
}
ipcMain.handle('runs:select', (_e, { run }) => { if (run !== '' && !allowedRun(run)) return { ok: false }; selectRun(run); return { ok: true }; });

// ---- 관제탑 세션 흐름 (app/lib/flow.mjs) ----
// 지금 실행 폴더의 하네스 기록을 1초마다 읽어 화면 이벤트로 보낸다. 읽기만 한다. 실제로 호출된 세션만 화면에 뜬다.
const POLL_MS = 1000;
let flowTimer = null;
let flowRun = null;
let blankSeq = 0;
const flowLog = app.isPackaged ? null : []; // 스모크 시험이 보낸 이벤트 전체를 본다(화면 기록은 6줄만 남는다)
const quietMs = !app.isPackaged && process.env.TERRARIUM_FLOW_QUIET_MS ? Number(process.env.TERRARIUM_FLOW_QUIET_MS) : undefined;
function currentRunOrNull() { const r = readPrefs().currentRun; return allowedRun(r) ? r : null; }
const lingerMs = !app.isPackaged && process.env.TERRARIUM_FLOW_LINGER_MS ? Number(process.env.TERRARIUM_FLOW_LINGER_MS) : undefined;
function resetFlow() {
  stopTestgo(false);
  flowRun = currentRunOrNull();
  // 화면 시험(/testgo) 동안은 진짜 흐름을 계속 세기만 하고 화면에는 보내지 않는다. 끝나면 지금 상태를 다시 보낸다(replay).
  flow = new FlowTracker({ emit: (ev) => { if (flowLog) flowLog.push(ev); if (!testgo) toTower('orchestrator:event', ev); }, quietMs, lingerMs });
  // 화면을 비운다(앞 실행 폴더의 세션이 남지 않게).
  toTower('orchestrator:event', { type: 'run.started', runId: `blank-${++blankSeq}`, text: '' });
  if (flowRun) flow.reset(readFlowSnapshot(flowRun));
}
function startFlow() {
  if (flowTimer) return;
  resetFlow();
  flowTimer = setInterval(() => {
    const run = currentRunOrNull();
    if (run !== flowRun) { resetFlow(); return; }
    if (!run) return;
    try { flow.update(readFlowSnapshot(run)); } catch { /* 기록을 쓰는 중에 읽음: 다음 차례에 다시 읽는다 */ }
  }, POLL_MS);
}
// ---- /testgo: 화면 시험 (app/lib/testgo.mjs) ----
// 코디네이터 터미널에 /testgo를 치면 코디네이터에는 보내지 않고, 가짜 세션 이벤트를 화면에만 보낸다(기본 3분).
// 하네스·모델을 부르지 않고 실행 폴더에 쓰지 않는다. 끝나면 시험 전 화면(진짜 흐름의 지금 상태)으로 돌아간다.
let testgo = null;
const testgoMs = !app.isPackaged && process.env.TERRARIUM_TESTGO_MS ? Number(process.env.TERRARIUM_TESTGO_MS) : 180000;
function startTestgo() {
  stopTestgo(false);
  const d = testgoMs;
  const timeline = testgoTimeline({ runId: `testgo-${++blankSeq}`, durationMs: d, stepMs: Math.min(4000, d / 30), jevEveryMs: Math.min(12000, d / 6), jevMs: Math.min(4000, d / 12) });
  const send = (ev) => { if (flowLog) flowLog.push(ev); toTower('orchestrator:event', ev); };
  testgo = { timers: timeline.map(({ at, ev }) => setTimeout(() => (ev.type === 'test.end' ? stopTestgo(true) : send(ev)), at)) };
}
function stopTestgo(restore) {
  if (!testgo) return;
  testgo.timers.forEach(clearTimeout);
  testgo = null;
  if (!restore) return;
  if (flowLog) flowLog.push({ type: 'test.end' });
  const blank = `blank-${++blankSeq}`;
  toTower('orchestrator:event', { type: 'run.started', runId: blank, text: '' });
  toTower('orchestrator:event', { type: 'coordinator.status', runId: blank, status: flow?.status ?? 'READY' });
  flow?.replay();
}
ipcMain.on('testgo:start', () => startTestgo());
let testLine = '';

// 코디네이터에 보낸 줄(대략): Enter로 보낼 때 화면 기록에 한 줄 남기고, 도는 세션이 없으면 새 실행을 연다.
let typed = '';
function noteInput(data) {
  for (const ch of String(data).replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '').replace(/\x1b./g, '')) {
    if (ch === '\r') { flow?.userLine(typed); typed = ''; }
    else if (ch === '\x7f' || ch === '\b') typed = typed.slice(0, -1);
    else if (ch === '\x03' || ch === '\x15' || ch === '\x1b') typed = '';
    else if (ch >= ' ') typed = (typed + ch).slice(-300);
  }
}

// ---- 관제탑 상단: 실행 폴더 탭, 사용량, 계정, 코디네이터 정보 (실제로 읽은 값만) ----
ipcMain.handle('folders:list', () => {
  const runs = knownRuns();
  const cur = readPrefs().currentRun;
  return { folders: runs.map((p) => ({ name: basename(p), path: p })), current: runs.includes(cur) ? cur : null };
});
ipcMain.handle('folders:select', (_e, { path } = {}) => { if (!allowedRun(path)) return { ok: false }; selectRun(path); return { ok: true }; });
ipcMain.handle('folders:pick', async () => {
  const r = await pickRunFolder();
  return r.ok ? { ok: true, folder: { name: basename(r.run), path: r.run } } : r;
});
const readStatusLine = () => { try { return JSON.parse(readFileSync(statusFile(), 'utf8')); } catch { return null; } };
const hm = (sec) => { const d = new Date(sec * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const md = (sec) => { const d = new Date(sec * 1000); return `${d.getMonth() + 1}/${d.getDate()} ${hm(sec)}`; };
let claudeVersion = null;
async function coordinatorVersion() {
  if (claudeVersion !== null) return claudeVersion;
  claudeVersion = '';
  const c = await claudeBin().catch(() => null);
  if (c && !(!app.isPackaged && process.env.TERRARIUM_FAKE_CLAUDE)) {
    const r = await exec(c.bin, [...c.args, '--version'], { timeout: 20000 });
    claudeVersion = (r.stdout.match(/\d+\.\d+\.\d+/) ?? [''])[0];
  }
  return claudeVersion;
}
ipcMain.handle('app:info', async () => {
  const run = currentRunOrNull();
  const s = readStatusLine();
  const version = s?.version ?? await coordinatorVersion();
  return {
    user: run ? basename(run) : '실행 폴더 없음',
    sub: version ? `Claude Code v${version}` : 'Claude Code',
    product: 'Claude Code',
    version: version ? `v${version}` : '모름',
    model: s?.model ?? '모름(코디네이터가 한 번 답하면 보입니다)',
  };
});
ipcMain.handle('usage:get', () => {
  const s = readStatusLine();
  const meters = [];
  if (s?.fiveHour) meters.push({ label: '5시간 한도', pct: s.fiveHour.pct, resetText: s.fiveHour.resetsAt ? `resets ${hm(s.fiveHour.resetsAt)}` : '', color: '#f07a73' });
  if (s?.sevenDay) meters.push({ label: '주간 한도', pct: s.sevenDay.pct, resetText: s.sevenDay.resetsAt ? `resets ${md(s.sevenDay.resetsAt)}` : '', color: '#f4d58d' });
  if (s && s.context !== null && s.context !== undefined) meters.push({ label: '코디네이터 컨텍스트', pct: s.context, resetText: '/compact로 줄임', color: '#6cb6ff' });
  const at = s?.at ? new Date(s.at) : null;
  const note = meters.length
    ? `코디네이터 statusline에서 읽음 · ${at ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : ''}`
    : '아직 없음: 코디네이터가 한 번 답한 뒤에 보입니다(한도 막대는 Claude Pro·Max 구독에서만 옵니다).';
  return { available: meters.length > 0, meters, note };
});
let ghLogin = { at: 0, value: null };
async function githubLogin() {
  if (Date.now() - ghLogin.at < 300000) return ghLogin.value;
  ghLogin = { at: Date.now(), value: null };
  try { ghLogin.value = (await ghExec(['api', 'user', '--jq', '.login'])).trim() || null; } catch { /* 로그인 안 됨 */ }
  return ghLogin.value;
}
ipcMain.handle('account:get', async () => {
  const run = currentRunOrNull();
  let repo = '';
  try { repo = run ? JSON.parse(readFileSync(`${run}/harness.json`, 'utf8')).designatedRepo ?? '' : ''; } catch { /* 없음 */ }
  const login = await githubLogin();
  const p = readPrefs();
  return {
    name: login ?? 'GitHub 로그인 안 됨',
    email: login ? 'GitHub 계정(gh)' : '설정 → 계정에서 gh 로그인',
    repo: repo || '없음',
    run: run ? basename(run) : '없음',
    preflight: p.preflightOk === true ? '통과' : '필요(설정 → 계정)',
    note: '',
  };
});

// ---- 코디네이터 터미널 (#39, 결정 8-18) ----
// 관제탑의 ORCHESTRA 칸이 부른다. 사람이 직접 치는 대화형 claude라 /compact, Esc 끊기, /login이 그대로 된다.
function stopTerm() { term?.stop(killTree); term = null; }
ipcMain.handle('term:start', async (_e, { fresh = false, cols, rows } = {}) => {
  if (term?.pty) return { ok: true, running: true };
  const prefs = readPrefs();
  const run = prefs.currentRun;
  if (!allowedRun(run)) return { ok: false, error: '실행 폴더가 없습니다. 왼쪽 목록 맨 아래 [설정]의 설치 탭에서 설치하거나 기존 폴더를 고른 뒤 [저장]하세요.' };
  if (prefs.preflightOk !== true) return { ok: false, error: '사전 점검을 먼저 통과하세요. 왼쪽 목록 맨 아래 [설정]의 계정 탭에서 합니다(워커 모델 계정 1곳 이상과 Jev 키가 필요합니다).' };
  const c = await claudeBin();
  if (!c) return { ok: false, error: 'Claude Code(claude)를 찾지 못했습니다. 설치하고 로그인하세요.' };
  // 키는 환경 변수로만 넘긴다. 오퍼레이터를 띄울 claude 실행 파일도 알려 준다(.cmd 셔틀은 못 쓴다).
  const env = { ...coordinatorEnv(process.env), ...keys().env(), ...(c.args.length === 0 ? { HARNESS_CLAUDE_BIN: c.bin } : {}) };
  const resume = fresh ? undefined : prefs.sessions?.[run];
  // 앱이 더하는 설정: statusline 명령 하나(사용량·모델을 관제탑에 보이려고). 실행 폴더의 훅·권한 설정은 그대로다.
  const settingsFile = `${dataDir()}/coordinator-settings.json`;
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: 'command', command: `node "${statuslineScript}" "${statusFile()}"` } }, null, 2));
  const t = new CoordinatorTerminal({
    run, bin: c.bin, preArgs: c.args, env, resume, cols, rows, settingsFile,
    ptySpawn: (bin, args, o) => pty.spawn(bin, args, o),
    onData: (d) => toTower('term:data', d),
    onExit: ({ code }) => { if (term === t) term = null; toTower('term:exit', { code }); },
    onSession: (id) => writePrefs({ sessions: { ...(readPrefs().sessions ?? {}), [run]: id } }),
  });
  term = t;
  try { t.start(); } catch (e) { term = null; return { ok: false, error: `코디네이터를 띄우지 못했습니다: ${e.message}` }; }
  return { ok: true, run, resumed: Boolean(resume) };
});
ipcMain.on('term:input', (_e, data) => {
  if (typeof data !== 'string' || data.length > 100000) return;
  const r = scanTestgo(testLine, data);
  testLine = r.line;
  if (r.forward) { term?.write(r.forward); if (term) noteInput(r.forward); }
  if (r.fire) startTestgo();
});
ipcMain.on('term:resize', (_e, { cols, rows } = {}) => term?.resize(cols, rows));
ipcMain.handle('settings:open', (_e, { tab } = {}) => { openSettings(['accounts', 'install', 'progress'].includes(tab) ? tab : 'accounts'); return { ok: true }; });
ipcMain.handle('settings:close', () => { closeSettings(); return { ok: true }; });
// 설정 화면이 기억하는 값: 지정 저장소 이름(사전 점검·설치 칸을 미리 채운다). 저장은 [저장]을 눌렀을 때만.
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
ipcMain.handle('settings:get', () => ({ designatedRepo: readPrefs().designatedRepo ?? '' }));
ipcMain.handle('settings:save', (_e, { designatedRepo } = {}) => {
  const v = String(designatedRepo ?? '').trim();
  if (v !== '' && !REPO_RE.test(v)) return { ok: false, error: '지정 저장소는 <소유자>/<이름> 모양이어야 합니다.' };
  writePrefs({ designatedRepo: v });
  return { ok: true };
});

// ---- 진행 표시 (#40): 설정 화면의 진행 기록 탭 ----
ipcMain.handle('status', async (_e, { run }) => { if (!allowedRun(run)) return { ok: false, error: '실행 폴더를 고르세요.' }; try { return { ok: true, status: await readStatus(run, ghExec) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('open:url', (_e, { url }) => { if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url); });

// 시험용: TERRARIUM_USER_DATA로 앱 데이터 폴더를 바꾸고, TERRARIUM_SMOKE=<폴더>이면 관제탑을 입력 이벤트로 움직여 검사한 뒤 끝낸다.
// 보통은 app/test/smoke.mjs가 임시 폴더와 가짜 코디네이터(TERRARIUM_FAKE_CLAUDE)를 준비해 부른다. 설치본에서는 시험용 환경 변수를 무시한다.
const testing = !app.isPackaged;
if (testing && process.env.TERRARIUM_USER_DATA) app.setPath('userData', process.env.TERRARIUM_USER_DATA);
// 앱은 하나만 뜬다: 둘이면 같은 실행 폴더에 코디네이터가 둘이 된다.
if (!(testing && process.env.TERRARIUM_SMOKE) && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } });
async function smoke(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  mkdirSync(dir, { recursive: true });
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  };
  const errors = [];
  try {
    win = towerWindow({ show: false });
    const wc = win.webContents;
    wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(String(e.message).slice(0, 160)); });
    wc.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`));
    startFlow();
    await win.loadFile(towerPage);
    win.showInactive();
    const js = (code) => wc.executeJavaScript(code, true);
    const debug = () => js('window.__terrariumDebug ? window.__terrariumDebug() : null');
    const shot = async (name) => writeFileSync(`${dir}/${name}.png`, (await wc.capturePage()).toPNG());
    const rectOf = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    const mouse = (type, x, y, button = 'left', extra = {}) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button, clickCount: type === 'mouseMove' ? 0 : 1, ...extra });
    const click = async (x, y) => { mouse('mouseDown', x, y); await wait(30); mouse('mouseUp', x, y); await wait(80); };
    const until = async (fn, ms) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await wait(200); } return v; };
    const typeInTerminal = async (text) => {
      await js("document.querySelector('#term .xterm-helper-textarea').focus()");
      for (const ch of text) { wc.sendInputEvent({ type: 'char', keyCode: ch }); await wait(15); }
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'char', keyCode: '\r' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    };

    // ---- 첫 화면: 실제 코디네이터 터미널, 세션 없음, 가짜 데이터·장식 없음 ----
    let d = await until(async () => { const x = await debug(); return x && x.term === 'running' ? x : null; }, 15000);
    check('코디네이터 터미널이 코디네이터 창 안에서 뜬다', d && d.term === 'running', d && d.term);
    d = await debug();
    check('처음에는 하위 세션이 없다', d && d.sessions.length === 0, d && d.sessions.length);
    const text = await js('document.body.innerText');
    check('가짜 데이터와 거짓 장식이 없다(YOLO, bypass, 예시 계정·폴더)', !/YOLO|bypass permissions|Kai|Votelanding|예시 데이터/.test(text));
    const inline = await js('[...document.querySelectorAll("#root *")].filter((el) => [...el.attributes].some((a) => a.name.startsWith("on"))).length');
    check('인라인 이벤트 속성이 없다(CSP)', inline === 0, inline);
    const termScale = () => js("(() => { const s = document.querySelector('#term .xterm-screen'); if (!s) return null; return +(s.getBoundingClientRect().width / s.offsetWidth).toFixed(3); })()");
    check('터미널은 화면 배율과 상관없이 1배로 그린다(배율 1)', Math.abs((await termScale()) - 1) < 0.01, await termScale());
    await shot('01-start');

    // ---- 배경·창 다루기 ----
    const size = await js('({ w: innerWidth, h: innerHeight })');
    const bg = { x: 60, y: size.h - 120 };
    await click(bg.x, bg.y);
    d = await debug();
    check('배경 클릭은 화면을 움직이지 않는다', d.cam.x === 0 && d.cam.y === 0 && !d.panning, d.cam);
    mouse('mouseDown', bg.x, bg.y);
    for (let i = 1; i <= 6; i++) { mouse('mouseMove', bg.x + i * 30, bg.y - i * 10, 'left', { modifiers: ['leftButtonDown'] }); await wait(16); }
    mouse('mouseUp', bg.x + 180, bg.y - 60);
    await wait(150);
    d = await debug();
    check('배경 끌기로 화면이 움직인다', d.cam.x === 180 && d.cam.y === -60, d.cam);
    await js('document.querySelector("canvas").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
    await wait(100);
    const bar = await rectOf('[aria-label="Claude Code terminal session"] > div');
    const before = (await debug()).win;
    mouse('mouseDown', bar.x - 120, bar.y);
    for (let i = 1; i <= 5; i++) { mouse('mouseMove', bar.x - 120 + i * 10, bar.y + i * 6, 'left', { modifiers: ['leftButtonDown'] }); await wait(16); }
    mouse('mouseUp', bar.x - 70, bar.y + 30);
    await wait(150);
    d = await debug();
    check('코디네이터 창을 머리줄로 끌어 옮긴다', d.win.dx - before.dx > 30 && !d.dragging, d.win);
    const home = await rectOf('nav button[title^="화면 위치"]');
    await click(home.x, home.y);
    d = await debug();
    check('[처음 화면]이 창 위치를 되돌린다', d.win.dx === 0 && d.win.dy === 0, d.win);
    // 휠로 축소해도 터미널은 1배(글자 선명, 마우스 선택 위치 맞음)
    const canvasPt = { x: 40, y: 200 };
    wc.sendInputEvent({ type: 'mouseWheel', x: canvasPt.x, y: canvasPt.y, deltaX: 0, deltaY: -240, canScroll: true });
    await wait(400);
    d = await debug();
    const zoomed = await termScale();
    check('축소한 화면에서도 터미널은 1배로 그린다', d.cam.z < 0.95 && Math.abs(zoomed - 1) < 0.01, { z: d.cam.z, scale: zoomed });
    await js('document.querySelector("canvas").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
    await wait(300);

    // ---- 위쪽 칸: 실행 폴더, 설정 요약, 계정 ----
    const folderBtn = await rectOf('nav button[aria-haspopup="dialog"]');
    await click(folderBtn.x, folderBtn.y);
    await wait(150);
    const folders = await js(`[...document.querySelectorAll('[role="dialog"][aria-label="실행 폴더"] button')].map((b) => b.textContent)`);
    check('실행 폴더 목록에 실제 실행 폴더가 있다', folders.some((t) => t.includes('smoke-run')), folders);
    await click(folderBtn.x, folderBtn.y);
    const gear = await rectOf('button[aria-label="Settings"]');
    await click(gear.x, gear.y);
    await wait(200);
    const sum = await js(`(document.querySelector('[role="dialog"][aria-label="설정"]') || {}).innerText || ''`);
    check('설정 요약에 실제 값(지정 저장소, 사전 점검, 사용량 출처)이 보인다', /owner\/smoke-issues/.test(sum) && /통과/.test(sum) && /코디네이터가 한 번 답한 뒤|statusline/.test(sum), sum.slice(0, 200));
    await shot('02-settings-popup');
    await js(`[...document.querySelectorAll('[role="dialog"][aria-label="설정"] button')].find((b) => b.textContent.includes('설정 열기')).click()`);
    await wait(900);
    check('[설정 열기]가 본창 안에 설정 화면(계정·설치·진행)을 띄운다', win.contentView.children.includes(settingsView));
    closeSettings();
    await wait(200);
    const prof = await rectOf('button[aria-label="Profile"]');
    await click(prof.x, prof.y);
    await wait(200);
    const acct = await js(`(document.querySelector('[role="dialog"][aria-label="계정 정보"]') || {}).innerText || ''`);
    check('계정 칸에 실행 폴더와 지정 저장소가 보인다', /smoke-run/.test(acct) && /owner\/smoke-issues/.test(acct), acct.slice(0, 200));
    await click(prof.x, prof.y);

    // ---- 하달: 코디네이터 터미널에 지시 → 필요한 만큼만 세션이 뜬다 ----
    // Jev 불빛은 화면 상태를 짧게 자주 읽어 본다(켜진 적이 있는지).
    const jevSeen = { adv: false, ops: false };
    const jevPoll = setInterval(() => { debug().then((x) => { if (x?.jev?.adv) jevSeen.adv = true; if (x?.jev?.ops) jevSeen.ops = true; }).catch(() => {}); }, 150);
    const logFrom = flowLog.length;
    await typeInTerminal('정렬 기능 하달해줘');
    d = await until(async () => { const x = await debug(); return x && x.sessions.filter((s) => s.role === 'wk' && s.st === 'WORKING').length === 2 ? x : null; }, 12000);
    check('하달하면 워커가 일하는 중으로 뜬다', Boolean(d), d && d.sessions.map((s) => `${s.id}:${s.st}`));
    // 오퍼레이터 두 번 누르기 → 그 하달의 워커 목록(읽기 전용). 끝나면 창이 사라지므로 도는 동안 본다.
    const op1 = await rectOf('[aria-label="개발 Operator"] > div');
    if (op1) {
      await click(op1.x, op1.y); await click(op1.x, op1.y);
      await wait(300);
      const rows = await js(`document.querySelectorAll('[role="dialog"][aria-label$="workers"] [title="모델은 하네스 라우팅(Jev)이 정합니다"]').length`);
      check('오퍼레이터를 두 번 누르면 그 하달의 워커 2명이 보인다(모델은 읽기 전용)', rows === 2, rows);
      await shot('03-running');
    } else check('오퍼레이터를 두 번 누르면 그 하달의 워커 2명이 보인다(모델은 읽기 전용)', false, '오퍼레이터 창 없음');
    d = await until(async () => { const x = await debug(); return x && x.coordSt === 'DONE' ? x : null; }, 25000);
    d = d ?? await debug();
    const runEvents = flowLog.slice(logFrom);
    const infos = runEvents.filter((e) => e.type === 'session.spawned').map((e) => e.session);
    const ids = infos.map((s) => s.id).sort();
    const want = ['adv-1', 'op-h1', 'op-h2', 'wk-h1-11', 'wk-h1-12'];
    check('딱 필요한 세션만 뜬다: 어드바이저 1, 하달한 팀의 오퍼레이터 2(개발·테스터), 하달 이슈의 워커 2', JSON.stringify(ids) === JSON.stringify(want), ids);
    const by = Object.fromEntries(infos.map((s) => [s.id, s]));
    check('워커는 자기 하달의 오퍼레이터 아래에 붙는다', by['wk-h1-11']?.parentId === 'op-h1' && by['wk-h1-12']?.parentId === 'op-h1', infos.map((s) => `${s.id}<${s.parentId}`));
    check('오퍼레이터 이름은 맡은 팀이다(개발 Operator, 테스터 Operator). 하달하지 않은 팀(디자인·기획·보안)은 없다', by['op-h1']?.label === '개발 Operator' && by['op-h2']?.label === '테스터 Operator' && !infos.some((s) => /디자인|기획|보안/.test(s.label)), infos.map((s) => s.label));
    check('워커 모델은 하네스가 정한 값이다(claude, gemini)', by['wk-h1-11']?.model === 'claude' && by['wk-h1-12']?.model === 'gemini');
    await wait(800);
    d = await debug();
    const removed = runEvents.concat(flowLog.slice(logFrom + runEvents.length)).filter((e) => e.type === 'session.removed').map((e) => e.id).sort();
    check('일이 끝난 세션(조언 통과한 어드바이저, 끝난 워커·오퍼레이터)은 화면에서 사라진다', d.sessions.length === 0 && JSON.stringify(removed) === JSON.stringify(want) && d.coordSt === 'DONE', { left: d.sessions.map((s) => s.id), removed, coord: d.coordSt });
    const live = await js(`(document.querySelector('[role="toolbar"][aria-label="Status"]').textContent.match(/(\\d+) live/) || [])[1]`);
    check('live 수가 0으로 돌아온다', live === '0', live);
    const flowText = flowLog.filter((e) => e.type === 'coordinator.log').map((e) => e.text);
    const order = [/Advisor 호출/, /Jev 조언 판정: 허용/, /개발 Operator · h1 하달/, /Worker #11 호출/, /테스터 Operator · h2 하달/, /Jev 리뷰어 판정 · 이슈 #11/, /모든 하위 세션 완료/].map((re) => flowText.findIndex((t) => re.test(t)));
    check('화면 기록에 흐름이 순서대로 남는다(어드바이저 → Jev 조언 판정 → 하달 → 워커 → 둘째 하달 → 리뷰어 → 완료)', order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), { order, flowText });
    const jevEv = runEvents.filter((e) => e.type === 'jev.active' || (e.type === 'coordinator.log' && /Jev 리뷰어 판정/.test(e.text)));
    const reviewAt = jevEv.findIndex((e) => e.type === 'coordinator.log');
    check('Jev 판정 때 Jev 불빛이 켜진다(조언 판정 → 어드바이저 쪽, 리뷰어 판정 → 오퍼레이터 쪽)', jevSeen.adv && jevSeen.ops && jevEv.some((e) => e.side === 'adv' && e.on) && jevEv.slice(reviewAt).some((e) => e.side === 'ops' && e.on && !e.ms), { jevSeen, jevEv: jevEv.map((e) => e.type === 'jev.active' ? `${e.side}:${e.on}${e.ms ? ':' + e.ms : ''}` : 'review') });
    await shot('04-done');

    // ---- 하위 세션 없는 차례: 새 실행, 세션 0, 대기로 돌아감 ----
    await typeInTerminal('지금 상태 알려줘');
    await wait(1500);
    d = await debug();
    check('하위 세션 없이 답한 차례에는 세션이 뜨지 않는다', d.sessions.length === 0, d.sessions.map((s) => s.id));
    d = await until(async () => { const x = await debug(); return x && x.coordSt === 'READY' ? x : null; }, 10000);
    check('코디네이터가 잠잠해지면 READY로 돌아간다', d && d.coordSt === 'READY', d && d.coordSt);
    await shot('06-answer-only');

    // ---- /testgo: 화면 시험(어드바이저 3, 오퍼레이터 5, 워커 한 명씩 늘어남, Jev 번갈아, 정해진 시간 뒤 원래 화면) ----
    const tgFrom = flowLog.length;
    jevSeen.adv = false; jevSeen.ops = false;
    await typeInTerminal('/testgo');
    const counts = [];
    const tgEnd = Date.now() + 25000;
    while (Date.now() < tgEnd && !flowLog.slice(tgFrom).some((e) => e.type === 'test.end')) {
      const x = await debug();
      if (x) counts.push({ adv: x.sessions.filter((s) => s.role === 'adv').length, op: x.sessions.filter((s) => s.role === 'op').length, wk: x.sessions.filter((s) => s.role === 'wk').length, labels: x.sessions.filter((s) => s.role === 'op').map((s) => s.label) });
      if (counts.length === 40) await shot('07-testgo');
      await wait(250);
    }
    const maxOf = (k) => Math.max(0, ...counts.map((c) => c[k]));
    const wkSeq = counts.map((c) => c.wk);
    check('/testgo: 어드바이저 3명과 다섯 팀 오퍼레이터가 모두 뜬다', maxOf('adv') === 3 && maxOf('op') === 5 && JSON.stringify(counts.find((c) => c.op === 5)?.labels) === JSON.stringify(['개발 Operator', '디자인 Operator', '테스터 Operator', '기획 Operator', '보안 Operator']), { adv: maxOf('adv'), op: maxOf('op'), labels: counts.find((c) => c.op === 5)?.labels });
    check('/testgo: 워커는 한 명씩 늘어 15명이 된다(줄지 않음)', maxOf('wk') === 15 && wkSeq.every((n, i) => i === 0 || n >= wkSeq[i - 1]) && new Set(wkSeq).size >= 8, wkSeq.join(','));
    check('/testgo: Jev가 번갈아 켜진다', jevSeen.adv && jevSeen.ops, jevSeen);
    check('/testgo: 코디네이터에는 보내지 않는다', !flowLog.slice(tgFrom).some((e) => e.type === 'coordinator.log' && e.text === '❯ /testgo'));
    await wait(600);
    d = await debug();
    check('/testgo: 정해진 시간이 지나면 시험 전 화면으로 돌아간다(세션 0, READY)', flowLog.slice(tgFrom).some((e) => e.type === 'test.end') && d.sessions.length === 0 && d.coordSt === 'READY', { sessions: d.sessions.length, coord: d.coordSt });
    clearInterval(jevPoll);

    // ---- 설정 화면: 저장 확인 흐름(예전 시험 그대로) ----
    const attached = () => win.contentView.children.includes(settingsView);
    const v = openSettings('accounts');
    await wait(900);
    const sjs = (code) => v.webContents.executeJavaScript(code);
    await sjs("document.getElementById('pf-repo').value = 'owner/smoke-issues'; document.getElementById('pf-repo').dispatchEvent(new Event('input'))");
    await sjs("document.getElementById('save').click()");
    await wait(300);
    const confirm = await sjs("({ open: document.getElementById('confirm').open, msg: document.getElementById('confirm-msg').textContent })");
    await sjs("document.getElementById('confirm-yes').click()");
    await wait(800);
    check('설정 [저장] → "저장하시겠습니까?" → 저장하기 → 관제탑으로 돌아온다', confirm.open && !attached() && readPrefs().designatedRepo === 'owner/smoke-issues', confirm);
    check('콘솔 오류가 없다', errors.length === 0, errors.slice(0, 5));
  } catch (e) {
    check('스모크가 끝까지 돌았다', false, String(e?.stack ?? e).slice(0, 600));
  }
  writeFileSync(`${dir}/results.json`, JSON.stringify(results, null, 2));
  const failed = results.filter((x) => !x.ok).length;
  console.log(failed ? `SMOKE FAILED: ${failed} of ${results.length}` : `SMOKE OK: ${results.length} checks`);
  stopTerm();
  app.exit(failed ? 1 : 0);
}
app.whenReady().then(() => (testing && process.env.TERRARIUM_SMOKE ? smoke(process.env.TERRARIUM_SMOKE) : createWindow()));
app.on('window-all-closed', () => { stopTerm(); clearInterval(flowTimer); app.quit(); });
