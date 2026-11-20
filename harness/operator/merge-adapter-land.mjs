// 반영: 리뷰어가 허용한 40자리 해시의 커밋만 main에 병합한다(오퍼레이터 반영 모드).
// 사용법: node merge-adapter-land.mjs --handoff h<N>. stdout에는 보고 줄(#번호 | 상태 | url)만, 오류는 stderr에 `오류:` 한 줄.
import { pathToFileURL } from 'node:url';
import { runScript } from './merge-adapter.mjs';

export const main = (argv, env = process.env, deps = {}) => runScript('land', argv, env, deps);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
