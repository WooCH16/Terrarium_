// 설치 화면(#38): 지정 저장소가 비공개인지 먼저 보고, 대상 프로젝트를 골라 setup.mjs로 실행 폴더를 만든다.
// exec(bin, args, opts) → { status, stdout, stderr }. 하네스 스크립트는 사용자 컴퓨터의 node로 돈다(ADR 0010 결정 5).
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function checkInstallInput({ repo, runName, project }) {
  if (!REPO.test(repo ?? '')) return '지정 저장소는 <소유자>/<이름> 모양이어야 합니다.';
  if (!RUN_NAME.test(runName ?? '')) return '실행 폴더 이름은 영문·숫자로 시작하는 64자 이하의 영문·숫자·점·밑줄·붙임표여야 합니다.';
  if (project !== undefined && project !== null && project !== '' && typeof project !== 'string') return '대상 프로젝트 경로가 올바르지 않습니다.';
  return null;
}

// gh가 "찾을 수 없다"고 답한 경우만 없는 저장소로 본다(setup.mjs와 같은 기준, 결정 8-28). 로그인·네트워크 실패는 여기 들지 않는다.
const NOT_FOUND = /Could not resolve to a Repository/i;

export async function repoVisibility(repo, exec) {
  const r = await exec('gh', ['repo', 'view', repo, '--json', 'visibility', '-q', '.visibility'], {});
  if (r.status !== 0) {
    const why = String(r.stderr || r.error || '').trim();
    if (NOT_FOUND.test(why)) return { ok: false, missing: true, error: `지정 저장소 ${repo}가 없습니다.` };
    return { ok: false, error: `저장소를 읽지 못했습니다: ${why.slice(0, 200)}` };
  }
  return { ok: true, visibility: String(r.stdout).trim() };
}

// 대상 프로젝트의 GitHub 저장소(결정 8-32): origin 주소에서 owner/name을 읽는다. github.com 주소가 아니면 null(로컬 흐름).
export function githubRepoFromUrl(url) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
export async function originRepo(project, exec) {
  if (!project) return null;
  const r = await exec('git', ['-C', project, 'remote', 'get-url', 'origin'], {});
  return r.status === 0 ? githubRepoFromUrl(r.stdout) : null;
}

// 성공이면 { ok: true, run, output }, 아니면 { ok: false, error, missing? }.
// createRepo: 사용자가 "없으면 만들까요?"에 동의했을 때만 true. 저장소가 없을 때 setup.mjs에 --create-repo를 넘긴다(결정 8-28).
// targetRepo·addWorkflows(결정 8-32): 대상 저장소를 harness.json에 적고, 사용자가 "워크플로를 넣을까요?"에 동의했을 때만(true) --add-workflows,
// 아니면 --no-workflows를 넘긴다(대상 저장소에 아무것도 쓰지 않는다).
export async function install({ harnessDir, runsDir, repo, runName, project, createRepo = false, targetRepo = null, addWorkflows = false, exec }) {
  const bad = checkInstallInput({ repo, runName, project });
  if (bad) return { ok: false, error: bad };
  const v = await repoVisibility(repo, exec);
  if (!v.ok && !(v.missing && createRepo === true)) return v;
  if (v.ok && v.visibility !== 'PRIVATE') return { ok: false, error: `지정 저장소 ${repo}가 비공개가 아닙니다(${v.visibility}). 하네스는 비공개 저장소에만 씁니다. 저장소를 비공개로 바꾸거나 다른 저장소를 고르세요.` };
  const run = `${runsDir.replace(/\\/g, '/')}/${runName}`;
  if (targetRepo !== null && !REPO.test(targetRepo)) return { ok: false, error: '대상 저장소는 <소유자>/<이름> 모양이어야 합니다.' };
  const target = targetRepo ? ['--target-repo', targetRepo, addWorkflows === true ? '--add-workflows' : '--no-workflows'] : [];
  const args = [`${harnessDir}/setup.mjs`, '--run', run, '--repo', repo, ...(project ? ['--project', project] : []), ...(v.missing ? ['--create-repo'] : []), ...target];
  const r = await exec('node', args, { timeout: 300000 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0) return { ok: false, error: `setup.mjs가 실패했습니다(종료 코드 ${r.status}).`, output };
  return { ok: true, run, output };
}
