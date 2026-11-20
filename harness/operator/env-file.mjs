// 비밀값 한 줄 읽기: 환경 변수 → 실행 폴더의 .env → 하네스 저장소 루트의 .env 순서(이슈 #44, #26).
// .env는 훅이 모든 역할의 읽기를 막는다. 스크립트만 읽고, 값은 인자·출력·기록에 남기지 않는다.
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

function fromFile(file, name) {
  if (!existsSync(file)) return null;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*(.*?)[ \\t]*$`);
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    const v = m[1].replace(/^(['"])(.*)\1$/, '$2');
    return v === '' ? null : v;
  }
  return null;
}

// 돌려주는 값: { value, source } 또는 null. source는 출처 설명(값은 넣지 않는다).
export function readSecret(name, { env = process.env, run, harnessDir } = {}) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new Error(`비밀값 이름이 올바르지 않습니다: ${name}`);
  if (typeof env[name] === 'string' && env[name].trim() !== '') return { value: env[name].trim(), source: `환경 변수 ${name}` };
  const files = [];
  if (run) files.push(`${fwd(run)}/.env`);
  if (harnessDir) files.push(`${dirname(fwd(harnessDir))}/.env`);
  for (const f of files) {
    const value = fromFile(f, name);
    if (value) return { value, source: f };
  }
  return null;
}
