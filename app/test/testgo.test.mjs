// /testgo 화면 시험(app/lib/testgo.mjs) 시험: 시간표 모양과 터미널 입력 가로채기.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testgoTimeline, scanTestgo } from '../lib/testgo.mjs';

const spawnedAt = (tl) => tl.filter((x) => x.ev.type === 'session.spawned').map((x) => ({ at: x.at, ...x.ev.session }));

test('/testgo: 어드바이저 3, 오퍼레이터 다섯 팀, 워커는 한 명씩 늘어 n번째 팀 아래 n명, 3분 뒤 끝', () => {
  const tl = testgoTimeline();
  const s = spawnedAt(tl);
  assert.deepEqual(s.filter((x) => x.role === 'advisor').map((x) => x.label), ['Advisor 1', 'Advisor 2', 'Advisor 3']);
  assert.deepEqual(s.filter((x) => x.role === 'operator').map((x) => x.label), ['개발 Operator', '디자인 Operator', '테스터 Operator', '기획 Operator', '보안 Operator']);
  const wk = s.filter((x) => x.role === 'worker');
  assert.equal(wk.length, 15);
  assert.ok(wk.every((w, i) => i === 0 || w.at > wk[i - 1].at), '워커는 한 번에 한 명씩 뜬다');
  const per = ['dev', 'design', 'tester', 'plan', 'sec'].map((t) => wk.filter((w) => w.parentId === `op-${t}`).length);
  assert.deepEqual(per, [1, 2, 3, 4, 5]);
  assert.ok(wk.every((w) => /^Worker #\d+$/.test(w.label)), '워커 이름은 진짜 흐름과 같은 모양');
  assert.equal(tl.at(-1).ev.type, 'test.end');
  assert.equal(tl.at(-1).at, 180000);
  assert.ok(tl.every((x) => x.at <= 180000));
  assert.ok(tl.every((x, i) => i === 0 || x.at >= tl[i - 1].at), '시간 순');
});

test('/testgo: Jev는 일정 간격으로 어드바이저 쪽과 오퍼레이터 쪽이 번갈아 켜진다', () => {
  const jev = testgoTimeline().filter((x) => x.ev.type === 'jev.active');
  assert.ok(jev.length >= 10, String(jev.length));
  assert.deepEqual(jev.slice(0, 4).map((x) => x.ev.side), ['adv', 'ops', 'adv', 'ops']);
  const gaps = new Set(jev.slice(1).map((x, i) => x.at - jev[i].at));
  assert.deepEqual([...gaps], [12000]);
  assert.ok(jev.every((x) => x.ev.on === true && x.ev.ms === 4000));
});

test('/testgo 줄은 코디네이터에 보내지 않고(친 글자는 지움), 다른 줄은 그대로 보낸다', () => {
  let r = scanTestgo('', '/testgo');
  assert.equal(r.forward, '/testgo');
  r = scanTestgo(r.line, '\r');
  assert.equal(r.fire, true);
  assert.equal(r.forward, '\x7f'.repeat(7), 'Enter 대신 지우기');
  assert.equal(r.line, '');
  r = scanTestgo('', '/testgo\r');
  assert.equal(r.fire, true);
  assert.equal(r.forward, `/testgo${'\x7f'.repeat(7)}`);
  r = scanTestgo('', '정렬 기능 하달해줘\r');
  assert.equal(r.fire, false);
  assert.equal(r.forward, '정렬 기능 하달해줘\r');
  r = scanTestgo('/testgox', '\x7f\r');
  assert.equal(r.fire, true, '지우고 고친 줄도 된다');
  r = scanTestgo('/testgo', '\x1b[A');
  assert.deepEqual([r.fire, r.line, r.forward], [false, '', '\x1b[A'], '화살표는 그대로 보내고 줄을 잊는다');
});
