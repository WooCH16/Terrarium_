// 결정 8-32: 허용된 이슈 브랜치·통합 브랜치를 대상 저장소 원격에 올리고, GitHub Actions가 연 PR과 CI 결과를 기다려 읽는다.
// 사용법: node push-branch.mjs --branch <h<N>/issue-<번호> | integration/h<N>>. 코디네이터가 리뷰어 허용 뒤에 부른다(훅이 이 모양만 허용한다).
// - 이슈 브랜치: 그 이슈의 허용 판정 해시가 브랜치 끝과 같을 때만 올린다. 원격에 통합 브랜치가 없으면 이슈 PR의 대상이 될
//   시작점(main과 통합 브랜치가 갈라진 곳)을 먼저 integration/h<N>으로 올린다. 이슈 PR은 integration/h<N>으로 간다.
// - 통합 브랜치: 통합 브랜치에 합쳐진 이 하달의 이슈가 모두 허용됐고, 그 밖의 커밋은 병합 커밋뿐일 때 올린다. 하달 PR은 main으로 간다.
//   허용과 반려(거부 판정, 미완료·거부목록·막힘)가 섞였으면(결정 8-35) 통합 브랜치를 허용된 이슈만으로 다시 만든다: 시작점(main과 갈라진 곳)에서
//   허용된 이슈 브랜치를 의존 순서대로 합치기 어댑터와 같은 배관 병합(merge-tree + commit-tree)으로 합친다. 반려된 이슈에 기대거나(의존 절) 그 커밋을 품은
//   허용된 이슈도 뺀다(대기로 두고 반려된 이슈와 함께 새 하달로). 반려된 이슈는 미완료 그대로다(재작업은 코디네이터가 새 하달로, 재작업 한도 안).
//   판정 전 이슈가 섞여 있으면 다시 만들지 않고 거부한다(종료 코드 2). 다시 만든 기록은 handoffs/h<N>/rebuilt.json에 남는다.
// - 강제 push는 하나만 한다: 이 스크립트가 다시 만든 integration/h<N>을, 원격 끝이 rebuilt.json에 적힌 옛 끝일 때 --force-with-lease=<그 끝>으로.
//   main, train/*, 다른 브랜치는 올리지 않는다(정규식이 막는다). PR은 Actions가 연다. 이 스크립트는 gh pr을 읽기만 한다.
// - CI가 실패하면 관련 이슈를 미완료로 두고 CI 결과 댓글을 남긴다(재작업은 코디네이터가 새 하달로 시킨다. 다음 보고서가 판정받으면 재작업 한도에 센다).
// 출력: JSON 한 줄 { branch, sha, pushed, pr, ci, checks, failed, issues, rebuilt, reason }. 오류는 stderr에 `오류:` 한 줄.
//   rebuilt: 다시 만든 통합 브랜치면 { from, to, kept, returned: [{ issue, reason }], held: [{ issue, reason }] }, 아니면 null.
// 종료 코드: 0 CI 통과, 1 CI 실패(재작업), 2 설정·인자·검사 실패(올리지 않음), 4 대상 원격·워크플로 없음(로컬 흐름, CI 없음), 5 기다림 한도 초과, 8 분리 실행 진행 중.
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PUSH_BRANCH } from '../policy.mjs';
import { readRun, targetOf, makeGh, makeRemoteGit, remoteSha, hasWorkflow, findPr, readChecks, poll, ciWait, WORKFLOWS, FlowError, ONE_LINE, fwd } from './github-flow.mjs';
import { openGit, isAnc, discoverTips, collectAllowed, makeFetchIssueData, rejectionOf, excludeDependents, orderAllowed, orderByAncestry, buildMerge, verifyChain, replaceIntegration, IntegrityError, HarnessError } from './merge-adapter.mjs';
import { makeGhDeps } from './run-operator.mjs';
import { LABEL, CI_HEAD, REBUILD_HEAD } from './protocol.mjs';

export const EXIT = Object.freeze({ pass: 0, fail: 1, error: 2, none: 4, timeout: 5 });

class UsageError extends Error {}

const INTEG = /^integration\/h[1-9]\d{0,8}$/;
const SHA = /^[0-9a-f]{40}$/;

