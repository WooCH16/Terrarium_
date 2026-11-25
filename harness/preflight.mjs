// 사전 점검(이슈 #21): 설치·실행 전에 필요한 것이 갖춰졌는지 한 번에 확인한다.
// node harness/preflight.mjs [--repo <owner/name>] [--target-repo <owner/name>] [--json]
//   --repo: 지정 저장소가 비공개인지도 확인한다.
//   --target-repo: 대상 저장소(코드)에 하네스 워크플로가 main에 있는지, Actions가 PR을 만들 수 있는지 본다(결정 8-32). 경고만 낸다(로컬 흐름으로 돈다).
//   --json: 사람이 읽는 표 대신 JSON 한 개를 낸다(데스크톱 앱 계정 화면이 읽는다).
// 종료 코드: 0 모두 통과, 1 필수 항목 실패(쓸 수 있는 워커 모델이 없음, Jev 키 없음 포함), 2 사용법 오류.
// 계정 로그인 여부는 CLI마다 확인 방법이 달라 여기서는 실행 가능 여부만 본다(gh는 로그인까지 본다).
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcher } from './operator/model-exec.mjs';
import { loadOperatorConfig } from './operator/config.mjs';
import { findJevKey, KEY_NAME } from './operator/jev.mjs';
import { readSecret } from './operator/env-file.mjs';

export const MIN_NODE_MAJOR = 22;
// 결정 9-3(바뀜, 2026-11-19): 리뷰어가 Jev(ADR 0008)라 워커와 다른 리뷰어는 저절로 지켜진다. 워커 모델은 1곳이면 된다(대체 표를 쓰려면 2곳 이상이 낫다).
export const MIN_PROVIDERS = 1;

const harnessDir = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');

function defaultExec(bin, args, timeout = 20000, extraEnv = null) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout, windowsHide: true, ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}) });
  return { status: r.error ? -1 : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
}
const firstLine = (s) => String(s ?? '').trim().split(/\r?\n/)[0] ?? '';

