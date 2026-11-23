// Terrarium 데스크톱 앱의 메인 프로세스(ADR 0010).
// 렌더러는 Node에 직접 닿지 않는다(contextIsolation, sandbox, preload.cjs의 좁은 API만).
// 창은 둘이다: 소유자가 만든 관제탑 화면(본창, ORCHESTRA 칸에 코디네이터 터미널)과 설정 창(계정·설치·진행).
import { app, BrowserWindow, WebContentsView, Menu, ipcMain, safeStorage, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pty from 'node-pty';
import { CoordinatorTerminal, coordinatorEnv } from './lib/terminal.mjs';
import { KeyStore, KEY_NAMES, KEY_LABELS } from './lib/keys.mjs';
import { readStatus } from './lib/status.mjs';
import { towerView } from './lib/tower.mjs';
import { install, checkInstallInput, originRepo } from './lib/install.mjs';
import { listDir, watchFolder } from './lib/files.mjs';

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

async function claudeBin() {
  const { launcher } = await import(pathToFileURL(`${harnessDir}/operator/model-exec.mjs`).href);
  const l = launcher('claude', process.env);
  if (!l) return null;
  // npm 셔틀이 .js 진입 파일을 가리키면 launcher는 현재 실행 파일(여기서는 Electron)을 쓴다: 사용자의 node로 바꾼다.
  return l.bin === process.execPath ? { bin: 'node', args: l.args } : l;
}

// 관제탑 화면은 저장소 루트의 것(index.html, css/, js/, assets/)을 그대로 쓴다. 설치본은 resources/tower에 복사된다.
const towerPage = app.isPackaged ? join(process.resourcesPath, 'tower', 'index.html') : join(here, '..', 'index.html');
// xterm은 앱의 의존성에서 읽는다(설치본은 app.asar 안).
const xtermBase = pathToFileURL(join(here, 'node_modules', '@xterm')).href;
ipcMain.on('term:base', (e) => { e.returnValue = xtermBase; });

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

// 관제탑은 880x600 무대다. CSS zoom 대신 창의 확대 배율로 맞춘다(xterm의 글자 칸 계산과 마우스 선택이 CSS zoom에서 어긋난다).
// 오른쪽 폴더 패널 자리(css .files의 최소 폭 + 여백)를 늘 남긴다: 창 모드에서도 패널이 보인다. 넓은 창에서는 패널이 남는 폭을 채운다.
const STAGE_W = 880 + 290;
function fitTower() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  win.webContents.setZoomFactor(Math.max(0.4, Math.min(2, w / STAGE_W, h / 600)));
}

