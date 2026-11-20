// TypeSafe System One(Jev) 호출(이슈 #44). 리뷰어 판정과 라우팅이 쓴다.
// - HTTP API: POST <endpoint>, 본문 { model, state, questions }, 머리 Authorization: Bearer <키>. 응답 { model, answers, usage }.
// - Jev는 판단(Noul 확률, Choice 보기)만 준다. 판정과 라우팅 결정은 부르는 쪽 코드가 내린다.
// - 호출 실패(네트워크, 시간 초과, 429, 200 아님, 응답 모양 어긋남)는 JevError로 던진다. 실패를 "아니오"로 읽지 않는다.
// - 키: 환경 변수 TYPESAFE_API_KEY, 없으면 실행 폴더의 .env, 그다음 하네스 저장소 루트의 .env의 TYPESAFE_API_KEY 줄.
//   .env는 훅이 모든 역할의 읽기를 막는다. 키는 인자·출력·로그·댓글에 남기지 않는다.
import { readSecret } from './env-file.mjs';

export class JevError extends Error {}

export const KEY_NAME = 'TYPESAFE_API_KEY';

// 키를 찾는다. 돌려주는 값: { key, source } 또는 null. source는 출처 설명(값은 넣지 않는다). 읽는 순서는 env-file.mjs.
export function findJevKey({ env = process.env, run, harnessDir } = {}) {
  const r = readSecret(KEY_NAME, { env, run, harnessDir });
  return r ? { key: r.value, source: r.source } : null;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isProb = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

// 응답 확인: 물은 질문마다 같은 이름·같은 타입의 답이 있어야 한다.
export function checkAnswers(questions, body) {
  if (!isObj(body) || !isObj(body.answers) || typeof body.model !== 'string' || body.model === '') throw new JevError('Jev 응답 모양이 다릅니다(model, answers 없음).');
  for (const [name, q] of Object.entries(questions)) {
    const a = body.answers[name];
    if (!isObj(a) || a.type !== q.type) throw new JevError(`Jev 응답에 질문 ${name}의 답이 없거나 타입이 다릅니다.`);
    if (q.type === 'noul' && !isProb(a.noul)) throw new JevError(`Jev 응답의 ${name}.noul이 0~1 사이 숫자가 아닙니다.`);
    if (q.type === 'choice') {
      const options = Object.keys(q.criteria ?? {});
      if (!options.includes(a.choice) || !isObj(a.probabilities)) throw new JevError(`Jev 응답의 ${name}.choice가 보기에 없습니다.`);
    }
  }
  return body;
}

// 질문들을 한 요청으로 묻는다. jev: 설정의 jev 블록({ endpoint, model, timeoutMs }). fetchImpl은 시험용.
export async function askJev({ jev, key, state, questions, fetchImpl = globalThis.fetch }) {
  if (!key) throw new JevError(`${KEY_NAME}가 없습니다. 환경 변수나 실행 폴더의 .env에 넣으세요.`);
  if (!isObj(questions) || Object.keys(questions).length === 0) throw new JevError('질문이 없습니다.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), jev.timeoutMs);
  let res;
  try {
    res = await fetchImpl(jev.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: jev.model, state, questions }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw retryableError(ctrl.signal.aborted ? `Jev 호출 시간 초과(${jev.timeoutMs}ms)` : `Jev 호출 실패: ${String(e?.message ?? e).split('\n')[0]}`);
  } finally {
    clearTimeout(timer);
  }
  let text = '';
  try { text = await res.text(); } catch { /* 아래에서 모양 오류 */ }
  if (res.status !== 200) {
    let detail = '';
    try { const d = JSON.parse(text)?.detail; detail = typeof d === 'string' ? d : JSON.stringify(d ?? '').slice(0, 200); } catch { detail = text.slice(0, 200); }
    const msg = `Jev 응답 ${res.status}${res.status === 429 ? '(요청 한도 초과)' : ''}${detail ? `: ${detail}` : ''}`;
    // 429와 5xx는 일시적이라 다시 시도한다(retry-after 초를 따른다). 400·401·422 등은 요청이나 키의 문제라 다시 해도 같다.
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : NaN);
      throw retryableError(msg, Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 60) * 1000 : null);
    }
    throw new JevError(msg);
  }
  let body;
  try { body = JSON.parse(text); } catch { throw new JevError('Jev 응답이 JSON이 아닙니다.'); }
  return checkAnswers(questions, body);
}

function retryableError(message, retryAfterMs = null) {
  const e = new JevError(message);
  e.retryable = true;
  e.retryAfterMs = retryAfterMs;
  return e;
}

// 이슈 #25: 일시적 실패(네트워크, 시간 초과, 429, 5xx)는 스크립트가 RETRIES번까지 다시 부른다(결정 4-2의 "2회"를 Jev 호출에 둔다).
// 기다리는 시간은 retry-after가 있으면 그 값(최대 60초), 없으면 1초·3초. 그 밖의 실패(키·요청·응답 모양)는 바로 던진다.
// 돌려주는 응답에 attempts(몇 번째에 성공했는지)를 붙인다. 모두 실패하면 마지막 오류에 시도 횟수를 붙여 던진다.
export const RETRIES = 2;
const BACKOFF_MS = [1000, 3000];
export async function askJevWithRetry(args, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = RETRIES } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await askJev(args);
      return Object.defineProperty(res, 'attempts', { value: attempt, enumerable: false });
    } catch (e) {
      if (!(e instanceof JevError) || !e.retryable || attempt > retries) {
        if (e instanceof JevError && e.retryable) e.message = `${e.message} (${attempt}번 시도)`;
        throw e;
      }
      await sleep(e.retryAfterMs ?? BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
  }
}

// Noul 하나를 세 칸으로 읽는다(스킬 권장 시작값 0.7 / 0.3). 사이 값은 '애매'.
export function readNoul(p, { yes, no }) {
  if (p >= yes) return '예';
  if (p <= no) return '아니오';
  return '애매';
}