// 돌려주는 값: { ok, checks: [{ id, label, ok, required, detail, fix? }], models: [{ model, cli, ok, detail }], providers }
export function runPreflight(opts = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultExec;
  const find = deps.launcher ?? ((name) => launcher(name, env));
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const cfg = deps.cfg ?? loadOperatorConfig(`${harnessDir}/operator/operator.config.json`);
  const checks = [];
  const add = (c) => { checks.push({ required: true, ...c }); return c.ok; };
  const tryRun = (l, args, extraEnv = null) => (l ? exec(l.bin, [...l.args, ...args], 20000, extraEnv) : { status: -1, stdout: '', stderr: '', error: '찾지 못함' });

  const major = Number(String(nodeVersion).split('.')[0]);
  add({ id: 'node', label: `node ${MIN_NODE_MAJOR} 이상`, ok: major >= MIN_NODE_MAJOR, detail: `v${nodeVersion}`, fix: `node ${MIN_NODE_MAJOR} 이상을 설치하세요` });

  const git = find('git');
  const gitV = tryRun(git, ['--version']);
  add({ id: 'git', label: 'git', ok: gitV.status === 0, detail: gitV.status === 0 ? firstLine(gitV.stdout) : (gitV.error ?? firstLine(gitV.stderr)), fix: 'git을 설치하세요' });

  const gh = find('gh');
  const ghV = tryRun(gh, ['--version']);
  const ghOk = add({ id: 'gh', label: 'GitHub CLI(gh)', ok: ghV.status === 0, detail: ghV.status === 0 ? firstLine(ghV.stdout) : (ghV.error ?? firstLine(ghV.stderr)), fix: 'https://cli.github.com 에서 gh를 설치하세요' });
  let ghAuth = false;
  if (ghOk) {
    const a = tryRun(gh, ['auth', 'status']);
    ghAuth = a.status === 0;
    add({ id: 'gh-auth', label: 'gh 로그인', ok: ghAuth, detail: ghAuth ? '로그인됨' : firstLine(a.stderr || a.stdout) || '로그인 안 됨', fix: 'gh auth login 을 실행하세요' });
  }
  if (opts.repo) {
    let ok = false;
    let detail = 'gh 로그인이 필요해 확인하지 못함';
    if (ghAuth) {
      const v = tryRun(gh, ['repo', 'view', opts.repo, '--json', 'visibility', '-q', '.visibility']);
      const vis = v.status === 0 ? v.stdout.trim() : null;
      ok = vis === 'PRIVATE';
      detail = vis ?? (firstLine(v.stderr) || '확인하지 못함');
    }
    // 결정 8-28: 저장소가 없을 때만 setup --create-repo가 만들어 준다. 공개 저장소는 고쳐 주지 않는다.
    add({ id: 'repo', label: `지정 저장소 ${opts.repo} 비공개`, ok, detail, fix: `비공개 저장소를 지정하세요. 저장소가 없으면 setup.mjs를 --repo 없이 돌리면 알아서 만들고, 이 이름을 쓰려면 --create-repo를 붙이거나 gh repo create ${opts.repo} --private로 만듭니다. 이미 공개인 저장소는 만들어 주지 않으니 다른 비공개 저장소를 지정하세요` });
  }

  // 결정 8-32: 대상 저장소(코드)의 GitHub Actions 흐름. 실패가 아니라 경고다(없으면 로컬 흐름으로 돈다). required: false.
  // opts.targetRepo가 없으면 "대상 원격 없음" 경고 하나만 낸다.
  const warn = (c) => add({ required: false, ...c });
  const LOCAL = '없어도 하네스는 로컬 흐름(run-reflect)으로 돌고 끝 보고에 "CI 없음"을 적습니다';
  if (!opts.targetRepo) {
    warn({ id: 'target-remote', label: '대상 저장소(PR·CI는 GitHub Actions)', ok: false, detail: '지정하지 않음', fix: `setup.mjs --target-repo <owner/name>으로 대상 저장소를 주고 --add-workflows로 워크플로를 PR 하나로 넣으세요. ${LOCAL}` });
  } else if (!ghAuth) {
    warn({ id: 'target-remote', label: `대상 저장소 ${opts.targetRepo}`, ok: false, detail: 'gh 로그인이 필요해 확인하지 못함', fix: `gh auth login 뒤 다시 점검하세요. ${LOCAL}` });
  } else {
    const t = opts.targetRepo;
    const view = tryRun(gh, ['repo', 'view', t, '--json', 'visibility', '-q', '.visibility']);
    const reach = view.status === 0;
    warn({ id: 'target-remote', label: `대상 저장소 ${t}`, ok: reach, detail: reach ? `있음(${view.stdout.trim()}). 공개 저장소면 PR 본문에는 링크만 답니다` : (firstLine(view.stderr) || '읽지 못함'), fix: `저장소 이름과 gh 권한을 확인하세요. ${LOCAL}` });
    if (reach) {
      const files = ['harness-issue-pr.yml', 'harness-handoff-pr.yml', 'harness-train.yml'];
      const missing = files.filter((f) => tryRun(gh, ['api', `repos/${t}/contents/.github/workflows/${f}?ref=main`, '--jq', '.path']).status !== 0);
      warn({ id: 'target-workflows', label: '워크플로 틀이 대상 저장소 main에 있음', ok: missing.length === 0, detail: missing.length === 0 ? '셋 다 있음' : `없음: ${missing.join(', ')}`, fix: `setup.mjs --refresh --add-workflows로 PR 하나를 만들고 직접 머지하세요. ${LOCAL}` });
      // 확인 필요: GET repos/{owner}/{repo}/actions/permissions/workflow의 필드 이름(default_workflow_permissions: read|write,
      // can_approve_pull_request_reviews: "Allow GitHub Actions to create and approve pull requests" 설정)은 GitHub REST 문서로 다시 확인한다(S12 전).
      const p = tryRun(gh, ['api', `repos/${t}/actions/permissions/workflow`]);
      let perm = null;
      try { perm = p.status === 0 ? JSON.parse(p.stdout) : null; } catch { perm = null; }
      const canPr = perm?.can_approve_pull_request_reviews === true;
      warn({
        id: 'target-actions', label: 'Actions가 PR을 만들 수 있음', ok: canPr,
        detail: perm ? `can_approve_pull_request_reviews=${String(perm.can_approve_pull_request_reviews)}, default_workflow_permissions=${String(perm.default_workflow_permissions)}(워크플로가 contents·pull-requests write를 직접 적는다)` : (firstLine(p.stderr) || '설정을 읽지 못함(저장소 관리자 권한이 필요할 수 있음)'),
        fix: `저장소 Settings → Actions → General → Workflow permissions에서 "Allow GitHub Actions to create and approve pull requests"를 켜세요. main 보호 규칙이 있으면 트레인의 main 빨리감기가 막힐 수 있습니다. ${LOCAL}`,
      });
    }
  }

  // 코디네이터·오퍼레이터 세션은 Claude Code다. 하네스는 셸 없이 띄우므로 HARNESS_CLAUDE_BIN을 쓴다면 .exe나 .js여야 한다(.cmd 불가).
  const claudeOverride = env.HARNESS_CLAUDE_BIN;
  if (claudeOverride) {
    add({
      id: 'claude-bin', label: 'HARNESS_CLAUDE_BIN 형태', ok: !/\.(cmd|bat)$/i.test(claudeOverride), detail: claudeOverride,
      fix: 'HARNESS_CLAUDE_BIN은 .cmd가 아니라 claude.exe 또는 .js 진입 파일을 가리키거나, 지우고 PATH의 claude를 쓰게 하세요',
    });
  }
  const claude = find('claude');
  const claudeV = tryRun(claude, ['--version']);
  add({ id: 'claude', label: 'Claude Code(claude), 코디네이터·오퍼레이터용', ok: claudeV.status === 0, detail: claudeV.status === 0 ? `${firstLine(claudeV.stdout)} (${claude.args[0] ?? claude.bin})` : (claudeV.error ?? firstLine(claudeV.stderr)), fix: 'Claude Code를 설치하고 claude 로 로그인하세요' });

  // 리뷰어·라우팅 모델 Jev(이슈 #44)의 키. 값은 보지 않고 있는지와 출처만 알린다.
  const jevKey = (deps.findJevKey ?? findJevKey)({ env, harnessDir });
  add({
    id: 'jev-key', label: `Jev(TypeSafe) 키 ${KEY_NAME}, 리뷰어·라우팅용`, ok: Boolean(jevKey),
    detail: jevKey ? `있음(${jevKey.source})` : '없음',
    fix: `TypeSafe 콘솔에서 키를 만들어 환경 변수 ${KEY_NAME}나 실행 폴더의 .env에 ${KEY_NAME}=<키> 한 줄로 넣으세요`,
  });

  // 워커 모델: 설정의 runners마다 CLI가 실행되는지 본다. 모델 값마다 제공사가 다르다(claude, gemini, muse).
  const models = [];
  const seen = new Map();
  for (const model of cfg.allowedModels) {
    const r = cfg.runners[model];
    const cli = r?.cli ?? r?.command?.[0];
    if (!cli) { models.push({ model, cli: null, ok: false, detail: '설정에 실행 경로 없음' }); continue; }
    if (!seen.has(cli)) {
      const l = cli === 'claude' ? claude : find(cli);
      const v = cli === 'claude' ? claudeV : tryRun(l, ['--version']);
      seen.set(cli, { ok: v.status === 0, detail: v.status === 0 ? firstLine(v.stdout) || '실행됨' : (v.error ?? (firstLine(v.stderr) || `종료 코드 ${v.status}`)) });
    }
    const base = seen.get(cli);
    // Pi는 모델마다 제공사 자격 증명이 따로다(이슈 #26: 세 모델 모두 Pi). 실행은 되어도 그 모델의 계정이 준비되지 않았으면 쓸 수 없다.
    // 비밀값(runners.<m>.secretEnv, 예: GEMINI_API_KEY)은 환경 변수나 .env에서 읽어 확인 명령에만 넘긴다. 값은 결과에 넣지 않는다.
    const secrets = {};
    const missing = [];
    for (const name of r.secretEnv ?? []) { const v = (deps.readSecret ?? readSecret)(name, { env, harnessDir }); if (v) secrets[name] = v.value; else missing.push(name); }
    if (missing.length) { models.push({ model, cli, ok: false, detail: `비밀값 ${missing.join(', ')} 없음. 환경 변수나 실행 폴더의 .env에 넣으세요` }); continue; }
    if (base.ok && cli === 'pi' && r.modelId) {
      // 난이도별 모델(tiers, 소유자 결정 8-16)이 있으면 그 모델마다 확인한다.
      const ids = [...new Set([r.modelId, ...Object.values(r.tiers ?? {})])];
      const bad = [];
      for (const id of ids) {
        const a = tryRun(find('pi'), ['auth', 'check', '--model', id], Object.keys(secrets).length ? secrets : null);
        if (a.status !== 0) bad.push(`${id}: ${firstLine(a.stdout) || firstLine(a.stderr) || `종료 코드 ${a.status}`}`);
      }
      models.push({ model, cli, ok: bad.length === 0, detail: bad.length === 0 ? `${base.detail}, 계정 준비됨(${ids.join(', ')})` : `Pi 계정 준비 안 됨(${bad.join('; ')}). pi auth login으로 연결하세요` });
      continue;
    }
    models.push({ model, cli, ...base });
  }
  const providers = models.filter((m) => m.ok).length;
  add({
    id: 'providers', label: `쓸 수 있는 워커 모델 ${MIN_PROVIDERS}곳 이상`, ok: providers >= MIN_PROVIDERS,
    detail: `${providers}곳: ${models.filter((m) => m.ok).map((m) => m.model).join(', ') || '없음'}`,
    fix: `워커를 띄울 모델이 ${MIN_PROVIDERS}곳 이상 필요합니다. ${models.filter((m) => !m.ok).map((m) => `${m.model}(${m.cli ?? '?'})`).join(', ')} 중 하나 이상을 설치·로그인하세요`,
  });

  return { ok: checks.every((c) => c.ok || !c.required), checks, models, providers };
}

