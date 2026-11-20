// 반영 시작: 코디네이터가 사용자의 반영 결정 뒤에 호출한다. 허용 수집 → 의존 제외 → land → 반영됨 표시를 한 번에 돌린다.
// merge-adapter-land와 같은 본체를 쓴다(오퍼레이터 반영 모드 세션은 그쪽을 부른다).
// 사용법: node run-reflect.mjs --handoff h<N>. stdout에는 보고 줄(#번호 | 상태 | url)만, 오류는 stderr에 `오류:` 한 줄.
import { pathToFileURL } from 'node:url';
import { runScript } from './merge-adapter.mjs';

export const main = (argv, env = process.env, deps = {}) => runScript('reflect', argv, env, deps);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
