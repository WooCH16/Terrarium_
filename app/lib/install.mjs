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

export async function repoVisibility(repo, exec) {
  const r = await exec('gh', ['repo', 'view', repo, '--json', 'visibility', '-q', '.visibility'], {});
  if (r.status !== 0) return { ok: false, error: `저장소를 읽지 못했습니다: ${String(r.stderr || r.error || '').trim().slice(0, 200)}` };
  return { ok: true, visibility: String(r.stdout).trim() };
}

// 성공이면 { ok: true, run, output }, 아니면 { ok: false, error }.
export async function install({ harnessDir, runsDir, repo, runName, project, exec }) {
  const bad = checkInstallInput({ repo, runName, project });
  if (bad) return { ok: false, error: bad };
  const v = await repoVisibility(repo, exec);
  if (!v.ok) return v;
  if (v.visibility !== 'PRIVATE') return { ok: false, error: `지정 저장소 ${repo}가 비공개가 아닙니다(${v.visibility}). 하네스는 비공개 저장소에만 씁니다. 저장소를 비공개로 바꾸거나 다른 저장소를 고르세요.` };
  const run = `${runsDir.replace(/\\/g, '/')}/${runName}`;
  const args = [`${harnessDir}/setup.mjs`, '--run', run, '--repo', repo, ...(project ? ['--project', project] : [])];
  const r = await exec('node', args, { timeout: 300000 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0) return { ok: false, error: `setup.mjs가 실패했습니다(종료 코드 ${r.status}).`, output };
  return { ok: true, run, output };
}
