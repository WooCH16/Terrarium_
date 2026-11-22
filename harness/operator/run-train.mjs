// 결정 8-32: 머지 트레인 시작. 코디네이터가 사용자의 트레인 승인 뒤에만 부른다(run-reflect와 같은 자리. 승인은 훅이 아니라 코디네이터 규칙이 지킨다).
// 사용법: node run-train.mjs --handoffs h<N>[,h<M>...]  (쌓을 순서. --base로 시작한 하달은 그 하달보다 뒤에 둔다)
// 하는 일:
//   1. 반영 순서를 run-reflect와 같은 규칙(baseOrderProblem)으로 검사한다. 앞에 쌓이는 하달은 먼저 들어가는 것으로 본다. 어기면 아무것도 시작하지 않는다.
//   2. 하달마다 열린 하달 PR(integration/h<N> → main)이 있고 머리 커밋이 로컬 통합 브랜치와 같은지 본다(push-branch를 먼저 부른다).
//   3. `gh workflow run harness-train.yml`로 대상 저장소의 트레인 워크플로를 시작하고, 끝날 때까지 기다려 결과(실행 기록의 표지 줄)를 읽는다.
//      main에 쓰는 것은 Actions뿐이다. 이 스크립트는 원격 main을 건드리지 않는다.
//   4. 통과하면 실행 폴더의 대상 프로젝트 main을 원격 main으로 빨리감기만 하고(따라가기, 조상일 때만), 반영된 이슈에 반영됨을 붙이고
//      handoffs/h<N>/train.json에 남긴다(의존 이슈의 "main에 있음" 판단에 쓴다). 실패하면 main은 그대로다(부분 머지는 사용자에게 묻는다).
//   5. 통과하고 로컬 main이 원격 main을 따라갔으면(같음·따라감) 들어간 하달마다 실행 폴더의 대상 프로젝트에서 그 하달의 이름 공간
//      (worktrees/h<N>/, integration/h<N>, h<N>/* 브랜치)을 하달 정리(cleanupHandoff)와 같은 방식으로 치운다(결정 8-35). 원격 브랜치·PR은 트레인 워크플로가 치운다.
//      정리 실패는 결과(종료 코드)를 바꾸지 않고 cleanup 칸에 적는다.
//   대상 원격이나 트레인 워크플로가 없으면(결정 4) 지금의 로컬 흐름(run-reflect)을 순서대로 돌리고 "CI 없음"을 보고한다.
// 출력: JSON 한 줄. 종료 코드: 0 트레인 통과(반영되지 않은 이슈는 rows에 보류로) 또는 로컬 흐름 정상, 1 트레인 실패(main 그대로) 또는 로컬 흐름의 막힘·보류, 2 설정·인자·순서 실패(시작 안 함), 5 기다림 한도 초과, 8 분리 실행 진행 중.
import { existsSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { TRAIN_HANDOFFS } from '../policy.mjs';
import { readRun, targetOf, makeGh, makeRemoteGit, hasWorkflow, findPr, poll, trainWait, WORKFLOWS, FlowError, ONE_LINE, fwd } from './github-flow.mjs';
import { openGit, isAnc, discoverTips, baseOrderProblem, collectAllowed, makeFetchIssueData, advanceBranch, runScript, trainRecordFile } from './merge-adapter.mjs';
import { makeGhDeps } from './run-operator.mjs';
import { cleanupHandoff } from './launch.mjs';
import { LABEL, TRAIN_RESULT_MARK } from './protocol.mjs';

export const EXIT = Object.freeze({ pass: 0, fail: 1, error: 2, timeout: 5 });
class UsageError extends Error {}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--handoffs') throw new UsageError('사용법: --handoffs h<N>[,h<M>...] (쌓을 순서, 다른 인자는 받지 않습니다)');
  if (!TRAIN_HANDOFFS.test(argv[1] ?? '')) throw new UsageError('--handoffs는 쉼표로 이은 h<번호>(10개까지)여야 합니다(예: h24,h25).');
  const handoffs = argv[1].split(',');
  if (new Set(handoffs).size !== handoffs.length) throw new UsageError('--handoffs에 같은 하달이 두 번 있습니다.');
  return { handoffs };
}

