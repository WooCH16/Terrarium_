// /testgo 화면 시험(app/lib/testgo.mjs) 시험: 시간표 모양과 터미널 입력 가로채기.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testgoTimeline, scanTestgo, typedLines } from '../lib/testgo.mjs';

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

// 화면 기록 줄에 "<35;74;15M<35;77;…"가 쌓이던 문제: Claude Code가 마우스 추적을 켜면 xterm이 마우스 위치를 SGR 순서로 보낸다.
const MOUSE = '\x1b[<35;74;15M\x1b[<35;77;16M\x1b[<0;10;5m';
test('마우스·포커스·붙여넣기 표시는 친 글자가 아니다: 화면 기록 줄에 들어가지 않는다', () => {
  let s = typedLines('', `정렬${MOUSE}\x1b[I 기능\x1b[O 하달해줘\r`);
  assert.deepEqual(s.lines, ['정렬 기능 하달해줘']);
  assert.equal(s.typed, '');
  s = typedLines('', `${MOUSE}${MOUSE}`);
  assert.deepEqual([s.lines, s.typed], [[], ''], '마우스만 움직이면 아무것도 남지 않는다');
  s = typedLines('', '\x1b[200~붙여 넣은 글\x1b[201~\r');
  assert.deepEqual(s.lines, ['붙여 넣은 글']);
  s = typedLines('', '\x1b[M #!'); // 옛 X10 마우스(ESC [ M + 3바이트)
  assert.equal(s.typed, '');
  s = typedLines('abc', '\x1b');
  assert.equal(s.typed, '', 'Esc 키 하나는 친 줄을 비운다');
  s = typedLines('ab', '\x7fc\r');
  assert.deepEqual(s.lines, ['ac']);
});

test('/testgo를 치는 사이에 마우스를 움직여도 /testgo로 알아본다(마우스는 그대로 보낸다)', () => {
  let r = scanTestgo('', '/test');
  r = scanTestgo(r.line, MOUSE);
  assert.deepEqual([r.line, r.forward], ['/test', MOUSE]);
  r = scanTestgo(r.line, 'go');
  r = scanTestgo(r.line, `${MOUSE}\r`);
  assert.equal(r.fire, true);
  assert.equal(r.forward, `${MOUSE}${'\x7f'.repeat(7)}`);
});
