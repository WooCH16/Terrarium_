import { readFileSync, existsSync } from 'node:fs';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

function checkKeys(obj, keys, where) {
  for (const k of keys) {
    if (!(k in obj)) throw new ConfigError(`${where}에 필수 키 ${k}가 없습니다.`);
  }
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) throw new ConfigError(`${where}에 알 수 없는 키 ${k}가 있습니다.`);
  }
}

// opts.run: 실행 폴더. 있으면 <실행 폴더>/operator.local.json(그 컴퓨터의 소유자 설정, git에 없음, 훅이 쓰기를 막음)을 덮어쓴다.
// 덮어쓸 수 있는 것은 runners.<모델>.publicOnly 하나뿐이다(소유자 결정 8-6을 공개 기본값과 떼어 둔다, ADR 0007).
export const LOCAL_CONFIG_NAME = 'operator.local.json';
export function loadOperatorConfig(file, opts = {}) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`설정 파일을 읽을 수 없습니다: ${file} (${e.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`설정 파일 JSON이 올바르지 않습니다: ${file} (${e.message})`);
  }
  if (!isObject(parsed)) throw new ConfigError('설정 파일의 최상위는 객체여야 합니다.');
  checkKeys(parsed, ['allowedModels', 'runners', 'fallback', 'workerRetries', 'rejectLimit', 'noReportRetries', 'sessionRestarts', 'ci', 'jev'], '설정');
  checkJev(parsed.jev, parsed.allowedModels);
  const { allowedModels, runners, fallback, ci } = parsed;

  for (const key of ['workerRetries', 'rejectLimit', 'noReportRetries', 'sessionRestarts']) {
    if (!Number.isInteger(parsed[key]) || parsed[key] < 0) {
      throw new ConfigError(`${key}는 0 이상의 정수여야 합니다: ${JSON.stringify(parsed[key])}`);
    }
  }
  if (!isStringArray(allowedModels)) throw new ConfigError('allowedModels는 문자열 배열이어야 합니다.');
  if (!isObject(runners)) throw new ConfigError('runners는 객체여야 합니다.');
  for (const [name, r] of Object.entries(runners)) {
    if (!isObject(r) || !isStringArray(r.command)) {
      throw new ConfigError(`runners.${name}.command는 문자열 배열이어야 합니다.`);
    }
    // 선택 키(ADR 0004): cli(어느 CLI로 부르는가), via(pi 경유인가 직접 호출인가), modelId, temporary(임시 경로 표시).
    // publicOnly(소유자 결정 5-3): true면 그 모델에 넘길 때 `공개 가능: 예` 표시가 있어야 한다(입력이 학습에 쓰일 수 있는 등급).
    // 공개 기본 설정은 true다. 소유자 결정 8-6(비공개 내용도 muse에 넘긴다)은 실행 폴더의 operator.local.json에서만 끈다(ADR 0007).
    for (const k of Object.keys(r)) {
      if (!['command', 'cli', 'via', 'modelId', 'temporary', 'publicOnly', 'secretEnv', 'tiers'].includes(k)) throw new ConfigError(`runners.${name}에 알 수 없는 키 ${k}가 있습니다.`);
    }
    if ('publicOnly' in r && typeof r.publicOnly !== 'boolean') throw new ConfigError(`runners.${name}.publicOnly는 true 또는 false여야 합니다.`);
    // tiers(소유자 결정 8-16): 난이도별 모델 ID { 쉬움?, 어려움? }. 쓰려면 modelId가 있고 명령 안에 그 토큰이 있어야 한다(그 자리를 바꿔 끼운다).
    if ('tiers' in r) {
      if (!isObject(r.tiers) || Object.keys(r.tiers).length === 0 || Object.entries(r.tiers).some(([k, v]) => !['쉬움', '어려움'].includes(k) || typeof v !== 'string' || v === '')) throw new ConfigError(`runners.${name}.tiers는 쉬움·어려움을 키로 하는 모델 ID 객체여야 합니다.`);
      if (typeof r.modelId !== 'string' || !r.command.includes(r.modelId)) throw new ConfigError(`runners.${name}.tiers를 쓰려면 modelId가 명령 안에 있어야 합니다.`);
    }
    // secretEnv(이슈 #26): 러너에 넘길 비밀값 환경 변수 이름. 값은 환경 변수나 .env에서 스크립트가 읽는다(env-file.mjs).
    if ('secretEnv' in r && (!isStringArray(r.secretEnv) || r.secretEnv.some((n) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(n)))) throw new ConfigError(`runners.${name}.secretEnv는 대문자 환경 변수 이름의 배열이어야 합니다.`);
    if ('cli' in r && !['pi', 'agy', 'claude'].includes(r.cli)) throw new ConfigError(`runners.${name}.cli는 pi, agy, claude 중 하나여야 합니다.`);
    if ('via' in r && !['pi', 'direct'].includes(r.via)) throw new ConfigError(`runners.${name}.via는 pi 또는 direct여야 합니다.`);
    for (const k of ['modelId', 'temporary']) {
      if (k in r && (typeof r[k] !== 'string' || r[k] === '')) throw new ConfigError(`runners.${name}.${k}는 비어 있지 않은 문자열이어야 합니다.`);
    }
  }
  if (!isObject(fallback)) throw new ConfigError('fallback은 객체여야 합니다.');
  if (!isObject(ci)) throw new ConfigError('ci는 객체여야 합니다.');
  checkKeys(ci, ['mergeQueue', 'cacheKey', 'excludeTests'], 'ci');
  if (!['github', 'local'].includes(ci.mergeQueue)) {
    throw new ConfigError(`ci.mergeQueue는 'github' 또는 'local'이어야 합니다: ${JSON.stringify(ci.mergeQueue)}`);
  }
  if (!isStringArray(ci.cacheKey)) throw new ConfigError('ci.cacheKey는 문자열 배열이어야 합니다.');
  if (!isStringArray(ci.excludeTests)) throw new ConfigError('ci.excludeTests는 문자열 배열이어야 합니다.');

  for (const model of allowedModels) {
    if (!runners[model]) {
      throw new ConfigError(`허용된 모델 ${model}의 runners 항목이 없습니다.`);
    }
  }
  for (const [from, to] of Object.entries(fallback)) {
    if (!allowedModels.includes(to)) {
      throw new ConfigError(`fallback.${from}의 대체 모델 ${to}가 허용 목록(allowedModels)에 없습니다.`);
    }
  }
  if (opts.run) applyLocalOverride(parsed, `${String(opts.run).replace(/\\/g, '/').replace(/\/+$/, '')}/${LOCAL_CONFIG_NAME}`);
  return parsed;
}

// jev(이슈 #44): 리뷰어 판정과 라우팅을 맡는 TypeSafe System One 모델. 워커가 아니므로 allowedModels·runners에 넣지 않는다.
//   endpoint, model(고정 버전 ID), timeoutMs, yes·no(Noul을 예/아니오로 읽는 경계, 사이는 애매 → 거부),
//   routing.workerModels(워커 모델마다 맡길 일의 설명, allowedModels와 같은 키), routing.types(작업·조사의 설명).
function checkJev(jev, allowedModels) {
  if (!isObject(jev)) throw new ConfigError('jev는 객체여야 합니다.');
  checkKeys(jev, ['endpoint', 'model', 'timeoutMs', 'yes', 'no', 'routing'], 'jev');
  if (typeof jev.endpoint !== 'string' || !/^https:\/\/[^\s/]+\/\S*$/.test(jev.endpoint)) throw new ConfigError('jev.endpoint는 https:// 주소여야 합니다.');
  if (typeof jev.model !== 'string' || jev.model === '') throw new ConfigError('jev.model은 비어 있지 않은 문자열이어야 합니다.');
  if (!Number.isInteger(jev.timeoutMs) || jev.timeoutMs <= 0) throw new ConfigError('jev.timeoutMs는 양의 정수여야 합니다.');
  const prob = (v) => typeof v === 'number' && v > 0 && v < 1;
  if (!prob(jev.yes) || !prob(jev.no) || jev.no >= jev.yes) throw new ConfigError('jev.yes와 jev.no는 0과 1 사이이고 no < yes여야 합니다.');
  if (!isObject(jev.routing)) throw new ConfigError('jev.routing은 객체여야 합니다.');
  checkKeys(jev.routing, ['workerModels', 'types', 'difficulty'], 'jev.routing');
  const texts = (o, where) => {
    for (const [k, v] of Object.entries(o)) if (typeof v !== 'string' || v.trim() === '') throw new ConfigError(`${where}.${k}는 비어 있지 않은 설명이어야 합니다.`);
  };
  // workerModels: 라우팅이 고를 수 있는 워커 모델과 그 설명. 허용 목록(allowedModels) 안의 모델만, 하나 이상. 설명이 없는 모델은 라우팅이 고르지 않는다.
  const wm = jev.routing.workerModels;
  if (!isObject(wm) || Object.keys(wm).length === 0) throw new ConfigError('jev.routing.workerModels는 모델 하나 이상의 설명이 든 객체여야 합니다.');
  if (isStringArray(allowedModels)) for (const k of Object.keys(wm)) if (!allowedModels.includes(k)) throw new ConfigError(`jev.routing.workerModels의 ${k}가 허용 목록(allowedModels)에 없습니다.`);
  texts(wm, 'jev.routing.workerModels');
  if (!isObject(jev.routing.types)) throw new ConfigError('jev.routing.types는 객체여야 합니다.');
  checkKeys(jev.routing.types, ['작업', '조사'], 'jev.routing.types');
  texts(jev.routing.types, 'jev.routing.types');
  // difficulty(소유자 결정 8-16): 난이도(쉬움·어려움)의 설명. 러너가 tiers를 두면 난이도에 따라 모델이 갈린다.
  if (!isObject(jev.routing.difficulty)) throw new ConfigError('jev.routing.difficulty는 객체여야 합니다.');
  checkKeys(jev.routing.difficulty, ['쉬움', '어려움'], 'jev.routing.difficulty');
  texts(jev.routing.difficulty, 'jev.routing.difficulty');
}

function applyLocalOverride(cfg, file) {
  if (!existsSync(file)) return;
  let local;
  try {
    local = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`로컬 설정 ${file}을 읽을 수 없습니다(${e.message}).`);
  }
  if (!isObject(local)) throw new ConfigError(`로컬 설정 ${file}의 최상위는 객체여야 합니다.`);
  checkKeys(local, ['runners'], `로컬 설정 ${file}`);
  if (!isObject(local.runners)) throw new ConfigError(`로컬 설정의 runners는 객체여야 합니다.`);
  for (const [name, r] of Object.entries(local.runners)) {
    if (!cfg.runners[name]) throw new ConfigError(`로컬 설정의 runners.${name}은 기본 설정에 없는 모델입니다.`);
    if (!isObject(r)) throw new ConfigError(`로컬 설정의 runners.${name}은 객체여야 합니다.`);
    checkKeys(r, ['publicOnly'], `로컬 설정 runners.${name}`);
    if (typeof r.publicOnly !== 'boolean') throw new ConfigError(`로컬 설정의 runners.${name}.publicOnly는 true 또는 false여야 합니다.`);
    cfg.runners[name].publicOnly = r.publicOnly;
  }
}