// 트레인 워크플로가 실행 기록에 찍은 결과 줄(`HARNESS_TRAIN_RESULT {json}`)을 읽는다. 마지막 것을 쓴다. 모양이 틀리면 null.
export function parseTrainResult(log, handoffs) {
  const lines = String(log ?? '').split(/\r?\n/).filter((l) => l.includes(`${TRAIN_RESULT_MARK} {`));
  const last = lines.at(-1);
  if (!last) return null;
  let r;
  try { r = JSON.parse(last.slice(last.indexOf(`${TRAIN_RESULT_MARK} {`) + TRAIN_RESULT_MARK.length + 1)); } catch { return null; }
  const H = /^h[1-9]\d{0,8}$/;
  const list = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && H.test(x) && handoffs.includes(x));
  if (!['merged', 'failed'].includes(r?.result) || !list(r.merged ?? []) || !list(r.passingPrefix ?? [])) return null;
  if (r.failedHandoff !== null && r.failedHandoff !== undefined && !(typeof r.failedHandoff === 'string' && handoffs.includes(r.failedHandoff))) return null;
  if (typeof r.train !== 'string' || !/^train\/[0-9]{8}-[0-9]{1,9}$/.test(r.train)) return null;
  if (r.mainAfter !== undefined && r.mainAfter !== null && !/^[0-9a-f]{40}$/.test(r.mainAfter)) return null;
  return { result: r.result, train: r.train, merged: r.merged ?? [], failedHandoff: r.failedHandoff ?? null, passingPrefix: r.passingPrefix ?? [], mainAfter: r.mainAfter ?? null };
}

// 원격·워크플로가 없는 대상: 지금의 run-reflect를 순서대로(결정 4). 앞 하달이 실패(2)하면 뒤 하달은 하지 않는다.
async function localFlow(handoffs, env, deps, reason, out) {
  const results = [];
  let worst = 0;
  for (const h of handoffs) {
    const lines = [];
    const errs = [];
    const code = await (deps.reflect ?? ((argv, e, d) => runScript('reflect', argv, e, d)))(['--handoff', h], env, { ...(deps.reflectDeps ?? {}), write: (l) => lines.push(...String(l).split('\n').filter(Boolean)), writeErr: (l) => errs.push(l) });
    results.push({ handoff: h, code, lines, errors: errs.map((l) => ONE_LINE(l)) });
    worst = Math.max(worst, code === 3 ? 1 : code);
    if (code === 2) break;
  }
  return out({ ci: 'none', flow: 'local', reason, handoffs: results }, worst >= 2 ? EXIT.error : worst);
}

