import { ConfigError } from './config.mjs';
import { PUBLIC_OK, DIFFICULTY, fieldLine } from './protocol.mjs';

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// 대체할 모델이 공개 가능 표시가 없는 이슈라 건너뛰어졌고, 그 뒤로 쓸 모델이 없을 때 던진다(설정 오류가 아니라 그 이슈의 막힘이다).
export class ModelBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelBlockedError';
  }
}

// 이슈 본문의 `공개 가능: 예` 줄. 정확히 한 줄이고 값이 `예`일 때만 true(없거나 여러 줄이거나 다른 값이면 false).
export function publicOkOf(body) {
  const lines = String(body ?? '').split(/\r?\n/).filter((l) => fieldLine(PUBLIC_OK).test(l));
  return lines.length === 1 && new RegExp(`${fieldLine(PUBLIC_OK).source}[ \\t]*\`?예\`?[ \\t]*$`).test(lines[0]);
}

// 지정 모델을 쓸 수 없으면(허용 목록 밖, CLI 없음) 대체 표(fallback)를 따라 순환한다(예: claude → gemini → muse → claude).
// 한 바퀴 돌아 처음 모델로 돌아오면 멈춘다. runners.<모델>.publicOnly가 true인 모델은 opts.publicOk일 때만 대체로 들어간다(지정 모델이면 막지 않는다).
export function resolveModel(requested, cfg, available, opts = {}) {
  if (typeof available !== 'function') {
    throw new ConfigError('available은 함수여야 합니다.');
  }
  if (typeof requested !== 'string' || requested === '') {
    throw new ConfigError(`모델 이름은 비어 있지 않은 문자열이어야 합니다: ${JSON.stringify(requested)}`);
  }
  if (!has(cfg.runners, requested)) {
    const why = requested === 'codex' ? ' (codex는 ADR 0004로 허용 목록에서 뺐습니다)' : '';
    throw new ConfigError(`알 수 없는 모델입니다: ${requested}${why}`);
  }
  const allowed = cfg.allowedModels.includes(requested);
  if (allowed && available(requested)) return { model: requested };

  const reason = allowed
    ? `${requested} CLI 없음`
    : `${requested}는 허용 목록 밖입니다`;
  if (!has(cfg.fallback, requested)) {
    throw new ConfigError(`${reason}, 대체 모델(fallback)도 없습니다.`);
  }
  const tried = [];
  const skipped = [];
  const seen = new Set([requested]);
  let cur = requested;
  while (has(cfg.fallback, cur)) {
    const next = cfg.fallback[cur];
    if (seen.has(next)) { if (tried.length === 0) tried.push(next); break; }
    seen.add(next);
    cur = next;
    if (!cfg.allowedModels.includes(next) || !has(cfg.runners, next) || !available(next)) { tried.push(next); continue; }
    if (cfg.runners[next].publicOnly === true && opts.publicOk !== true) { skipped.push(`${next}(${PUBLIC_OK} 표시 없음)`); continue; }
    return { model: next, replacedFrom: requested, reason, ...(tried.length || skipped.length ? { skipped: [...tried.map((m) => `${m}(쓸 수 없음)`), ...skipped] } : {}) };
  }
  if (skipped.length) {
    throw new ModelBlockedError(`${reason}, 대체할 수 있는 모델이 없습니다(건너뜀: ${[...tried.map((m) => `${m}(쓸 수 없음)`), ...skipped].join(', ')}).`);
  }
  throw new ConfigError(`${reason}, 대체 모델 ${tried.join(', ')}도 쓸 수 없습니다(허용 목록 밖이거나 CLI 없음).`);
}

// 난이도(이슈 #26 뒤 소유자 결정 8-16): 이슈 본문의 `난이도: 쉬움|어려움` 줄(라우팅 route-issue.mjs가 정한다). 없거나 다른 값이면 null.
export const DIFFICULTIES = ['쉬움', '어려움'];
export function difficultyOf(body) {
  const m = new RegExp(`${fieldLine(DIFFICULTY).source}[ \\t]*(쉬움|어려움)(?=[ \\t(]|$)`, 'm').exec(String(body ?? ''));
  return m ? m[1] : null;
}
// 그 모델의 러너가 난이도별 모델(runners.<m>.tiers)을 두면 그 모델 ID, 아니면 기본 modelId. 난이도를 모르면 기본(가장 강한 쪽)을 쓴다.
export function modelIdFor(cfg, model, difficulty) {
  const r = cfg.runners[model] ?? {};
  return (difficulty && r.tiers?.[difficulty]) || r.modelId || null;
}

export function runnerCommand(model, { worktree, promptFile, logFile, difficulty = null }, cfg) {
  if (!has(cfg.runners, model)) {
    throw new ConfigError(`알 수 없는 모델입니다: ${model}`);
  }
  if (!cfg.allowedModels.includes(model)) {
    throw new ConfigError(`허용 목록 밖의 모델은 실행할 수 없습니다: ${model}`);
  }
  const [bin, ...rest] = cfg.runners[model].command;
  if (bin === undefined) {
    throw new ConfigError(`runners.${model}.command가 비어 있습니다.`);
  }
  const subst = { '{worktree}': worktree, '{promptFile}': promptFile, ...(logFile === undefined ? {} : { '{logFile}': logFile }) };
  const r = cfg.runners[model];
  const id = modelIdFor(cfg, model, difficulty);
  // 난이도별 모델: 명령 안의 기본 modelId 토큰을 그 난이도의 모델 ID로 바꾼다.
  const args = rest.map((t) => (has(subst, t) ? subst[t] : (r.tiers && t === r.modelId ? id : t)));
  return { bin, args, modelId: id };
}
