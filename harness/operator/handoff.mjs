import { mkdirSync } from 'node:fs';
import { isInside } from '../policy.mjs';

const base = (runDir) => String(runDir).replace(/\\/g, '/').replace(/\/+$/, '');

function checkHandoff(handoff) {
  if (!/^h\d+$/i.test(String(handoff))) throw new Error(`하달 이름이 올바르지 않습니다: ${handoff}`);
}

// handoffs/h<N> 폴더를 mkdir로 점유한다. 이미 있으면(EEXIST) 다음 번호를 시도한다.
export function nextHandoff(runDir) {
  const parent = `${base(runDir)}/handoffs`;
  mkdirSync(parent, { recursive: true });
  for (let n = 1; ; n++) {
    try {
      mkdirSync(`${parent}/h${n}`);
      return `h${n}`;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

export function handoffNames(handoff, issue, runDir) {
  checkHandoff(handoff);
  const r = base(runDir);
  return {
    integrationBranch: `integration/${handoff}`,
    issueBranch: issue == null ? null : `${handoff}/issue-${issue}`,
    worktree: issue == null ? null : `${r}/worktrees/${handoff}/issue-${issue}`,
    integrationFolder: `${r}/worktrees/${handoff}/integration`,
    logDir: `${r}/logs/${handoff}`,
    sessionFile: `${r}/handoffs/${handoff}/session.json`,
  };
}

// 해당 하달의 worktrees/<h> 폴더와 logs/<h> 폴더 안(또는 그 자체)이면 소유한다.
// isInside가 경로를 정규화(.., 대소문자, 역슬래시)한 뒤 폴더 경계('/')로 비교하므로 h1/h10 오탐이 없다.
export function ownsPath(handoff, p, runDir) {
  checkHandoff(handoff);
  const r = base(runDir);
  return isInside(p, `${r}/worktrees/${handoff}`) || isInside(p, `${r}/logs/${handoff}`);
}