export function formatReport(res) {
  const out = [];
  for (const c of res.checks) {
    out.push(`${c.ok ? '통과' : c.required ? '실패' : '경고'}  ${c.label}  — ${c.detail}`);
    if (!c.ok && c.fix) out.push(`      할 일: ${c.fix}`);
  }
  out.push('', '모델(워커·리뷰어):');
  for (const m of res.models) out.push(`  ${m.ok ? '있음' : '없음'}  ${m.model} (${m.cli ?? '?'})  — ${m.detail}`);
  out.push('', res.ok ? '사전 점검 통과' : '사전 점검 실패: 위의 "할 일"을 마친 뒤 다시 돌리세요');
  return out.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')) {
  const argv = process.argv.slice(2);
  const known = new Set(['--repo', '--target-repo', '--json']);
  const valueOf = (name) => { const i = argv.indexOf(name); return i === -1 ? { given: false } : { given: true, v: argv[i + 1] }; };
  const badValue = ({ given, v }) => given && (!v || v.startsWith('--') || !/^[\w.-]+\/[\w.-]+$/.test(v));
  const r = valueOf('--repo');
  const t = valueOf('--target-repo');
  const bad = argv.some((a) => a.startsWith('--') && !known.has(a)) || badValue(r) || badValue(t);
  if (bad) {
    console.error('usage: node harness/preflight.mjs [--repo <owner/name>] [--target-repo <owner/name>] [--json]');
    process.exit(2);
  }
  const res = runPreflight({ repo: r.v, targetRepo: t.v });
  console.log(argv.includes('--json') ? JSON.stringify(res, null, 2) : formatReport(res));
  process.exit(res.ok ? 0 : 1);
}
