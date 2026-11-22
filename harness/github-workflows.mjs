// 워크플로 틀 넣기(결정 8-32 새 결정 3). setup.mjs가 사용자 동의 뒤에 부른다.
// 대상 저장소에 브랜치 harness/add-workflows 하나와 main으로 가는 PR 하나만 만든다. main에는 쓰지 않는다(머지는 사용자가 한다).
// 대상 저장소 main을 읽지 못하거나 같은 브랜치가 이미 있으면 아무것도 쓰지 않는다.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const harnessDir = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
export const WORKFLOW_BRANCH = 'harness/add-workflows';
const HOOKS_SINK = process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null';

// 틀을 채운 파일들: 지정 저장소 이름({{REPO}}, PR 본문의 링크), 시험 명령, 대상 저장소의 자기 CI(있으면 harness-ci.yml은 넣지 않는다).
export function workflowFiles({ designatedRepo, testCommand = 'npm test', ciWorkflow } = {}) {
  const dir = `${harnessDir}/github/workflows`;
  const files = new Map();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.yml')).sort()) {
    if (ciWorkflow && name === 'harness-ci.yml') continue;
    let text = readFileSync(`${dir}/${name}`, 'utf8').replaceAll('{{REPO}}', designatedRepo);
    text = text.replaceAll("vars.HARNESS_TEST_COMMAND || 'npm test'", `vars.HARNESS_TEST_COMMAND || '${testCommand}'`);
    if (ciWorkflow) text = text.replaceAll('uses: ./.github/workflows/harness-ci.yml', `uses: ./.github/workflows/${ciWorkflow}`);
    files.set(name, text);
  }
  return files;
}

// 돌려주는 값: { ok, written: boolean, message, url? }. gh(args)는 stdout 문자열(HARNESS_GH_BIN 대역 포함).
export function addWorkflowsPr({ target, designatedRepo, testCommand, ciWorkflow, gh, env = process.env }) {
  const genv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', `core.hooksPath=${HOOKS_SINK}`, ...a], { stdio: 'pipe', encoding: 'utf8', env: genv, timeout: 300000, windowsHide: true }).trim();
  const ID = ['-c', 'user.name=terrarium-harness', '-c', 'user.email=harness@localhost'];
  let tmp = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'harness-workflows-'));
    const heads = git(tmp, 'ls-remote', target.remote, 'refs/heads/main', `refs/heads/${WORKFLOW_BRANCH}`);
    if (!/\trefs\/heads\/main$/m.test(heads)) return { ok: false, written: false, message: `${target.repo}의 main을 읽지 못해 넣지 않았다` };
    if (heads.includes(`refs/heads/${WORKFLOW_BRANCH}`)) return { ok: false, written: false, message: `${target.repo}에 이미 ${WORKFLOW_BRANCH} 브랜치가 있어 새로 만들지 않았다(그 PR을 머지하거나 브랜치를 지운 뒤 다시)` };
    execFileSync('git', ['clone', '-q', '--no-tags', '--single-branch', '--branch', 'main', target.remote, `${tmp}/w`], { stdio: 'pipe', env: genv, timeout: 600000, windowsHide: true });
    const w = `${tmp}/w`;
    git(w, 'checkout', '-q', '-b', WORKFLOW_BRANCH);
    mkdirSync(`${w}/.github/workflows`, { recursive: true });
    for (const [name, text] of workflowFiles({ designatedRepo, testCommand, ciWorkflow })) writeFileSync(`${w}/.github/workflows/${name}`, text);
    git(w, 'add', '.github/workflows');
    if (git(w, 'status', '--porcelain') === '') return { ok: true, written: false, message: `${target.repo}의 main에 이미 같은 틀이 있다. 아무것도 쓰지 않았다` };
    git(w, ...ID, 'commit', '-q', '-m', 'harness: 워크플로 틀(이슈 PR, 하달 PR, 머지 트레인, CI) 넣기');
    git(w, 'push', '-q', 'origin', `HEAD:refs/heads/${WORKFLOW_BRANCH}`);
    const body = ['Terrarium 하네스 워크플로 틀(결정 8-32).', '',
      '- harness-issue-pr.yml: h<N>/issue-* push → integration/h<N>으로 이슈 PR, CI',
      '- harness-handoff-pr.yml: integration/h<N> push → main으로 하달 PR, CI',
      '- harness-train.yml: 사용자 승인 뒤 하네스가 시작. 하달 PR들을 쌓아 CI 뒤 main 빨리감기',
      ciWorkflow ? `- CI: 이 저장소의 ${ciWorkflow}(workflow_call, ref 입력)` : `- harness-ci.yml: 기본 CI(${testCommand ?? 'npm test'})`, '',
      '머지는 직접 하세요. 저장소 설정에서 Actions가 PR을 만들 수 있게 켜야 합니다(Settings → Actions → General → Workflow permissions).'].join('\n');
    const out = gh(['pr', 'create', '--repo', target.repo, '--base', 'main', '--head', WORKFLOW_BRANCH, '--title', 'Terrarium 하네스 워크플로 넣기', '--body', body]).trim();
    const url = out.split('\n').pop();
    return { ok: true, written: true, url, message: `${target.repo}에 PR 하나를 만들었다(main에는 쓰지 않았다. 머지는 직접): ${url}` };
  } catch (e) {
    return { ok: false, written: null, message: `넣지 못했다(${String(e?.message ?? e).split('\n')[0].slice(0, 160)})` };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