function createWindow() {
  win = new BrowserWindow({ width: 1320, height: 900, minWidth: 660, minHeight: 450, title: 'Terrarium', backgroundColor: '#3A3D42', webPreferences: webPreferences() });
  // 메뉴줄은 숨긴다(설정은 관제탑 목록 맨 아래 단추). 메뉴의 단축키(다시 읽기, 개발자 도구, 끝내기)는 그대로 쓴다.
  win.setMenuBarVisibility(false);
  win.loadFile(towerPage);
  guard(win);
  win.on('resize', () => { fitTower(); fitSettings(); });
  win.webContents.on('did-finish-load', restartFilesWatch);
  win.on('closed', () => stopFilesWatch());
  win.webContents.on('did-finish-load', fitTower);
  win.on('closed', () => { win = null; });
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
    settingsView.setBackgroundColor('#121417');
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
// 돌려주는 값: 'install'(설치 탭으로 넘김), 'view'(보기만, allowView일 때), null(취소).
async function askInstallProject(folder, { allowView = false } = {}) {
  const buttons = allowView ? ['설치하러 가기', '보기만', '취소'] : ['설치하러 가기', '취소'];
  const c = await dialog.showMessageBox(win, {
    type: 'question', buttons, defaultId: 0, cancelId: buttons.length - 1,
    message: '이 프로젝트를 대상 프로젝트로 설치할까요?',
    detail: `${folder}\n\n실행 폴더가 아닙니다(harness.json 없음). 설치하면 새 실행 폴더를 만들고 이 프로젝트를 그 안에 복제해 일합니다. 원본 폴더는 건드리지 않습니다.${allowView ? '\n\n보기만: 오른쪽 패널에 이 폴더를 보이기만 합니다(코디네이터는 그대로).' : ''}`,
  });
  if (c.response === 0) { openSettings('install', { project: folder }); return 'install'; }
  if (allowView && c.response === 1) return 'view';
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
ipcMain.handle('runs:add', async () => {
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
});
// 실행 폴더를 바꾸면 지금 터미널을 닫고 관제탑에 다시 띄우라고 알린다.
function selectRun(run) {
  const changed = readPrefs().currentRun !== run;
  writePrefs({ currentRun: run });
  if (changed) { stopTerm(); toTower('term:retry', { stopped: true }); writePrefs({ filesRoot: '' }); restartFilesWatch(); }
}

// ---- 관제탑 오른쪽 폴더 패널 (읽기 전용) ----
// 보이는 폴더: 사용자가 고른 폴더, 없으면 지금 실행 폴더. 바뀐 파일은 묶어서 관제탑에 알린다(수정 중 = 주황, 끝나면 초록).
// 코디네이터에 다음 지시(Enter)가 들어가면 초록 표시를 지운다(files:reset).
let stopFilesWatch = () => {};
function filesRoot() {
  const p = readPrefs();
  const r = p.filesRoot || p.currentRun || '';
  return r && existsSync(r) ? fwd(r) : '';
}
function restartFilesWatch() {
  stopFilesWatch();
  const root = filesRoot();
  stopFilesWatch = root ? watchFolder(root, (paths) => toTower('files:changes', { root, paths })) : () => {};
  toTower('files:root', { root, kind: filesKind() });
}
const filesKind = () => (readPrefs().filesRoot ? 'view' : 'run');
ipcMain.handle('files:root', () => ({ root: filesRoot(), kind: filesKind() }));
// 오른쪽 패널의 [폴더…]: 작업 폴더 고르기.
// 실행 폴더면 코디네이터를 그 폴더로 옮길지 묻는다. 일반 프로젝트면 대상 프로젝트로 설치할지 묻고, 보기만 하면 패널에만 보인다.
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: '작업 폴더 고르기(실행 폴더 또는 프로젝트 폴더)', properties: ['openDirectory'] });
  if (r.canceled) return { root: filesRoot(), kind: filesKind() };
  const folder = fwd(r.filePaths[0]);
  if (existsSync(`${folder}/harness.json`)) {
    if (folder !== readPrefs().currentRun) {
      const c = await dialog.showMessageBox(win, { type: 'question', buttons: ['바꾸기', '취소'], defaultId: 0, cancelId: 1, message: '이 실행 폴더로 바꿀까요?', detail: `${folder}\n\n코디네이터 터미널을 닫고 이 실행 폴더에서 다시 띄웁니다.` });
      if (c.response === 0 && (await addRunFolder(folder))) selectRun(folder);
    }
  } else if ((await askInstallProject(folder, { allowView: true })) === 'view') {
    writePrefs({ filesRoot: folder });
    restartFilesWatch();
  }
  return { root: filesRoot(), kind: filesKind() };
});
ipcMain.handle('files:list', (_e, { rel } = {}) => {
  const root = filesRoot();
  if (!root) return { ok: false, error: '폴더를 고르세요.' };
  try { return { ok: true, entries: listDir(root, rel ?? '') }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('runs:select', (_e, { run }) => { if (run !== '' && !allowedRun(run)) return { ok: false }; selectRun(run); return { ok: true }; });

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
  const t = new CoordinatorTerminal({
    run, bin: c.bin, preArgs: c.args, env, resume, cols, rows,
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
  term?.write(data);
  // 코디네이터에 다음 지시를 보냈다(Enter): 폴더 패널의 "수정 완료"(초록) 표시를 지운다.
  if (term && data.includes('\r')) toTower('files:reset', {});
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

// ---- 진행 표시 (#40) ----
// 관제탑 카드·팀·통합·사무실(결정 8-19): 지금 실행 폴더의 상태를 읽어 관제탑 모양으로 넘긴다. 읽기만 한다.
// 관제탑은 4초마다 묻는다. 하달 파일은 매번 읽고, GitHub 이슈(gh)는 30초에 한 번만 읽는다.
const towerCache = { run: null, at: 0, issues: null, err: null };
// 30초 안에는 앞서 읽은 것을 준다. 읽기에 실패하면 앞서 읽은 것이 있으면 그것을, 없으면 그 실패를 30초 동안 준다.
const cachedGh = async (args) => {
  if (Date.now() - towerCache.at < 30000) { if (towerCache.issues !== null) return towerCache.issues; if (towerCache.err) throw towerCache.err; }
  towerCache.at = Date.now();
  try { towerCache.issues = await ghExec(args); towerCache.err = null; } catch (e) { towerCache.err = e; if (towerCache.issues === null) throw e; }
  return towerCache.issues;
};
ipcMain.handle('tower:status', async () => {
  const run = readPrefs().currentRun;
  if (!allowedRun(run)) return towerView(null);
  if (towerCache.run !== run) Object.assign(towerCache, { run, at: 0, issues: null, err: null });
  try { return towerView(await readStatus(run, cachedGh)); } catch (e) { return towerView(null, e.message); }
});
ipcMain.handle('status', async (_e, { run }) => { if (!allowedRun(run)) return { ok: false, error: '실행 폴더를 고르세요.' }; try { return { ok: true, status: await readStatus(run, ghExec) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('open:url', (_e, { url }) => { if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url); });

// 시험용: TERRARIUM_USER_DATA로 앱 데이터 폴더를 바꾸고, TERRARIUM_SMOKE=<폴더>이면 창을 보이지 않고 관제탑과 설정 탭을 찍은 뒤 끝낸다.
// 설치본에서는 시험용 환경 변수를 무시한다.
const testing = !app.isPackaged;
if (testing && process.env.TERRARIUM_USER_DATA) app.setPath('userData', process.env.TERRARIUM_USER_DATA);
// 앱은 하나만 뜬다: 둘이면 같은 실행 폴더에 코디네이터가 둘이 된다.
if (!(testing && process.env.TERRARIUM_SMOKE) && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } });
async function smoke(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (w, name) => writeFileSync(`${dir}/${name}.png`, (await w.webContents.capturePage()).toPNG());
  mkdirSync(dir, { recursive: true });
  // 관제탑: 터미널이 뜨고(조건이 맞으면) 첫 화면이 그려질 때까지 기다린 뒤 찍는다.
  win = new BrowserWindow({ width: 1320, height: 900, show: false, webPreferences: webPreferences() });
  await win.loadFile(towerPage);
  restartFilesWatch();
  fitTower();
  await wait(Number(process.env.TERRARIUM_SMOKE_WAIT ?? 8) * 1000);
  await shot(win, 'tower');
  // 터미널 렌더러: WebGL이면 #term 안에 canvas가 있다(로고 블록 문자를 화소로 그린다).
  writeFileSync(`${dir}/terminal-renderer.json`, JSON.stringify({ webgl: await win.webContents.executeJavaScript("Boolean(document.querySelector('#term canvas'))") }));
  // 오른쪽 폴더 패널: 창을 넓혀 패널을 보이고, 고른 폴더(prefs.filesRoot)의 파일을 바꿔 주황 → 초록 → 다음 지시로 지워지는지 본다.
  if (readPrefs().filesRoot) {
    const q = (code) => win.webContents.executeJavaScript(code);
    win.setContentSize(1800, 900);
    fitTower();
    await wait(1200);
    const files = { visible: await q("getComputedStyle(document.getElementById('files')).display !== 'none'"), rows: await q("document.querySelectorAll('#files .f-row').length") };
    writeFileSync(`${readPrefs().filesRoot}/smoke-edit.txt`, String(Date.now()));
    await wait(900);
    files.editing = await q("[...document.querySelectorAll('#files .f-row.editing')].map((r) => r.title)");
    await shot(win, 'files-editing');
    await wait(3200);
    files.done = await q("[...document.querySelectorAll('#files .f-row.done')].map((r) => r.title)");
    await shot(win, 'files-done');
    toTower('files:reset', {});
    await wait(300);
    files.afterNextInstruction = await q("document.querySelectorAll('#files .f-row.done, #files .f-row.editing').length");
    writeFileSync(`${dir}/files-panel.json`, JSON.stringify(files, null, 2));
    win.setContentSize(1320, 900);
    fitTower();
  }
  // 관제탑의 팀 상세·통합·사무실도 눌러서 찍는다(실제 상태가 들어갔는지 보려고).
  for (const [name, sel] of [['tower-team', '.item[data-team="sec"]'], ['tower-total', '.item-total'], ['tower-office', '.tab[data-mode="office"]'], ['tower-back', '.tab[data-mode="matrix"]']]) {
    await win.webContents.executeJavaScript(`document.querySelector('${sel}').click()`);
    await wait(2500);
    await shot(win, name);
  }
  // TERRARIUM_SMOKE_STEPS='[["글자", 기다릴 초], ...]': 실제 코디네이터 터미널에 차례로 쳐 넣고, 단계마다 찍는다.
  const steps = process.env.TERRARIUM_SMOKE_STEPS ? JSON.parse(process.env.TERRARIUM_SMOKE_STEPS) : [];
  for (const [i, [keys, secs]] of steps.entries()) {
    if (!term?.pty) break;
    term.write(keys);
    await wait(Number(secs) * 1000);
    await shot(win, `tower-step${i + 1}`);
  }
  // 본창 안 설정 화면: 열기 → [저장] → "저장하기" → 관제탑으로 돌아오는지 누름으로 확인해 settings-flow.json에 남긴다.
  const attached = () => win.contentView.children.includes(settingsView);
  const flow = {};
  const v = openSettings('accounts');
  await new Promise((r) => v.webContents.once('did-finish-load', r));
  await wait(800);
  flow.openedInWindow = attached();
  const js = (code) => v.webContents.executeJavaScript(code);
  await js("document.getElementById('pf-repo').value = 'owner/smoke-issues'; document.getElementById('pf-repo').dispatchEvent(new Event('input'))");
  flow.dirtyShown = await js("!document.getElementById('dirty').hidden");
  await js("document.getElementById('save').click()");
  await wait(300);
  flow.confirm = await js("({ open: document.getElementById('confirm').open, msg: document.getElementById('confirm-msg').textContent, yes: document.getElementById('confirm-yes').textContent, detail: document.getElementById('confirm-detail').textContent })");
  await js("document.getElementById('confirm-yes').click()");
  await wait(800);
  flow.closedAfterSave = !attached();
  flow.savedRepo = readPrefs().designatedRepo ?? null;
  openSettings('install');
  await wait(500);
  flow.reopenedTab = await js("document.querySelector('[data-tab][aria-selected=\"true\"]').dataset.tab");
  flow.repoPrefilled = await js("document.getElementById('pf-repo').value");
  await js("document.getElementById('back').click()");
  await wait(300);
  flow.closedOnBackWithoutChanges = !attached();
  // 일반 프로젝트를 골라 "설치하러 가기"를 누른 뒤의 화면: 설치 탭에 대상 프로젝트와 실행 폴더 이름이 채워진다.
  openSettings('install', { project: 'C:/work/My Project' });
  await wait(800);
  flow.installPrefill = await js("({ tab: document.querySelector('[data-tab][aria-selected=\"true\"]').dataset.tab, project: document.getElementById('in-project').value, name: document.getElementById('in-name').value })");
  closeSettings();
  writeFileSync(`${dir}/settings-flow.json`, JSON.stringify(flow, null, 2));
  // 화면 그림은 같은 설정 페이지를 숨긴 창에 따로 띄워 찍는다(본창 안 보기는 숨긴 창에서 찍히지 않는다).
  const sw = new BrowserWindow({ width: 1320, height: 900, show: false, webPreferences: webPreferences() });
  await sw.loadFile(join(here, 'renderer', 'index.html'), { query: { tab: 'accounts' } });
  for (const tab of ['accounts', 'install', 'progress']) {
    sw.webContents.send('settings:tab', tab);
    await wait(tab === 'progress' ? 4000 : 800);
    await shot(sw, tab);
  }
  await sw.webContents.executeJavaScript("document.getElementById('save').click()");
  await wait(400);
  await shot(sw, 'confirm');
  stopTerm();
  app.quit();
}
app.whenReady().then(() => (testing && process.env.TERRARIUM_SMOKE ? smoke(process.env.TERRARIUM_SMOKE) : createWindow()));
app.on('window-all-closed', () => { stopTerm(); app.quit(); });
