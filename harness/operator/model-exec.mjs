// 워커·리뷰어 실행의 공통 모듈(ADR 0004). 모델 값(claude, gemini, muse)마다 "어떤 CLI로 어떻게 부르는가"를 한 곳에 둔다.
// - 실행 경로는 operator.config.json의 runners.<모델>에 있다: command(기본 명령), cli(pi | agy | claude), via(pi | direct), modelId, temporary.
//   기본 설정은 세 모델 모두 cli:"pi"다(ADR 0009, 이슈 #26). 이 파일의 관찰기(observer)는 cli별로 이미 있다.
// - via:"direct"(claude·agy CLI를 직접 부름)는 설정으로 여전히 쓸 수 있다. claude CLI로 띄우면 하네스 훅이 걸린다.
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { killTree } from './launch.mjs';

export const WORKER_TYPES = ['claude', 'gemini', 'muse'];
export const CLIS = ['pi', 'agy', 'claude'];

const MAX_OUT = 4 * 1024 * 1024;
const MAX_ERR = 64 * 1024;

// ---- 실행 파일 찾기 ----
// 셸 없이 띄우므로 Windows의 npm 셔틀(.cmd)은 직접 실행할 수 없다. .cmd 안의 실제 대상(.js 또는 .exe)을 읽어 푼다.
function unwrapCmdShim(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const all = [...text.matchAll(/"%dp0%\\([^"\r\n]+)"/gi)].map((m) => m[1]).filter((p) => /\.(js|mjs|exe)$/i.test(p));
  const target = all.at(-1);
  if (!target) return null;
  const abs = resolvePath(dirname(file), target.replace(/\\/g, '/'));
  if (!existsSync(abs)) return null;
  return /\.exe$/i.test(abs) ? { bin: abs, args: [] } : { bin: process.execPath, args: [abs] };
}

// name: 'pi' | 'agy' | 'claude'. 돌려주는 값: { bin, args }(앞에 붙일 인자) 또는 null(없음).
// 우선순위: HARNESS_<NAME>_BIN(.js/.mjs면 node로 실행) → PATH의 실행 파일 → (Windows) PATH의 .cmd 셔틀을 풀어서.
export function launcher(name, env = process.env) {
  const override = env[`HARNESS_${name.toUpperCase()}_BIN`];
  if (override) {
    if (!existsSync(override)) return null;
    if (/\.(mjs|js)$/i.test(override)) return { bin: process.execPath, args: [override] };
    return { bin: override, args: [] };
  }
  const path = env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? '';
  const win = process.platform === 'win32';
  if (isAbsolute(name) || /[\\/]/.test(name)) return existsSync(name) ? { bin: name, args: [] } : null;
  for (const dir of path.split(delimiter).filter(Boolean)) {
    if (win) {
      if (existsSync(`${dir}/${name}.exe`)) return { bin: `${dir}/${name}.exe`, args: [] };
      if (existsSync(`${dir}/${name}.cmd`)) { const r = unwrapCmdShim(`${dir}/${name}.cmd`); if (r) return r; }
    } else if (existsSync(`${dir}/${name}`)) return { bin: `${dir}/${name}`, args: [] };
  }
  return null;
}

// ---- 출력 관찰기: 실행 출력에서 "실제 모델 이름"과 응답 본문을 읽는다 ----
// write(chunk)로 stdout을 흘려 넣고 finish()로 결과를 받는다. 결과: { text, model, trace, error }
// model은 출력에서 읽은 값이다(없으면 null). 요청한 값을 그대로 옮겨 적지 않는다.
function piObserver() {
  let buf = '';
  let model = null;
  let provider = null;
  let text = '';
  let error = null;
  const line = (l) => {
    // 시스템 메시지 등 큰 줄은 건너뛰고, 어시스턴트 메시지 줄만 읽는다.
    if (!l.startsWith('{"type":"message_') && !l.startsWith('{"type":"turn_end"')) return;
    if (!l.includes('"role":"assistant"')) return;
    let ev;
    try { ev = JSON.parse(l); } catch { return; }
    const m = ev.message;
    if (!m || m.role !== 'assistant') return;
    if (typeof m.model === 'string' && m.model) { model = m.model; provider = typeof m.provider === 'string' ? m.provider : provider; }
    if (m.stopReason === 'error' || m.errorMessage) error = String(m.errorMessage ?? 'Pi 오류');
    if (ev.type === 'message_end' && Array.isArray(m.content)) {
      const t = m.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
      if (t !== '') text = t;
    }
  };
  return {
    write(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
      if (buf.length > MAX_OUT) buf = '';
    },
    finish() {
      if (buf) line(buf.replace(/\r$/, ''));
      const full = model ? (provider ? `${provider}/${model}` : model) : null;
      return { text, model: full, trace: full ? `pi: message.provider/model=${full}` : null, error };
    },
  };
}

