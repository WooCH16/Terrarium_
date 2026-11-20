// 결과 보고서 초안: node result-draft.mjs --handoff h<N> --issue <n>
// 이슈의 완료 기준을 글자 그대로 옮긴 표와 커밋 해시 줄을 채운 초안을 지정 저장소 클론의 .drafts/result-<n>-h<N>.md에 쓰고 그 경로 한 줄을 낸다.
// 오퍼레이터는 충족·근거 위치 칸과 나머지 절만 채운다. 기준 칸은 고치지 않는다(리뷰어 코드 검사가 글자까지 비교한다, run-8 R8-2).
// 종료 코드: 0 성공, 2 인자·설정·이슈 읽기 실패.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { defaultExec } from './run-operator.mjs';
import { issueCriteria } from './jev-review.mjs';
import { REPORT_HEAD, REPORT_SECTIONS, REPORT_TABLE, ACTUAL_WORKER_MODEL } from './protocol.mjs';

const fwd = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const cell = (s) => String(s).replace(/\|/g, '\\|');

export function draftText({ issue, criteria, commit }) {
  return [
    REPORT_HEAD,
    `커밋 해시: ${commit ?? '없음'}`,
    '',
    `### ${REPORT_SECTIONS[0]}`,
    `| ${REPORT_TABLE.join(' | ')} |`,
    '|---|---|---|',
    ...criteria.map((c) => `| ${cell(c)} | <충족 또는 미충족> | <파일:줄, 테스트 이름, 명령과 결과> |`),
    '',
    `### ${REPORT_SECTIONS[2]}`,
    '<무엇을 바꿨나, 합친 커밋>',
    '',
    '### 사실 칸',
    '- 모델: <지정 모델> → <실제 모델> (대체 사유: run-worker 출력의 replacedReason, 없으면 "대체 없음")',
    `- ${ACTUAL_WORKER_MODEL}: <run-worker 출력의 model 값>`,
    '- 시도 횟수: <워커 시도 횟수>, 막힘 사유: <없으면 "없음">',
    '- 사후 검사 자료: <변경 파일 목록, 하달 시작과 지금의 main 해시, 오퍼레이터 편집 여부>',
    '',
    `### ${REPORT_SECTIONS[3]}`,
    '<없으면 "없음">',
    '',
  ].join('\n');
}

export async function main(argv, env = process.env, deps = {}) {
  const write = deps.write ?? ((l) => console.log(l));
  const fail = (m) => { write(`오류: ${m}`); return 2; };
  if (argv.length !== 4 || argv[0] !== '--handoff' || argv[2] !== '--issue' || !/^h[1-9]\d{0,8}$/.test(argv[1]) || !/^[1-9]\d{0,8}$/.test(argv[3])) {
    return fail('사용법: node result-draft.mjs --handoff h<N> --issue <번호>');
  }
  const [handoff, issue] = [argv[1], Number(argv[3])];
  const run = fwd(env.HARNESS_RUN_DIR || process.cwd());
  if (!existsSync(`${run}/harness.json`)) return fail(`실행 폴더에 harness.json이 없습니다: ${run}`);
  const config = JSON.parse(readFileSync(`${run}/harness.json`, 'utf8'));
  let body;
  try {
    body = deps.fetchBody ? await deps.fetchBody(issue) : JSON.parse(defaultExec(env)('gh', ['issue', 'view', String(issue), '--repo', config.designatedRepo, '--json', 'body'])).body;
  } catch (e) { return fail(`이슈 #${issue}을 읽지 못했습니다: ${String(e.message).slice(0, 200)}`); }
  const criteria = issueCriteria(body);
  if (!criteria || criteria.length === 0) return fail(`이슈 #${issue}에 완료 기준 표(| 기준 | 확인 방법 |)가 없습니다.`);
  let commit = null;
  try {
    const git = deps.git ?? ((args) => execFileSync('git', ['-C', fwd(config.targetProject), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
    commit = git(['rev-parse', '--verify', `refs/heads/${handoff}/issue-${issue}`]);
    // 브랜치는 워크트리를 만들 때 기준 커밋에 생긴다. 끝이 main이나 다른 이슈 브랜치 끝과 같으면 워커가 커밋을 못 낸 것이다(fable 조언 2).
    const others = git(['for-each-ref', '--format=%(objectname)', 'refs/heads/main', `refs/heads/${handoff}/`]).split(/\r?\n/).filter(Boolean);
    const own = git(['rev-parse', '--verify', `refs/heads/${handoff}/issue-${issue}`]);
    if (others.filter((h) => h === own).length > 1 || git(['rev-parse', '--verify', 'refs/heads/main']) === commit) commit = null;
  } catch { /* 브랜치가 없으면(워커 실패) 없음 */ }
  const dir = `${fwd(config.issuesClone)}/.drafts`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/result-${issue}-${handoff}.md`;
  writeFileSync(file, draftText({ issue, criteria, commit }));
  write(file);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
