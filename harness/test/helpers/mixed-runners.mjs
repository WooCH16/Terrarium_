// 시험용 설정(이슈 #26): 기본 설정은 세 워커 모두 Pi다. 모델마다 CLI가 다른 경로(대체 표, 훅이 걸린 claude CLI 워커,
// agy 샌드박스)를 시험하는 파일은 이 옛 모양의 러너로 고정한다. 실행 CLI가 claude·agy인 경로는 설정으로 여전히 쓸 수 있다.
export const MIXED_RUNNERS = {
  claude: { command: ['claude', '-p', '--model', 'claude-haiku-5-5', '--output-format', 'json'], cli: 'claude', via: 'direct', modelId: 'claude-haiku-5-5' },
  gemini: { command: ['agy', '--model', 'gemini-4-hydrogen-medium', '--output-format', 'json', '--log-file', '{logFile}'], cli: 'agy', via: 'direct', modelId: 'gemini-4-hydrogen-medium' },
};
// cfg(설정 객체)의 claude·gemini 러너를 바꾼 사본을 돌려준다.
export function withMixedRunners(cfg) {
  const c = structuredClone(cfg);
  for (const [m, r] of Object.entries(MIXED_RUNNERS)) if (c.runners[m]) c.runners[m] = structuredClone(r);
  return c;
}
