import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function createStore(filePath) {
  return { filePath };
}

function load(store) {
  return existsSync(store.filePath) ? JSON.parse(readFileSync(store.filePath, 'utf8')) : [];
}

export function addMemo(store, title, body) {
  const memos = load(store);
  const memo = { id: memos.length + 1, title, body, createdAt: new Date().toISOString() };
  memos.push(memo);
  writeFileSync(store.filePath, JSON.stringify(memos, null, 2));
  return memo;
}

export function listMemos(store) {
  return load(store);
}
