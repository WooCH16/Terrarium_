// 앱 업데이트 알림: GitHub 릴리스에 새 버전이 올라오면 뒤에서 받아 두고 관제탑에 알린다.
// [지금 재시작]이면 바로 깔고 다시 켜고, [나중에]면 다음에 앱을 닫을 때 깔린다(다시 설치할 필요 없음).
// electron-updater를 끼워 받아 시험에서는 가짜를 쓴다. 설치판(app.isPackaged)에서만 켠다.

export const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
export const UPDATE_FIRST_MS = 10 * 1000;

// updater: electron-updater의 autoUpdater 모양(on, checkForUpdates, quitAndInstall)
// send(status): 관제탑에 상태를 알림 { state, version?, percent?, message? }
export class UpdateNotifier {
  constructor(updater, { send = () => {}, log = () => {} } = {}) {
    this.updater = updater;
    this.send = send;
    this.log = log;
    this.status = { state: 'idle' };
    this.timers = [];
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('update-available', (info) => this.set({ state: 'downloading', version: info?.version, percent: 0 }));
    updater.on('download-progress', (p) => {
      if (this.status.state !== 'downloading') return;
      const percent = Math.floor(p?.percent ?? 0);
      if (percent !== this.status.percent) this.set({ ...this.status, percent });
    });
    updater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info?.version ?? this.status.version }));
    updater.on('error', (e) => {
      this.log(`업데이트 확인 실패: ${e?.message ?? e}`);
      // 확인만 실패하면 조용히 둔다(다음 확인 때 다시). 받는 중 실패만 알린다.
      if (this.status.state === 'downloading') this.set({ state: 'error', version: this.status.version, message: String(e?.message ?? e).slice(0, 200) });
    });
  }

  set(status) { this.status = status; this.send(status); }

  check() {
    if (this.status.state === 'ready' || this.status.state === 'downloading') return Promise.resolve(null);
    return Promise.resolve().then(() => this.updater.checkForUpdates()).catch((e) => { this.log(`업데이트 확인 실패: ${e?.message ?? e}`); return null; });
  }

  start({ firstMs = UPDATE_FIRST_MS, everyMs = UPDATE_EVERY_MS, setTimer = setTimeout, setEvery = setInterval } = {}) {
    this.timers.push(setTimer(() => this.check(), firstMs));
    this.timers.push(setEvery(() => this.check(), everyMs));
  }

  // 받아 둔 업데이트를 지금 깐다: 조용히 깔고 다시 켠다.
  install() {
    if (this.status.state !== 'ready') return false;
    this.updater.quitAndInstall(true, true);
    return true;
  }
}
