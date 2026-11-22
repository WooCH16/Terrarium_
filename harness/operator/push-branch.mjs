// 결정 8-32: 허용된 이슈 브랜치·통합 브랜치를 대상 저장소 원격에 올리고, GitHub Actions가 연 PR과 CI 결과를 기다려 읽는다.
// 사용법: node push-branch.mjs --branch <h<N>/issue-<번호> | integration/h<N>>. 코디네이터가 리뷰어 허용 뒤에 부른다(훅이 이 모양만 허용한다).
// - 이슈 브랜치: 그 이슈의 허용 판정 해시가 브랜치 끝과 같을 때만 올린다. 원격에 통합 브랜치가 없으면 이슈 PR의 대상이 될
//   시작점(main과 통합 브랜치가 갈라진 곳)을 먼저 integration/h<N>으로 올린다. 이슈 PR은 integration/h<N>으로 간다.
// - 통합 브랜치: 통합 브랜치에 합쳐진 이 하달의 이슈가 모두 허용됐고, 그 밖의 커밋은 병합 커밋뿐일 때만 올린다. 하달 PR은 main으로 간다.
// - 강제 push는 하지 않는다. main, train/*, 다른 브랜치는 올리지 않는다(정규식이 막는다). PR은 Actions가 연다. 이 스크립트는 gh pr을 읽기만 한다.
// - CI가 실패하면 관련 이슈를 미완료로 두고 CI 결과 댓글을 남긴다(재작업은 코디네이터가 새 하달로 시킨다. 다음 보고서가 판정받으면 재작업 한도에 센다).
// 출력: JSON 한 줄 { branch, sha, pushed, pr, ci, checks, failed, issues, reason }. 오류는 stderr에 `오류:` 한 줄.
// 종료 코드: 0 CI 통과, 1 CI 실패(재작업), 2 설정·인자·검사 실패(올리지 않음), 4 대상 원격·워크플로 없음(로컬 흐름, CI 없음), 5 기다림 한도 초과, 8 분리 실행 진행 중.
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PUSH_BRANCH } from '../policy.mjs';
import { readRun, targetOf, makeGh, makeRemoteGit, remoteSha, hasWorkflow, findPr, readChecks, poll, ciWait, WORKFLOWS, FlowError, ONE_LINE, fwd } from './github-flow.mjs';
import { openGit, isAnc, discoverTips, collectAllowed, makeFetchIssueData } from './merge-adapter.mjs';
import { makeGhDeps } from './run-operator.mjs';
import { LABEL, CI_HEAD } from './protocol.mjs';

export const EXIT = Object.freeze({ pass: 0, fail: 1, error: 2, none: 4, timeout: 5 });

class UsageError extends Error {}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--branch') throw new UsageError('사용법: --branch <h<N>/issue-<번호> | integration/h<N>> (다른 인자는 받지 않습니다)');
  const branch = argv[1];
  if (!PUSH_BRANCH.test(branch ?? '')) throw new UsageError('--branch는 h<N>/issue-<번호> 또는 integration/h<N> 모양만 받습니다(main, train/*, 그 밖의 브랜치는 올리지 않습니다).');
  const m = /^integration\/(h[1-9]\d{0,8})$/.exec(branch);
  if (m) return { branch, handoff: m[1], issue: null, kind: 'handoff' };
  const [handoff, rest] = branch.split('/');
  return { branch, handoff, issue: Number(rest.slice('issue-'.length)), kind: 'issue' };
}

const record = (run, handoff, data) => {
  try {
    mkdirSync(`${run}/handoffs/${handoff}`, { recursive: true });
    appendFileSync(`${run}/handoffs/${handoff}/ci.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), ...data })}\n`);
  } catch { /* 기록 실패는 결과를 바꾸지 않는다 */ }
};

