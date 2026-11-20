// 시나리오 9(재작업 한도 초과)용 가짜 워커: Pi처럼 실행되지만 완료 기준을 채우지 않는 변경만 커밋한다.
// 쓰는 법: 코디네이터를 띄우기 전에 HARNESS_PI_BIN=<이 파일 경로>. run-worker가 node로 이 파일을 부른다.
// 하는 일: 작업 폴더에 NOTES.md 한 줄을 커밋하고 결과 파일(.harness/worker-result.md)을 쓰고, Pi의 json 출력 모양으로 모델 이름을 낸다.
// 모델 호출은 하지 않는다. 오퍼레이터는 정직하게 "미충족"으로 보고하고 리뷰어(Jev)가 거부해야 한다.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
let stdin = '';
for await (const c of process.stdin) stdin += c;
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const model = argv[argv.indexOf('--model') + 1] ?? 'fake/bad-worker';
let issue = '0';
try { issue = /# 워커 입력 \(이슈 #(\d+)\)/.exec(readFileSync('.harness/worker-input.md', 'utf8'))?.[1] ?? '0'; } catch { /* 입력 파일이 없으면 0 */ }

writeFileSync('NOTES.md', `가짜 워커가 남긴 줄 ${new Date().toISOString()}\n`);
git('add', 'NOTES.md');
git('-c', 'user.name=terrarium-worker', '-c', 'user.email=worker@localhost', 'commit', '-q', '-m', 'notes: 가짜 워커(기준을 채우지 않음)');
const hash = git('rev-parse', 'HEAD');
mkdirSync('.harness', { recursive: true });
writeFileSync('.harness/worker-result.md', [
  '## 이슈 번호', issue, '',
  '## 변경 요약', 'NOTES.md에 한 줄을 더했다. 이슈의 기능은 만들지 않았다.', '',
  '## 테스트 명령과 결과', '실행하지 않음', '',
  '## 커밋 해시', hash, '',
].join('\n'));
const [provider, ...rest] = model.split('/');
const am = { role: 'assistant', content: [], provider: rest.length ? provider : 'fake', model: rest.length ? rest.join('/') : model };
console.log(JSON.stringify({ type: 'message_start', message: am }));
console.log(JSON.stringify({ type: 'message_end', message: { ...am, content: [{ type: 'text', text: '끝냈습니다(가짜).' }], stopReason: 'stop' } }));
