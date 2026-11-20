// 합치기 큐: 이슈 브랜치를 통합 브랜치 integration/h<N>에 차례로 합쳐 테스트한다(오퍼레이터 작업 모드).
// 사용법: node merge-adapter-enqueue.mjs --handoff h<N>. stdout에는 보고 줄(#번호 | 상태 | url)만, 오류는 stderr에 `오류:` 한 줄.
// 오래 걸릴 수 있다: 이슈마다 테스트 시간 제한과 전체 제한 시간이 있고, 백그라운드 모드는 없다.
import { pathToFileURL } from 'node:url';
import { runScript } from './merge-adapter.mjs';

export const main = (argv, env = process.env, deps = {}) => runScript('enqueue', argv, env, deps);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