export async function main(argv, env = process.env, deps = {}) {
  const write = deps.write ?? ((l) => console.log(l));
  const writeErr = deps.writeErr ?? ((l) => console.error(l));
  const fail = (reason) => { writeErr(`오류: ${ONE_LINE(reason)}`); return EXIT.error; };
  const out = (o, code) => { write(JSON.stringify(o)); return code; };
  try {
    const { branch, handoff, issue, kind } = parseArgs(argv);
    const { run, config } = readRun(env);
    if (!existsSync(`${run}/handoffs/${handoff}`)) return fail(`하달 ${handoff} 폴더가 없습니다.`);
    const memo = fwd(config.targetProject);
    const target = targetOf(config);
    const gh = deps.gh ?? makeGh(env);
    const none = (reason) => out({ branch, ci: 'none', reason }, EXIT.none);
    if (!target) return none('대상 원격이 없습니다(harness.json의 targetRepo·targetRemote). 로컬 흐름(run-reflect)으로 돌고 끝 보고에 "CI 없음"을 적습니다.');
    const wf = kind === 'issue' ? WORKFLOWS.issue : WORKFLOWS.handoff;
    if (!(deps.hasWorkflow ?? hasWorkflow)(gh, target.repo, wf)) return none(`대상 저장소 main에 ${wf}가 없습니다. 로컬 흐름(run-reflect)으로 돌고 끝 보고에 "CI 없음"을 적습니다. 워크플로는 setup --add-workflows로 PR 하나로 넣습니다.`);

    // 1. 로컬 브랜치와 허용 판정(믿는 git으로 읽는다).
    const session = openGit({ env: deps.gitEnv, gitTimeoutMs: deps.gitTimeoutMs });
    const g = session.git;
    const integ = `integration/${handoff}`;
    const shaOf = (b) => { try { return g(memo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}^{commit}`]); } catch { return null; } };
    const sha = shaOf(branch);
    if (!sha) return fail(`대상 프로젝트에 ${branch} 브랜치가 없습니다.`);
    const exec = deps.exec ?? ((bin, args) => gh(args));
    const fetchIssueData = deps.fetchIssueData ?? makeFetchIssueData(exec, config.designatedRepo);
    const allowedTip = async (n, tip) => {
      const data = await fetchIssueData(n);
      const a = collectAllowed([{ ...data, number: n }], { reviewerLogin: deps.reviewerLogin ?? config.reviewerLogin });
      return a.length === 1 && a[0].sha === tip;
    };
    let issues;
    if (kind === 'issue') {
      if (!(await allowedTip(issue, sha))) return fail(`#${issue}에 이 브랜치 끝(${sha.slice(0, 12)})을 허용한 리뷰어 판정이 없습니다. 허용 뒤에만 올립니다. 아무것도 올리지 않았습니다.`);
      issues = [issue];
    } else {
      const tips = discoverTips(g, memo, handoff).filter((t) => isAnc(g, memo, t.sha, sha));
      if (tips.length === 0) return fail(`${integ}에 합쳐진 이 하달의 이슈가 없습니다. 아무것도 올리지 않았습니다.`);
      for (const t of tips) {
        // 알려진 한계: 리뷰에서 거부되거나 CI로 미완료가 된 이슈가 통합 브랜치에 합쳐져 있으면 이 하달은 하달 PR·트레인으로 갈 수 없다(통합 브랜치를 다시 만들지 않는다).
        if (!(await allowedTip(t.n, t.sha))) return fail(`${integ}에 허용되지 않은 #${t.n}의 커밋이 있습니다. 이 하달은 하달 PR·트레인으로 갈 수 없습니다(통합 브랜치를 다시 만들지 않습니다). 끝 보고의 결정할 것에: 재작업이 끝난 뒤 이 하달의 이슈를 새 하달로 다시 하거나, 허용된 이슈만 로컬 반영(run-reflect). 아무것도 올리지 않았습니다.`);
      }
      const stray = g(memo, ['rev-list', '--no-merges', sha, '^refs/heads/main', ...tips.map((t) => `^${t.sha}`)]);
      if (stray.trim() !== '') return fail(`${integ}에 이슈 브랜치 밖의 커밋(병합 커밋이 아닌 것)이 있습니다. 아무것도 올리지 않았습니다.`);
      issues = tips.map((t) => t.n);
    }

    // 2. 올리기. 이슈 PR의 대상(통합 브랜치)이 원격에 없으면 시작점을 먼저 올린다.
    const rgit = deps.remoteGit ?? makeRemoteGit(env);
    const remoteInteg = remoteSha(rgit, memo, target.remote, integ);
    if (kind === 'issue' && remoteInteg !== null && isAnc(g, memo, sha, remoteInteg)) {
      return out({ branch, sha, pushed: 'skipped', pr: null, ci: 'skipped', issues, reason: `원격 ${integ}에 이미 들어 있어 이슈 PR이 열리지 않습니다. 하달 PR의 CI를 보세요.` }, EXIT.pass);
    }
    if (kind === 'issue' && remoteInteg === null) {
      const localInteg = shaOf(integ);
      const start = g(memo, ['merge-base', 'refs/heads/main', localInteg ?? sha]);
      rgit(memo, ['push', '--porcelain', target.remote, `${start}:refs/heads/${integ}`]);
    }
    const before = remoteSha(rgit, memo, target.remote, branch);
    if (before !== sha) {
      try { rgit(memo, ['push', '--porcelain', target.remote, `refs/heads/${branch}:refs/heads/${branch}`]); } catch (e) {
        return fail(`원격에 ${branch}를 올리지 못했습니다(빨리감기가 아니거나 권한·네트워크 문제). 강제로 올리지 않습니다: ${ONE_LINE(e?.stderr ?? e?.message ?? '').slice(0, 160)}`);
      }
    }
    const pushed = before === sha ? 'already' : 'pushed';

    // 3. Actions가 연 PR과 CI 결과를 기다려 읽는다(읽기만).
    const base = kind === 'issue' ? integ : 'main';
    const w = { ...ciWait(env), ...(deps.now ? { now: deps.now } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) };
    const pr = await poll(() => findPr(gh, target.repo, { head: branch, base, sha }), w);
    if (!pr) {
      record(run, handoff, { branch, sha, ci: 'timeout', pr: null });
      return out({ branch, sha, pushed, pr: null, ci: 'timeout', issues, reason: `기다림 한도 안에 ${branch} → ${base} PR이 열리지 않았습니다. 대상 저장소의 Actions 실행과 설정(PR 만들기 허용)을 확인하세요.` }, EXIT.timeout);
    }
    const res = await poll(() => { const r = readChecks(gh, target.repo, pr.number); return r.state === 'pending' ? null : r; }, w);
    if (!res) {
      record(run, handoff, { branch, sha, ci: 'timeout', pr: pr.url });
      return out({ branch, sha, pushed, pr, ci: 'timeout', issues, reason: '기다림 한도 안에 CI가 끝나지 않았습니다. 같은 명령을 다시 부르면 이어서 읽습니다(다시 올리지 않습니다).' }, EXIT.timeout);
    }
    const failed = res.checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name);
    record(run, handoff, { branch, sha, ci: res.state, pr: pr.url, failed });
    if (res.state === 'fail') {
      // 관련 이슈를 미완료로 두고(합치기·트레인에서 빠진다) CI 결과를 댓글로 남긴다. 재작업은 코디네이터가 새 하달로 시킨다.
      const ghDeps = deps.setState ? null : makeGhDeps(config.designatedRepo, exec);
      const setState = deps.setState ?? ((n, s) => ghDeps.setState(n, s));
      const comment = deps.comment ?? ((n, body) => exec('gh', ['issue', 'comment', String(n), '--repo', config.designatedRepo, '--body', body]));
      const body = `${CI_HEAD}: 실패\n\n- 브랜치: ${branch} (${sha})\n- PR: ${pr.url}\n- 실패한 검사: ${failed.join(', ') || '(이름 없음)'}\n- 처리: 재작업(새 하달). 재작업 한도에 센다.\n`;
      for (const n of issues) { await setState(n, LABEL.미완료); comment(n, body); }
    }
    return out({ branch, sha, pushed, pr, ci: res.state, checks: res.checks, failed, issues }, res.state === 'pass' ? EXIT.pass : EXIT.fail);
  } catch (e) {
    if (e instanceof UsageError) return fail(`인자 오류: ${e.message}`);
    if (e instanceof FlowError) return fail(e.message);
    if (e?.code === 'ETIMEDOUT' || e?.killed === true) return fail('외부 명령(git 또는 gh)이 제한 시간을 넘겨 중단했습니다.');
    return fail(`예기치 못한 오류(${ONE_LINE(e?.code ?? e?.name ?? 'Error').slice(0, 30)}): ${ONE_LINE(e?.message ?? '').slice(0, 160)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // CI 기다림은 Bash 도구의 10분 제한을 넘을 수 있다: 하달처럼 분리 실행하고 9분 뒤 종료 코드 8과 대기 번호를 낸다.
  const { cliEntry } = await import('./background.mjs');
  process.exitCode = await cliEntry({ main, entry: fileURLToPath(import.meta.url), record: 'last-wait-push' });
}
