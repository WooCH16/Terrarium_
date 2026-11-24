// API 키 보관(ADR 0010 결정 6): CLI 로그인이 없는 키만 safeStorage로 암호화해 앱 데이터 폴더의 파일 하나에 둔다.
// 값은 코디네이터 프로세스의 환경 변수로만 넘긴다. 화면·로그에는 값을 보이지 않는다(있음/없음만).
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const KEY_NAMES = ['TYPESAFE_API_KEY', 'GEMINI_API_KEY'];
export const KEY_LABELS = { TYPESAFE_API_KEY: 'Jev(TypeSafe) — 리뷰어·라우팅', GEMINI_API_KEY: 'Gemini — gemini 워커' };

export class KeyStore {
  // safe: Electron safeStorage와 같은 모양({ isEncryptionAvailable, encryptString, decryptString })
  constructor({ file, safe }) { this.file = file; this.safe = safe; }

  read() {
    if (!existsSync(this.file)) return {};
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  status() { const d = this.read(); return Object.fromEntries(KEY_NAMES.map((k) => [k, typeof d[k] === 'string' && d[k] !== ''])); }

  set(name, value) {
    if (!KEY_NAMES.includes(name)) throw new Error(`보관할 수 없는 키 이름입니다: ${name}`);
    const v = String(value ?? '').trim();
    if (/[\r\n]/.test(v) || v.length > 512) throw new Error('키 값 모양이 올바르지 않습니다.');
    if (!this.safe.isEncryptionAvailable()) throw new Error('이 컴퓨터에서 암호화 저장소를 쓸 수 없어 키를 보관하지 않습니다.');
    const d = this.read();
    if (v === '') delete d[name]; else d[name] = this.safe.encryptString(v).toString('base64');
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(d));
    renameSync(`${this.file}.tmp`, this.file);
  }

  // 코디네이터 프로세스에 넘길 환경 변수. 복호화하지 못한 키는 뺀다.
  env() {
    const d = this.read();
    const out = {};
    for (const k of KEY_NAMES) {
      if (typeof d[k] !== 'string' || d[k] === '') continue;
      try { out[k] = this.safe.decryptString(Buffer.from(d[k], 'base64')); } catch { /* 다른 사용자·컴퓨터에서 만든 값 */ }
    }
    return out;
  }
}
