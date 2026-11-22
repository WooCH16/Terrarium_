// 시험용 가짜 gh(결정 8-32, workflow.md 부록 B). HARNESS_GH_BIN으로 이 파일을 주면 진짜 GitHub 대신 이것이 불린다.
// 상태는 FAKE_GH_STATE가 가리키는 JSON 파일 하나다. 대상 저장소의 GitHub Actions가 하는 일을 흉내 낸다:
// - 이슈(지정 저장소): issue view·edit·comment, 댓글 REST(api .../comments), label create, repo view
// - 대상 저장소: pr list가 불리면 원격(로컬 bare 저장소)에 올라온 브랜치를 보고 PR을 연다·갱신한다(harness-issue-pr·handoff-pr 흉내)
//   pr checks는 state.ci[<브랜치>](pass·fail·pending, 기본 pass)로 답한다
//   workflow run harness-train.yml은 bare 저장소에서 진짜로 트레인을 쌓고, 통과하면 main을 빨리감기, 실패하면 맨 뒤부터 빼며 실패 하달을 찾는다
//   (state.trainFail: 쌓이면 CI가 실패하는 하달 목록). 결과는 실행 기록(run view --log)에 HARNESS_TRAIN_RESULT 줄로 남는다
// - 모든 호출은 state.calls에 남는다(시험이 "무엇을 불렀나"를 단언한다).
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const file = process.env.FAKE_GH_STATE;
const S = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
S.calls = [...(S.calls ?? []), args];
const save = () => writeFileSync(file, JSON.stringify(S, null, 2));
const done = (text = '', code = 0, err = '') => { save(); if (text) process.stdout.write(text); if (err) process.stderr.write(err); process.exit(code); };
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const flags = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=fake-actions', '-c', 'user.email=actions@localhost', ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
const gitTry = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return null; } };
const bareSha = (b) => (S.remote ? gitTry(S.remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`) : null);
const T0 = '2026-11-22T00:00:00Z';

const [a0, a1] = args;
if (a0 === 'repo' && a1 === 'view') done(`${S.visibility ?? 'PRIVATE'}\n`);
if (a0 === 'label' && a1 === 'create') done('');
if (a0 === 'api' && a1 === 'user') done(`${S.login ?? 'someone'}\n`);

// ---- 이슈 ----
const issueOf = (n) => { const i = S.issues?.[n]; if (!i) done('', 1, `issue ${n} not found\n`); return i; };
if (a0 === 'issue' && a1 === 'view') {
  const n = args[2];
  const i = issueOf(n);
  done(JSON.stringify({ number: Number(n), state: 'OPEN', url: `https://github.com/${S.designated ?? 'o/r'}/issues/${n}`, body: i.body, labels: (i.labels ?? []).map((name) => ({ name })),
    comments: (i.comments ?? []).map((c) => ({ body: c.body, url: c.html_url, author: { login: c.user?.login } })) }));
}
if (a0 === 'api' && /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/.test(a1 ?? '')) {
  const n = /issues\/(\d+)\//.exec(a1)[1];
  done(JSON.stringify(issueOf(n).comments ?? []));
}
if (a0 === 'issue' && a1 === 'edit') {
  const i = issueOf(args[2]);
  const remove = new Set(flags('--remove-label'));
  i.labels = [...new Set([...(i.labels ?? []).filter((l) => !remove.has(l)), ...flags('--add-label')])];
  done('');
}
if (a0 === 'issue' && a1 === 'comment') {
  const i = issueOf(args[2]);
  const id = 5000 + (S.nextComment = (S.nextComment ?? 0) + 1);
  const body = flag('--body') ?? readFileSync(flag('--body-file'), 'utf8');
  i.comments = [...(i.comments ?? []), { id, user: { login: 'harness' }, body, created_at: T0, updated_at: T0, html_url: `https://github.com/${S.designated ?? 'o/r'}/issues/${args[2]}#issuecomment-${id}` }];
  done(`https://github.com/${S.designated ?? 'o/r'}/issues/${args[2]}#issuecomment-${id}\n`);
}

// ---- 대상 저장소: 워크플로 파일, 권한 ----
if (a0 === 'api' && /\/contents\/\.github\/workflows\//.test(a1 ?? '')) {
  const name = /workflows\/([^?]+)/.exec(a1)[1];
  const has = S.workflows === 'remote' ? gitTry(S.remote, 'cat-file', '-e', `main:.github/workflows/${name}`) !== null : S.workflows !== false;
  if (has) done(`.github/workflows/${name}\n`);
  done('', 1, 'gh: Not Found (HTTP 404)\n');
}
if (a0 === 'api' && /\/actions\/permissions\/workflow$/.test(a1 ?? '')) {
  if (!S.permissions) done('', 1, 'gh: Not Found (HTTP 404)\n');
  done(JSON.stringify(S.permissions));
}

