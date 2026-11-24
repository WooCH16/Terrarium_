import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UpdateNotifier } from '../lib/updater.mjs';

const fake = () => {
  const u = new EventEmitter();
  u.checks = 0; u.installed = null;
  u.checkForUpdates = async () => { u.checks += 1; };
  u.quitAndInstall = (silent, run) => { u.installed = { silent, run }; };
  return u;
};

test('업데이트 알림: 찾으면 받는 중 → 받으면 재시작 대기, 그때만 깐다(조용히 깔고 다시 켬)', async () => {
  const u = fake();
  const sent = [];
  const n = new UpdateNotifier(u, { send: (s) => sent.push(s) });
  assert.equal(u.autoDownload, true);
  assert.equal(u.autoInstallOnAppQuit, true, '[나중에]면 앱을 닫을 때 깔린다');
  assert.equal(n.install(), false, '받기 전에는 깔지 않는다');
  await n.check();
  assert.equal(u.checks, 1);
  u.emit('update-available', { version: '0.2.0-beta.4' });
  u.emit('download-progress', { percent: 41.7 });
  u.emit('download-progress', { percent: 41.9 }); // 같은 %면 다시 안 보냄
  u.emit('update-downloaded', { version: '0.2.0-beta.4' });
  assert.deepEqual(sent.map((s) => [s.state, s.percent ?? null]), [['downloading', 0], ['downloading', 41], ['ready', null]]);
  await n.check();
  assert.equal(u.checks, 1, '받아 둔 뒤에는 다시 확인하지 않는다');
  assert.equal(n.install(), true);
  assert.deepEqual(u.installed, { silent: true, run: true });
});

test('업데이트 알림: 확인 실패는 조용히, 받는 중 실패만 알린다. 주기 확인을 건다', async () => {
  const u = fake();
  const sent = [];
  const logs = [];
  const n = new UpdateNotifier(u, { send: (s) => sent.push(s), log: (m) => logs.push(m) });
  u.checkForUpdates = async () => { throw new Error('오프라인'); };
  assert.equal(await n.check(), null);
  u.emit('error', new Error('오프라인'));
  assert.equal(sent.length, 0);
  assert.equal(logs.length, 2);
  u.emit('update-available', { version: '1.0.0' });
  u.emit('error', new Error('끊김'));
  assert.equal(sent.at(-1).state, 'error');
  const timers = [];
  n.start({ firstMs: 5, everyMs: 7, setTimer: (fn, ms) => timers.push(['once', ms]), setEvery: (fn, ms) => timers.push(['every', ms]) });
  assert.deepEqual(timers, [['once', 5], ['every', 7]]);
});
