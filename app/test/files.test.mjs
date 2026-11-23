// 관제탑 오른쪽 폴더 패널(app/lib/files.mjs): 고른 폴더 안만 읽고, 바깥·링크로는 나가지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDir, safeRel, isIgnored, changeRel } from '../lib/files.mjs';

const root = mkdtempSync(join(tmpdir(), 'files-'));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'src', 'deep'), { recursive: true });
mkdirSync(join(root, '.git'));
mkdirSync(join(root, 'node_modules'));
writeFileSync(join(root, 'b.md'), 'b');
writeFileSync(join(root, 'A.txt'), 'a');
writeFileSync(join(root, '.env'), 'x');
writeFileSync(join(root, 'src', 'main.js'), 'm');

test('목록: 폴더 먼저, 이름순(대소문자 무시), 숨김 파일도 보이고 .git은 뺀다', () => {
  const r = listDir(root, '');
  assert.deepEqual(r.map((e) => [e.name, e.dir]), [['node_modules', true], ['src', true], ['.env', false], ['A.txt', false], ['b.md', false]]);
  assert.deepEqual(listDir(root, 'src').map((e) => e.name), ['deep', 'main.js']);
});

test('safeRel: 바깥으로 나가는 경로·절대 경로는 거부한다', () => {
  assert.equal(safeRel('src/deep'), 'src/deep');
  assert.equal(safeRel('src\\deep'), 'src/deep');
  assert.equal(safeRel(''), '');
  for (const bad of ['..', '../x', 'src/../../x', 'C:/Windows', '/etc', 'a\0b', 7]) assert.equal(safeRel(bad), null, String(bad));
  assert.throws(() => listDir(root, '../'), /경로/);
});

test('링크된 폴더는 따라가지 않는다(목록에는 보이지만 열 수 없다)', { skip: process.platform === 'win32' && '윈도에서는 링크 만들기에 권한이 필요하다' }, () => {
  const outside = mkdtempSync(join(tmpdir(), 'files-out-'));
  symlinkSync(outside, join(root, 'link'), 'dir');
  const e = listDir(root, '').find((x) => x.name === 'link');
  assert.equal(e.dir, false);
  assert.equal(e.link, true);
  assert.throws(() => listDir(root, 'link'), /폴더가 아닙니다/);
  rmSync(join(root, 'link'));
  rmSync(outside, { recursive: true, force: true });
});

test('변경 알림: .git·node_modules 안은 무시하고 경로를 / 로 맞춘다', () => {
  assert.equal(isIgnored('.git/index'), true);
  assert.equal(isIgnored('app/node_modules/x/y.js'), true);
  assert.equal(isIgnored('src/main.js'), false);
  assert.equal(changeRel('src\\main.js'), 'src/main.js');
  assert.equal(changeRel('.git\\HEAD'), null);
  assert.equal(changeRel(null), null);
});