export async function main(argv, env = process.env, deps = {}) {
  const write = deps.write ?? ((l) => console.log(l));
  const writeErr = deps.writeErr ?? ((l) => console.error(l));
  const fail = (reason) => { writeErr(`오류: ${ONE_LINE(reason)}`); return EXIT.error; };
  const out = (o, code) => { write(JSON.stringify(o)); return code; };
  try {
    const { handoffs } = parseArgs(argv);
    const { run, config } = readRun(env);
    for (const h of handoffs) if (!existsSync(`${run}/handoffs/${h}`)) return fail(`하달 ${h} 폴더가 없습니다.`);
    const memo = fwd(config.targetProject);
    const gh = deps.gh ?? makeGh(env);
    const target = targetOf(config);
    if (!target) return localFlow(handoffs, env, deps, '대상 원격이 없어 로컬 흐름(run-reflect)으로 반영했습니다. CI 없음.', out);
    if (!(deps.hasWorkflow ?? hasWorkflow)(gh, target.repo, WORKFLOWS.train)) return localFlow(handoffs, env, deps, `대상 저장소 main에 ${WORKFLOWS.train}가 없어 로컬 흐름(run-reflect)으로 반영했습니다. CI 없음.`, out);

    // 1. 반영 순서(결정 8-31과 같은 규칙). 앞에 쌓이는 하달은 먼저 들어가는 것으로 본다.
    const session = openGit({ env: deps.gitEnv });
    const g = session.git;
    const ahead = new Set();
    const integSha = {};
    for (const h of handoffs) {
      const tips = discoverTips(g, memo, h);
      if (tips.length === 0) return fail(`${h}의 이슈 브랜치가 없습니다. 아무것도 시작하지 않았습니다.`);
      const problem = baseOrderProblem(g, memo, run, h, tips, { ahead });
      if (problem) return fail(`${problem.replace('반영하세요', '트레인 앞에 두거나 먼저 반영하세요').replace('합치지 않았습니다', '시작하지 않았습니다')}`);
      ahead.add(h);
      try { integSha[h] = g(memo, ['rev-parse', '--verify', '--quiet', `refs/heads/integration/${h}^{commit}`]); } catch { integSha[h] = null; }
      if (!integSha[h]) return fail(`${h}의 통합 브랜치가 없습니다. 아무것도 시작하지 않았습니다.`);
    }
    // 2. 하달 PR이 열려 있고 머리 커밋이 로컬 통합 브랜치와 같아야 한다.
    const prs = {};
    for (const h of handoffs) {
      const pr = findPr(gh, target.repo, { head: `integration/${h}`, base: 'main', sha: integSha[h], state: 'open' });
      if (!pr) return fail(`${h}의 열린 하달 PR(integration/${h} → main, 머리 커밋 ${integSha[h].slice(0, 12)})이 없습니다. push-branch --branch integration/${h}를 먼저 부르세요. 아무것도 시작하지 않았습니다.`);
      prs[h] = pr.url;
    }

    // 3. 트레인 시작(쓰기 gh 호출은 이것 하나) → 실행 찾기 → 끝날 때까지 기다림 → 결과 줄 읽기.
    const request = deps.request ?? randomBytes(6).toString('hex');
    gh(['workflow', 'run', WORKFLOWS.train, '--repo', target.repo, '--ref', 'main', '-f', `handoffs=${handoffs.join(',')}`, '-f', `request=${request}`]);
    const w = { ...trainWait(env), ...(deps.now ? { now: deps.now } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) };
    // gh workflow run은 실행 번호를 돌려주지 않는다고 보고(확인 필요) run-name에 넣은 요청 번호로 찾는다.
    const found = await poll(() => {
      const list = JSON.parse(gh(['run', 'list', '--repo', target.repo, '--workflow', WORKFLOWS.train, '--limit', '20', '--json', 'databaseId,displayTitle,status,conclusion,url']) || '[]');
      return Array.isArray(list) ? list.find((r) => String(r?.displayTitle ?? '').includes(request)) ?? null : null;
    }, w);
    if (!found) return out({ ci: 'timeout', handoffs, request, reason: '기다림 한도 안에 트레인 실행을 찾지 못했습니다. 대상 저장소의 Actions 탭을 확인하세요. main은 이 스크립트가 바꾸지 않았습니다.' }, EXIT.timeout);
    const id = String(found.databaseId);
    const done = await poll(() => {
      const v = JSON.parse(gh(['run', 'view', id, '--repo', target.repo, '--json', 'status,conclusion,url']));
      return v?.status === 'completed' ? v : null;
    }, w);
    if (!done) return out({ ci: 'timeout', handoffs, runUrl: found.url, reason: '기다림 한도 안에 트레인이 끝나지 않았습니다. 끝난 뒤 결과는 대상 저장소의 실행 요약에 있습니다.' }, EXIT.timeout);
    const result = parseTrainResult(gh(['run', 'view', id, '--repo', target.repo, '--log']), handoffs);
    if (!result) return fail(`트레인 실행(${ONE_LINE(done.url ?? found.url)})이 결과 줄을 남기지 않았습니다(결론: ${ONE_LINE(done.conclusion ?? '?')}). 대상 저장소의 실행 요약을 확인하세요.`);

    const runUrl = String(done.url ?? found.url ?? '');
    if (result.result === 'failed') {
      return out({ ci: 'fail', train: result.train, runUrl, handoffs, failedHandoff: result.failedHandoff, passingPrefix: result.passingPrefix, main: '그대로', prs,
        reason: `트레인 CI 실패. main은 그대로다. 실패 하달: ${result.failedHandoff ?? '찾지 못함'}. 통과한 앞부분(${result.passingPrefix.join(', ') || '없음'})만 머지할지는 사용자에게 묻는다(스스로 부분 머지하지 않는다).` }, EXIT.fail);
    }

    // 4. 통과: 로컬 main을 원격 main으로 따라가기(빨리감기만), 반영됨 표시, train.json 기록.
    const rgit = deps.remoteGit ?? makeRemoteGit(env);
    let localMain = '그대로';
    let newMain = null;
    try {
      rgit(memo, ['fetch', '--no-tags', target.remote, 'refs/heads/main']);
      newMain = rgit(memo, ['rev-parse', 'FETCH_HEAD']);
      const oldMain = g(memo, ['rev-parse', '--verify', 'refs/heads/main']);
      if (result.mainAfter && newMain !== result.mainAfter) localMain = '그대로(원격 main이 트레인 결과와 다름)';
      else if (newMain === oldMain) localMain = '같음';
      else if (isAnc(g, memo, oldMain, newMain)) { advanceBranch(g, memo, 'main', newMain, oldMain, { allowPrimary: true }); localMain = '따라감'; }
      else localMain = '그대로(로컬 main이 원격 main의 조상이 아님)';
    } catch (e) { localMain = `그대로(원격 main을 읽지 못함: ${ONE_LINE(e?.message ?? '').slice(0, 80)})`; }
    const exec = deps.exec ?? ((bin, args) => gh(args));
    const fetchIssueData = deps.fetchIssueData ?? makeFetchIssueData(exec, config.designatedRepo);
    const ghDeps = deps.setState ? null : makeGhDeps(config.designatedRepo, exec);
    const setState = deps.setState ?? ((n, s) => ghDeps.setState(n, s));
    const rows = [];
    const mainNow = (() => { try { return g(memo, ['rev-parse', '--verify', 'refs/heads/main']); } catch { return null; } })();
    for (const h of result.merged) {
      const landed = [];
      for (const t of discoverTips(g, memo, h)) {
        const data = await fetchIssueData(t.n);
        const a = collectAllowed([{ ...data, number: t.n }], { reviewerLogin: deps.reviewerLogin ?? config.reviewerLogin });
        const onMain = a.length === 1 && a[0].sha === t.sha && mainNow !== null && isAnc(g, memo, t.sha, mainNow);
        if (onMain) { await setState(t.n, LABEL.반영됨); landed.push({ issue: t.n, sha: t.sha }); }
        rows.push({ number: t.n, state: onMain ? LABEL.반영됨 : LABEL.보류, url: typeof data?.url === 'string' ? data.url : `https://github.com/${config.designatedRepo}/issues/${t.n}` });
      }
      try {
        const f = trainRecordFile(run, h);
        writeFileSync(`${f}.tmp`, JSON.stringify({ train: result.train, runUrl, at: new Date().toISOString(), issues: landed }, null, 2));
        renameSync(`${f}.tmp`, f);
      } catch { /* 기록 실패는 결과를 바꾸지 않는다 */ }
    }
    // 5. 로컬 정리(결정 8-35). train.json과 반영됨 표시를 남긴 뒤에만, 로컬 main이 트레인 결과를 품을 때만.
    const cleanup = {};
    const clean = deps.cleanupHandoff ?? cleanupHandoff;
    for (const h of result.merged) {
      if (localMain !== '같음' && localMain !== '따라감') { cleanup[h] = `그대로(로컬 main: ${localMain})`; continue; }
      try { clean({ handoff: h, run, memo }); cleanup[h] = '정리함'; } catch (e) { cleanup[h] = `그대로(${ONE_LINE(e?.message ?? '').slice(0, 120)})`; }
    }
    // 트레인이 통과했으면 종료 코드는 0이다(1은 "트레인 실패, main 그대로"로만 쓴다). 반영되지 않은 이슈는 rows의 보류로 보인다.
    return out({ ci: 'pass', train: result.train, runUrl, handoffs, merged: result.merged, mainAfter: newMain, localMain, rows, cleanup }, EXIT.pass);
  } catch (e) {
    if (e instanceof UsageError) return fail(`인자 오류: ${e.message}`);
    if (e instanceof FlowError) return fail(e.message);
    if (e?.code === 'ETIMEDOUT' || e?.killed === true) return fail('외부 명령(git 또는 gh)이 제한 시간을 넘겨 중단했습니다. main은 이 스크립트가 바꾸지 않았습니다.');
    return fail(`예기치 못한 오류(${ONE_LINE(e?.code ?? e?.name ?? 'Error').slice(0, 30)}): ${ONE_LINE(e?.message ?? '').slice(0, 160)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 트레인(실패 하달 찾기 포함)은 10분을 넘을 수 있다: 하달처럼 분리 실행하고 9분 뒤 종료 코드 8과 대기 번호를 낸다.
  const { cliEntry } = await import('./background.mjs');
  process.exitCode = await cliEntry({ main, entry: fileURLToPath(import.meta.url), record: 'last-wait-train' });
}