function jsonObserver(read) {
  let buf = '';
  return {
    write(chunk) { if (buf.length < MAX_OUT) buf += chunk; },
    finish(extra = {}) {
      let o;
      try { o = JSON.parse(buf); } catch { return { text: '', model: null, trace: null, error: '출력이 JSON이 아닙니다.' }; }
      return read(o, extra);
    },
  };
}

function claudeObserver() {
  return jsonObserver((o) => {
    const keys = o?.modelUsage && typeof o.modelUsage === 'object' ? Object.keys(o.modelUsage) : [];
    const model = keys.length ? keys.join(',') : null;
    return {
      text: typeof o?.result === 'string' ? o.result : '',
      model,
      trace: model ? `claude: modelUsage=${model}` : null,
      error: o?.is_error ? String(o.result ?? 'claude 오류').slice(0, 300) : null,
    };
  });
}

// agy: 응답 JSON에는 모델 이름이 없다. --log-file의 `Print mode: starting (... model="...")` 줄이 모델과 agy 실행 흔적이다.
export function agyLogModel(logText) {
  const m = /Print mode: starting[^\n]*\bmodel="([^"]+)"/.exec(logText ?? '');
  return m ? m[1] : null;
}
function agyObserver() {
  return jsonObserver((o, { logText } = {}) => {
    const model = agyLogModel(logText);
    const ok = o?.status === 'SUCCESS';
    const conv = typeof o?.conversation_id === 'string' && o.conversation_id !== '' ? o.conversation_id : null;
    return {
      text: typeof o?.response === 'string' ? o.response : '',
      model,
      // 흔적: agy가 돌려준 대화 ID와 agy 로그의 모델 줄. 둘 다 있어야 agy를 실제로 거친 것으로 본다.
      trace: model && conv && ok ? `agy: conversation_id=${conv}, log model="${model}"` : null,
      error: ok ? null : String(o?.error ?? o?.status ?? 'agy 오류').slice(0, 300),
    };
  });
}

export function createObserver(cli) {
  if (cli === 'pi') return piObserver();
  if (cli === 'claude') return claudeObserver();
  if (cli === 'agy') return agyObserver();
  return { write() {}, finish() { return { text: '', model: null, trace: null, error: null }; } };
}

// 요청한 모델 값과 출력에서 읽은 실제 모델 이름이 맞는지(대소문자 무시, 이름 안에 모델 값이 들어 있는지).
const FAMILY = { claude: /claude/i, gemini: /gemini/i, muse: /muse/i };
export function modelMatches(type, actual) {
  return typeof actual === 'string' && actual !== '' && Boolean(FAMILY[type]?.test(actual));
}

// ---- 실행 ----
// 자식 프로세스를 띄워 stdout을 관찰기에 흘리고 끝나면 { code, stderr, timedOut, spawnError }를 돌려준다.
export function runCapture({ bin, args, cwd, env, stdin, timeoutMs = 0, spawn = nodeSpawn, kill = killTree, observer, onPid }) {
  return new Promise((done) => {
    let finished = false;
    let timedOut = false;
    let timer;
    let child;
    let stderr = '';
    const finish = (r) => { if (finished) return; finished = true; clearTimeout(timer); done({ stderr, ...r }); };
    const killChild = () => {
      if (process.platform === 'win32' && child?.pid) { try { kill(child.pid); } catch { /* 이미 끝남 */ } }
      try { child?.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch { /* 이미 끝남 */ }
    };
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { finish({ spawnError: e.message }); return; }
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (c) => { try { observer?.write(String(c)); } catch { /* 관찰 실패는 실행을 막지 않는다 */ } });
    child.stderr?.on('data', (c) => { if (stderr.length < MAX_ERR) stderr += String(c); });
    child.on('error', (e) => { if (child.pid === undefined) finish({ spawnError: e.message }); });
    child.on('close', (code, signal) => finish({ code: code ?? (signal ? 1 : -1), timedOut }));
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin ?? '');
    if (onPid) { try { onPid(child.pid, killChild); } catch (e) { killChild(); finish({ spawnError: String(e.message).slice(0, 200) }); return; } }
    if (timeoutMs > 0) {
      timer = setTimeout(() => { timedOut = true; killChild(); setTimeout(() => finish({ code: 1, timedOut: true }), 2000).unref(); }, timeoutMs);
    }
  });
}