// 결정 8-35: 강제 push 인자는 여기서만 만든다. integration/h<N> 한 모양과 40자리 예상 원격 끝(--force-with-lease)일 때만. 그 밖은 던진다.
export function forcePushArgs(remote, branch, expect) {
  if (!INTEG.test(branch ?? '')) throw new FlowError(`강제 push는 integration/h<N>만 합니다(${ONE_LINE(branch ?? '')}는 거부).`);
  if (!SHA.test(expect ?? '')) throw new FlowError('강제 push에는 예상 원격 끝(40자리 해시)이 있어야 합니다.');
  return ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${expect}`, remote, `refs/heads/${branch}:refs/heads/${branch}`];
}

// handoffs/h<N>/rebuilt.json: [{ at, from, to, start, kept, returned, held }]. handoffs/ 아래라 에이전트가 쓰지 못한다(train.json과 같다).
export const rebuildFile = (run, handoff) => `${run}/handoffs/${handoff}/rebuilt.json`;
export function readRebuilds(run, handoff) {
  try {
    const list = JSON.parse(readFileSync(rebuildFile(run, handoff), 'utf8'));
    return Array.isArray(list) ? list.filter((r) => SHA.test(r?.from ?? '') && SHA.test(r?.to ?? '')) : [];
  } catch { return []; }
}
function writeRebuild(run, handoff, rec) {
  const f = rebuildFile(run, handoff);
  writeFileSync(`${f}.tmp`, JSON.stringify([...readRebuilds(run, handoff), rec], null, 2));
  renameSync(`${f}.tmp`, f);
}
// 로컬 통합 브랜치 끝(sha)이 이 스크립트가 다시 만든 마지막 결과일 때, 강제로 덮어도 되는 원격 끝들(기록에 적힌 옛 끝). 아니면 빈 목록.
export function leaseable(run, handoff, sha) {
  const recs = readRebuilds(run, handoff);
  if (recs.length === 0 || recs.at(-1).to !== sha) return [];
  return [...new Set(recs.flatMap((r) => [r.from, r.to]))].filter((x) => x !== sha);
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--branch') throw new UsageError('사용법: --branch <h<N>/issue-<번호> | integration/h<N>> (다른 인자는 받지 않습니다)');
  const branch = argv[1];
  if (!PUSH_BRANCH.test(branch ?? '')) throw new UsageError('--branch는 h<N>/issue-<번호> 또는 integration/h<N> 모양만 받습니다(main, train/*, 그 밖의 브랜치는 올리지 않습니다).');
  const m = /^integration\/(h[1-9]\d{0,8})$/.exec(branch);
  if (m) return { branch, handoff: m[1], issue: null, kind: 'handoff' };
  const [handoff, rest] = branch.split('/');
  return { branch, handoff, issue: Number(rest.slice('issue-'.length)), kind: 'issue' };
}

// 통합 브랜치에 무엇을 남길지(결정 8-35). 이미 main에 있는 이슈 브랜치는 보지 않는다.
// keep: 통합 브랜치에 합쳐진 허용된 이슈 가운데, 허용되지 않은 이슈에 (연쇄로) 기대지 않고 그 커밋을 품지도 않은 것(의존 순서).
// 통합 브랜치에 남길 수 없는 것이 하나라도 있으면 rebuild. 그때 통합 브랜치 안의 허용되지 않은 이슈는 모두 반려 표시가 있어야 한다(판정 전이면 error).
export async function planIntegration({ g, memo, handoff, integ, sha, fetchIssueData, allowedOf, reviewerLogin }) {
  const tips = discoverTips(g, memo, handoff).filter((t) => !isAnc(g, memo, t.sha, 'refs/heads/main'));
  const inInteg = tips.filter((t) => isAnc(g, memo, t.sha, sha));
  if (inInteg.length === 0) return { error: `${integ}에 합쳐진 이 하달의 이슈가 없습니다. 아무것도 올리지 않았습니다.` };
  const data = new Map();
  for (const t of tips) data.set(t.n, await fetchIssueData(t.n));
  const allowed = new Map();
  for (const t of tips) { const a = allowedOf(t.n, t.sha, data.get(t.n)); if (a) allowed.set(t.n, a); }
  const blocked = tips.filter((t) => !allowed.has(t.n));
  const why = new Map();
  let keep = inInteg.filter((t) => allowed.has(t.n)).map((t) => allowed.get(t.n));
  for (;;) {
    const deadNums = new Set([...blocked.map((t) => t.n), ...inInteg.filter((t) => allowed.has(t.n) && !keep.some((a) => a.issue === t.n)).map((t) => t.n)]);
    const deadShas = tips.filter((t) => deadNums.has(t.n));
    const byDep = new Set(excludeDependents(keep, [...deadNums]).map((a) => a.issue));
    const next = keep.filter((a) => {
      if (!byDep.has(a.issue)) { why.set(a.issue, `반려된 #${a.dependsOn.find((d) => deadNums.has(d)) ?? '?'}에 기댄다(의존 절)`); return false; }
      const d = deadShas.find((t) => t.sha !== a.sha && isAnc(g, memo, t.sha, a.sha));
      if (d) { why.set(a.issue, `반려된 #${d.n}의 커밋을 품는다`); return false; }
      return true;
    });
    if (next.length === keep.length) break;
    keep = next;
  }
  const keptNums = new Set(keep.map((a) => a.issue));
  const returned = [];
  const labelled = new Set();
  // 더 뒤의 하달에 같은 이슈의 브랜치가 있으면 이미 재작업 중이다(runLand의 otherHandoffs와 같은 기준): 반려로 보고 라벨·댓글은 건드리지 않는다.
  const mine = Number(handoff.slice(1));
  const later = new Map();
  for (const line of g(memo, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/']).split('\n')) {
    const m = /^h([1-9]\d{0,8})\/issue-([1-9]\d{0,8})$/.exec(line.trim());
    if (m && Number(m[1]) > mine) later.set(Number(m[2]), `h${m[1]}`);
  }
  const superseded = new Set();
  for (const t of inInteg.filter((x) => !allowed.has(x.n))) {
    if (later.has(t.n)) { superseded.add(t.n); returned.push({ issue: t.n, reason: `${later.get(t.n)}에서 재작업 중` }); continue; }
    const reason = rejectionOf(data.get(t.n), { reviewerLogin });
    if (!reason) return { error: `${integ}에 아직 판정 전인 #${t.n}의 커밋이 있습니다. 하달의 이슈가 모두 판정(허용·거부)을 받은 뒤에 부르세요. 아무것도 올리지 않았습니다.` };
    if (reason.startsWith('상태가')) labelled.add(t.n);
    returned.push({ issue: t.n, reason });
  }
  const held = inInteg.filter((t) => allowed.has(t.n) && !keptNums.has(t.n)).map((t) => ({ issue: t.n, reason: why.get(t.n) ?? '반려된 이슈에 기댄다' }));
  const rebuild = returned.length > 0 || held.length > 0;
  if (rebuild && keep.length === 0) {
    return { error: `${integ}에 남길 허용된 이슈가 없습니다(반려: ${returned.map((x) => `#${x.issue}`).join(', ') || '없음'}, 대기: ${held.map((x) => `#${x.issue}`).join(', ') || '없음'}). 하달 PR을 열지 않습니다. 반려된 이슈는 새 하달로 재작업합니다. 아무것도 올리지 않았습니다.` };
  }
  // 의존 순서(합치기 어댑터의 enqueue와 같게: 의존 절 순서, 그다음 서로 품은 것을 앞으로).
  const { ordered, cyclic } = orderAllowed(keep);
  keep = orderByAncestry(g, memo, [...ordered, ...cyclic]);
  return { rebuild, keep, returned, held, labelled, superseded };
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
    let sha = shaOf(branch);
    if (!sha) return fail(`대상 프로젝트에 ${branch} 브랜치가 없습니다.`);
    const exec = deps.exec ?? ((bin, args) => gh(args));
    const fetchIssueData = deps.fetchIssueData ?? makeFetchIssueData(exec, config.designatedRepo);
    const reviewerLogin = deps.reviewerLogin ?? config.reviewerLogin;
    const allowedOf = (n, tip, data) => {
      const a = collectAllowed([{ ...data, number: n }], { reviewerLogin });
      return a.length === 1 && a[0].sha === tip ? a[0] : null;
    };
    const ghDeps = deps.setState ? null : makeGhDeps(config.designatedRepo, exec);
    const setState = deps.setState ?? ((n, s) => ghDeps.setState(n, s));
    const comment = deps.comment ?? ((n, text) => exec('gh', ['issue', 'comment', String(n), '--repo', config.designatedRepo, '--body', text]));
    let issues;
    let rebuilt = null;
    if (kind === 'issue') {
      if (!allowedOf(issue, sha, await fetchIssueData(issue))) return fail(`#${issue}에 이 브랜치 끝(${sha.slice(0, 12)})을 허용한 리뷰어 판정이 없습니다. 허용 뒤에만 올립니다. 아무것도 올리지 않았습니다.`);
      issues = [issue];
    } else {
      const r = await planIntegration({ g, memo, handoff, integ, sha, fetchIssueData, allowedOf, reviewerLogin });
      if (r.error) return fail(r.error);
      if (r.rebuild) {
        // 결정 8-35: 허용된 이슈만으로 다시 만든다(시작점에서 의존 순서대로 배관 병합). 충돌하면 아무것도 바꾸지 않는다.
        const start = g(memo, ['merge-base', 'refs/heads/main', sha]);
        const built = [];
        let tip = start;
        for (const a of r.keep) {
          if (isAnc(g, memo, a.sha, tip)) continue;
          const m = buildMerge(g, memo, tip, a.sha, `통합: 이슈 #${a.issue}`);
          if (m.conflict) return fail(`${integ}를 허용된 이슈만으로 다시 만들다가 #${a.issue}에서 충돌했습니다. 아무것도 바꾸거나 올리지 않았습니다.`);
          built.push({ ...m, sha: a.sha });
          tip = m.commit;
        }
        verifyChain(g, memo, start, built);
        rebuilt = { from: sha, to: tip, kept: r.keep.map((a) => a.issue), returned: r.returned, held: r.held };
        // 기록을 먼저 남기고 브랜치를 옮긴다: 옮긴 뒤 기록이 없으면 다음 호출이 원격의 옛 끝을 덮을 수 없다. 기록을 못 쓰면 옮기지 않는다.
        try { writeRebuild(run, handoff, { at: new Date().toISOString(), start, ...rebuilt }); } catch (e) {
          return fail(`다시 만든 기록(handoffs/${handoff}/rebuilt.json)을 쓰지 못해 ${integ}를 옮기지 않았습니다: ${ONE_LINE(e?.code ?? e?.message ?? '')}`);
        }
        replaceIntegration(g, memo, integ, tip, sha);
        const note = (why) => `${REBUILD_HEAD} (결정 8-35)\n\n- 하달: ${handoff}\n- ${integ}: ${sha} → ${tip} (남긴 이슈: ${rebuilt.kept.map((n) => `#${n}`).join(', ')})\n- 이 이슈: ${why}\n`;
        for (const x of r.returned) {
          if (r.superseded.has(x.issue)) continue; // 이미 뒤 하달에서 재작업 중: 그 하달의 라벨·판정을 건드리지 않는다
          if (!r.labelled.has(x.issue)) await setState(x.issue, LABEL.미완료);
          const done = /거부목록|막힘/.test(x.reason);
          comment(x.issue, note(done ? `${x.reason}. 이번 하달 PR에서 뺐다. 다시 하달하지 않고 끝 보고의 결정할 것에서 정한다.` : `반려(${x.reason}). 이번 하달 PR에서 뺐다. 재작업은 새 하달로(재작업 한도에 센다).`));
        }
        for (const x of r.held) {
          await setState(x.issue, LABEL.대기);
          comment(x.issue, note(`허용됐지만 ${x.reason}. 이번 하달 PR에서 빼고 반려된 이슈와 함께 새 하달로 다시 한다.`));
        }
        sha = tip;
      } else {
        const last = readRebuilds(run, handoff).at(-1);
        if (last && last.to === sha) rebuilt = { from: last.from, to: last.to, kept: last.kept ?? [], returned: last.returned ?? [], held: last.held ?? [] };
      }
      const stray = g(memo, ['rev-list', '--no-merges', sha, '^refs/heads/main', ...r.keep.map((a) => `^${a.sha}`)]);
      if (stray.trim() !== '') return fail(`${integ}에 이슈 브랜치 밖의 커밋(병합 커밋이 아닌 것)이 있습니다. 아무것도 올리지 않았습니다.`);
      issues = r.keep.map((a) => a.issue).sort((a, b) => a - b);
    }

    // 2. 올리기. 이슈 PR의 대상(통합 브랜치)이 원격에 없으면 시작점을 먼저 올린다.
    const rgit = deps.remoteGit ?? makeRemoteGit(env);
    const remoteInteg = remoteSha(rgit, memo, target.remote, integ);
    if (kind === 'issue' && remoteInteg !== null && isAnc(g, memo, sha, remoteInteg)) {
      return out({ branch, sha, pushed: 'skipped', pr: null, ci: 'skipped', issues, rebuilt, reason: `원격 ${integ}에 이미 들어 있어 이슈 PR이 열리지 않습니다. 하달 PR의 CI를 보세요.` }, EXIT.pass);
    }
    if (kind === 'issue' && remoteInteg === null) {
      const localInteg = shaOf(integ);
      const start = g(memo, ['merge-base', 'refs/heads/main', localInteg ?? sha]);
      rgit(memo, ['push', '--porcelain', target.remote, `${start}:refs/heads/${integ}`]);
    }
    const before = remoteSha(rgit, memo, target.remote, branch);
    // 결정 8-35: 원격 끝이 이 스크립트가 다시 만들기 전의 끝(rebuilt.json)일 때만 그 끝을 예상값으로 강제 push한다. 그 밖은 빨리감기만.
    const lease = kind === 'handoff' && before !== null && before !== sha && leaseable(run, handoff, sha).includes(before) ? before : null;
    if (before !== sha) {
      try { rgit(memo, lease ? forcePushArgs(target.remote, branch, lease) : ['push', '--porcelain', target.remote, `refs/heads/${branch}:refs/heads/${branch}`]); } catch (e) {
        return fail(`원격에 ${branch}를 올리지 못했습니다(${lease ? '원격 끝이 예상과 달라졌거나' : '빨리감기가 아니거나'} 권한·네트워크 문제). ${lease ? '강제 push는 예상한 옛 끝일 때만 합니다' : '강제로 올리지 않습니다'}: ${ONE_LINE(e?.stderr ?? e?.message ?? '').slice(0, 160)}`);
      }
    }
    const pushed = before === sha ? 'already' : lease ? 'forced' : 'pushed';

    // 3. Actions가 연 PR과 CI 결과를 기다려 읽는다(읽기만).
    const base = kind === 'issue' ? integ : 'main';
    const w = { ...ciWait(env), ...(deps.now ? { now: deps.now } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) };
    const pr = await poll(() => findPr(gh, target.repo, { head: branch, base, sha }), w);
    if (!pr) {
      record(run, handoff, { branch, sha, ci: 'timeout', pr: null });
      return out({ branch, sha, pushed, pr: null, ci: 'timeout', issues, rebuilt, reason: `기다림 한도 안에 ${branch} → ${base} PR이 열리지 않았습니다. 대상 저장소의 Actions 실행과 설정(PR 만들기 허용)을 확인하세요.` }, EXIT.timeout);
    }
    const res = await poll(() => { const r = readChecks(gh, target.repo, pr.number); return r.state === 'pending' ? null : r; }, w);
    if (!res) {
      record(run, handoff, { branch, sha, ci: 'timeout', pr: pr.url });
      return out({ branch, sha, pushed, pr, ci: 'timeout', issues, rebuilt, reason: '기다림 한도 안에 CI가 끝나지 않았습니다. 같은 명령을 다시 부르면 이어서 읽습니다(다시 올리지 않습니다).' }, EXIT.timeout);
    }
    const failed = res.checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => c.name);
    record(run, handoff, { branch, sha, ci: res.state, pr: pr.url, failed });
    if (res.state === 'fail') {
      // 관련 이슈를 미완료로 두고(합치기·트레인에서 빠진다) CI 결과를 댓글로 남긴다. 재작업은 코디네이터가 새 하달로 시킨다.
      const body = `${CI_HEAD}: 실패\n\n- 브랜치: ${branch} (${sha})\n- PR: ${pr.url}\n- 실패한 검사: ${failed.join(', ') || '(이름 없음)'}\n- 처리: 재작업(새 하달). 재작업 한도에 센다.\n`;
      for (const n of issues) { await setState(n, LABEL.미완료); comment(n, body); }
    }
    return out({ branch, sha, pushed, pr, ci: res.state, checks: res.checks, failed, issues, rebuilt }, res.state === 'pass' ? EXIT.pass : EXIT.fail);
  } catch (e) {
    if (e instanceof UsageError) return fail(`인자 오류: ${e.message}`);
    if (e instanceof FlowError || e instanceof HarnessError) return fail(e.message);
    if (e instanceof IntegrityError) return fail(`무결성 검사 실패: ${e.message}`);
    if (e?.code === 'ETIMEDOUT' || e?.killed === true) return fail('외부 명령(git 또는 gh)이 제한 시간을 넘겨 중단했습니다.');
    return fail(`예기치 못한 오류(${ONE_LINE(e?.code ?? e?.name ?? 'Error').slice(0, 30)}): ${ONE_LINE(e?.message ?? '').slice(0, 160)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // CI 기다림은 Bash 도구의 10분 제한을 넘을 수 있다: 하달처럼 분리 실행하고 9분 뒤 종료 코드 8과 대기 번호를 낸다.
  const { cliEntry } = await import('./background.mjs');
  process.exitCode = await cliEntry({ main, entry: fileURLToPath(import.meta.url), record: 'last-wait-push' });
}
