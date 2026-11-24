import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeLink } from '../lib/links.mjs';

test('터미널 링크: http·https만 기본 브라우저로 연다(로컬 개발 서버 포함)', () => {
  assert.equal(safeLink('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  assert.equal(safeLink('http://localhost:5173/app?x=1'), 'http://localhost:5173/app?x=1');
  assert.equal(safeLink('https://github.com/WooCH16/Terrarium_'), 'https://github.com/WooCH16/Terrarium_');
});

test('터미널 링크: 다른 프로토콜·계정 정보·이상한 값은 열지 않는다', () => {
  for (const bad of ['file:///C:/Windows/System32', 'javascript:alert(1)', 'ms-settings:privacy', 'vscode://x', 'about:blank',
    'http://user:pass@example.com', '\\\\server\\share', '', null, undefined, 42, `https://e.com/${'a'.repeat(3000)}`, ' http://127.0.0.1:3000']) {
    assert.equal(safeLink(bad), null, String(bad).slice(0, 40));
  }
});
