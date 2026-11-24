import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore, addMemo, listMemos } from '../src/memo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'memo-')), 'memos.json');

test('adds and lists in insertion order', () => {
  const store = createStore(tmpFile());
  addMemo(store, 'b', 'second');
  addMemo(store, 'a', 'first');
  assert.deepEqual(listMemos(store).map((m) => m.title), ['b', 'a']);
});

test('persists to file', () => {
  const file = tmpFile();
  addMemo(createStore(file), 'x', 'body');
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].title, 'x');
  assert.equal(listMemos(createStore(file)).length, 1);
});

test('cli list prints tab lines', () => {
  const env = { ...process.env, MEMO_FILE: tmpFile() };
  spawnSync(process.execPath, ['cli.mjs', 'add', 'hello', 'world'], { cwd: root, env });
  const out = spawnSync(process.execPath, ['cli.mjs', 'list'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^1\thello\t\d{4}-\d{2}-\d{2}T/);
});
