// 관제탑 오른쪽 폴더 패널: 사용자가 고른 폴더의 목록을 읽고, 바뀐 파일을 알린다(읽기 전용).
// 고른 폴더 밖으로는 나가지 않는다: 상대 경로만 받고 `..`·절대 경로는 거부, 링크는 따라가지 않는다.
import { readdirSync, lstatSync, watch } from 'node:fs';
import { join } from 'node:path';

const MAX_ENTRIES = 500;
// 목록에서 뺄 것(.git은 내부 파일이라 보일 필요가 없다). node_modules는 보이되 변경 알림은 무시한다.
const HIDDEN = new Set(['.git']);
const NOISY = /(^|\/)(\.git|node_modules)(\/|$)/;

export function safeRel(rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const r = rel.replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
  if (r === '') return '';
  if (/^[A-Za-z]:/.test(r) || r.startsWith('/')) return null;
  const parts = r.split('/');
  if (parts.some((p) => p === '..' || p === '' || p === '.')) return null;
  return parts.join('/');
}

export function listDir(root, rel) {
  const r = safeRel(rel);
  if (r === null) throw new Error('잘못된 경로입니다.');
  const dir = r ? join(root, ...r.split('/')) : root;
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error('폴더가 아닙니다.');
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (HIDDEN.has(d.name)) continue;
    const link = d.isSymbolicLink();
    out.push({ name: d.name, dir: !link && d.isDirectory(), link });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })));
}

export const isIgnored = (rel) => NOISY.test(rel);

// fs.watch가 준 파일 이름을 패널의 상대 경로로. 무시할 것은 null.
export function changeRel(filename) {
  if (typeof filename !== 'string' || filename === '') return null;
  const r = safeRel(filename);
  if (r === null || r === '' || isIgnored(r)) return null;
  return r;
}

// 폴더 전체를 지켜보고 바뀐 상대 경로를 모아 보낸다(짧은 간격으로 묶음). 닫는 함수를 돌려준다.
export function watchFolder(root, onChanges, { intervalMs = 300 } = {}) {
  const pending = new Set();
  let timer = null;
  const flush = () => { timer = null; if (pending.size) { onChanges([...pending]); pending.clear(); } };
  let w;
  try {
    w = watch(root, { recursive: true }, (_evt, filename) => {
      const r = changeRel(filename);
      if (!r) return;
      pending.add(r);
      if (!timer) timer = setTimeout(flush, intervalMs);
    });
    w.on('error', () => {});
  } catch { return () => {}; }
  return () => { if (timer) clearTimeout(timer); try { w.close(); } catch { /* 이미 닫힘 */ } };
}