// ---- PR (Actions가 연 것을 흉내) ----
S.prs = S.prs ?? [];
const prUrl = (n) => `https://github.com/${S.target ?? 'owner/app'}/pull/${n}`;
function syncPr(head, base) {
  const h = bareSha(head);
  const b = bareSha(base);
  if (!h || !b) return;
  const open = S.prs.find((p) => p.headRefName === head && p.baseRefName === base && p.state === 'OPEN');
  const ahead = Number(gitTry(S.remote, 'rev-list', '--count', `${b}..${h}`) ?? '0');
  if (open) {
    if (ahead === 0) open.state = 'MERGED';
    else open.headRefOid = h;
    return;
  }
  if (ahead === 0 || S.noPr?.includes(head)) return; // 앞선 커밋이 없으면 Actions도 PR을 열지 않는다
  const number = (S.nextPr = (S.nextPr ?? 0) + 1);
  S.prs.push({ number, url: prUrl(number), headRefName: head, baseRefName: base, headRefOid: h, state: 'OPEN', openedBy: 'actions' });
}
if (a0 === 'pr' && a1 === 'list') {
  const head = flag('--head');
  const base = flag('--base');
  syncPr(head, base);
  const st = flag('--state') ?? 'open';
  done(JSON.stringify(S.prs.filter((p) => p.headRefName === head && p.baseRefName === base && (st === 'all' || p.state === st.toUpperCase()))));
}
if (a0 === 'pr' && a1 === 'checks') {
  const pr = S.prs.find((p) => String(p.number) === args[2]);
  if (!pr) done('', 1, 'no pull requests found\n');
  const r = S.ci?.[pr.headRefName] ?? 'pass';
  const list = [{ name: 'harness-ci / test', bucket: r, state: r === 'pass' ? 'SUCCESS' : r === 'fail' ? 'FAILURE' : 'IN_PROGRESS', link: `${pr.url}/checks` }];
  done(JSON.stringify(list), r === 'fail' ? 1 : r === 'pending' ? 8 : 0);
}
if (a0 === 'pr' && a1 === 'create') {
  const number = (S.nextPr = (S.nextPr ?? 0) + 1);
  S.prs.push({ number, url: prUrl(number), headRefName: flag('--head'), baseRefName: flag('--base'), headRefOid: bareSha(flag('--head')), state: 'OPEN', title: flag('--title'), body: flag('--body'), openedBy: 'gh' });
  done(`${prUrl(number)}\n`);
}

// ---- 트레인 (harness-train.yml 흉내) ----
S.runs = S.runs ?? [];
if (a0 === 'workflow' && a1 === 'run') {
  if (args[2] !== 'harness-train.yml') done('', 1, 'could not find any workflows named that\n');
  if (S.workflowRunFails) done('', 1, 'HTTP 403\n');
  const fields = Object.fromEntries(flags('-f').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const handoffs = fields.handoffs.split(',');
  const id = 9000 + S.runs.length + 1;
  const train = `train/20261122-${S.runs.length + 1}`;
  const work = mkdtempSync(join(tmpdir(), 'fake-train-'));
  const log = [];
  try {
    git(work, 'clone', '-q', S.remote, 'w');
    const w = join(work, 'w');
    const attempt = (stack) => {
      git(w, 'checkout', '-q', '-B', train, 'origin/main');
      for (const h of stack) {
        if (gitTry(w, 'merge', '-q', '--no-ff', `origin/integration/${h}`, '-m', `트레인: ${h}`) === null) { gitTry(w, 'merge', '--abort'); return { ok: false }; }
      }
      return { ok: !stack.some((h) => (S.trainFail ?? []).includes(h)), tip: git(w, 'rev-parse', 'HEAD') };
    };
    const full = attempt(handoffs);
    let result;
    if (full.ok) {
      git(w, 'push', '-q', 'origin', `${full.tip}:refs/heads/${train}`, `${full.tip}:refs/heads/main`);
      for (const p of S.prs) if (p.baseRefName === 'main' && handoffs.some((h) => p.headRefName === `integration/${h}`) && p.state === 'OPEN') p.state = 'MERGED';
      result = { result: 'merged', train, merged: handoffs, failedHandoff: null, passingPrefix: handoffs, mainAfter: full.tip };
    } else {
      let k = handoffs.length - 1;
      for (; k > 0; k--) if (attempt(handoffs.slice(0, k)).ok) break;
      result = { result: 'failed', train, merged: [], failedHandoff: handoffs[k], passingPrefix: handoffs.slice(0, k), mainAfter: null };
    }
    log.push(`train\tresult\t${T0} HARNESS_TRAIN_RESULT ${JSON.stringify(result)}`);
    S.runs.push({ databaseId: id, displayTitle: `harness-train ${fields.request}`, status: S.runStaysQueued ? 'in_progress' : 'completed', conclusion: result.result === 'merged' ? 'success' : 'failure', url: `https://github.com/${S.target ?? 'owner/app'}/actions/runs/${id}`, log: S.noResultLine ? 'nothing\n' : `${log.join('\n')}\n` });
  } finally { rmSync(work, { recursive: true, force: true }); }
  done('');
}
if (a0 === 'run' && a1 === 'list') done(JSON.stringify(S.runs.map(({ log, ...r }) => r).reverse()));
if (a0 === 'run' && a1 === 'view') {
  const r = S.runs.find((x) => String(x.databaseId) === args[2]);
  if (!r) done('', 1, 'run not found\n');
  if (args.includes('--log')) done(r.log);
  const { log, ...rest } = r;
  done(JSON.stringify(rest));
}

done('', 1, `fake gh: 모르는 명령 ${args.join(' ')}\n`);
