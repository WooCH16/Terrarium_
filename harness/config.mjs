// 코디네이터가 쓰는 수치(docs/01-overview.md 8절의 시작값)와 워커 모델 허용 값을 읽고 검사한다.
// 오퍼레이터가 쓰는 값(워커 재시도, 세션 재시작 등)은 operator/operator.config.json에 있다.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_COORDINATOR_CONFIG = join(dirname(fileURLToPath(import.meta.url)), 'coordinator.config.json');

export class CoordinatorConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoordinatorConfigError';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SCALARS = [
  'reworkLimitPerIssue',
  'blockedIssuesReportThreshold',
  'cancelledIssuesCleanupThreshold',
  'preferenceProposalAtRepeat',
  'advisorRevisionAfterReject',
  'researchRetry',
  'recentContextPercent',
  'preserveListPercent',
  'noResponseMinutes',
];
const GROUPS = {
  lightCheck: ['maxFiles', 'maxReads'],
  researchResult: ['maxLines', 'maxTokens'],
  bigToolOutput: ['lines', 'tokens'],
};
// ADR 0004 결정 A: codex는 허용 목록에서 뺐다.
export const WORKER_MODELS = ['claude', 'gemini', 'muse'];

function checkKeys(obj, keys, where) {
  for (const k of keys) if (!(k in obj)) throw new CoordinatorConfigError(`${where}에 필수 키 ${k}가 없습니다.`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw new CoordinatorConfigError(`${where}에 알 수 없는 키 ${k}가 있습니다.`);
}
const positiveInt = (v, where) => {
  if (!Number.isInteger(v) || v < 1) throw new CoordinatorConfigError(`${where}는 1 이상의 정수여야 합니다: ${JSON.stringify(v)}`);
};

export function loadCoordinatorConfig(file = DEFAULT_COORDINATOR_CONFIG) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CoordinatorConfigError(`설정 파일을 읽을 수 없습니다: ${file} (${e.message})`);
  }
  if (!isObject(parsed)) throw new CoordinatorConfigError('설정 파일의 최상위는 객체여야 합니다.');
  checkKeys(parsed, ['workerModels', ...SCALARS, ...Object.keys(GROUPS)], '설정');
  const { workerModels } = parsed;
  if (!Array.isArray(workerModels) || workerModels.some((m) => typeof m !== 'string' || m === '')) {
    throw new CoordinatorConfigError('workerModels는 비어 있지 않은 문자열 배열이어야 합니다.');
  }
  if (new Set(workerModels).size !== workerModels.length) throw new CoordinatorConfigError('workerModels에 같은 값이 두 번 있습니다.');
  const bad = workerModels.filter((m) => !WORKER_MODELS.includes(m));
  if (bad.length > 0) throw new CoordinatorConfigError(`허용되지 않는 워커 모델입니다: ${bad.join(', ')} (허용: ${WORKER_MODELS.join(', ')})`);
  for (const k of SCALARS) positiveInt(parsed[k], k);
  for (const [group, keys] of Object.entries(GROUPS)) {
    if (!isObject(parsed[group])) throw new CoordinatorConfigError(`${group}는 객체여야 합니다.`);
    checkKeys(parsed[group], keys, group);
    for (const k of keys) positiveInt(parsed[group][k], `${group}.${k}`);
  }
  return parsed;
}
