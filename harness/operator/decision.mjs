// 사용자 결정 흐름(결정 8-44).
// 리뷰어가 거부 이유에 [사용자 결정]을 붙이면, 다음 하달의 시작 스크립트(run-operator)가 결정마다 새 이슈를 만들고(결정필요 라벨)
// 원래 이슈에 `## 결정 이슈` 댓글로 그 번호를 남긴 뒤 원래 이슈를 결정대기로 둔다(이번 하달에서 뺀다).
// 사용자가 결정 이슈에 댓글로 답하면, 코디네이터 loop가 원래 이슈에 `## 사용자 결정` 댓글로 옮기고 다시 하달한다.
// 그 댓글이 최근 거부 판정 뒤에 있으면 결정 이슈를 다시 만들지 않고 작업한다.
import { VERDICT_HEAD, VERDICT_REJECT, FIX_OWNER, DECISION_LINKS_HEAD, OWNER_DECISION_HEAD, ORIGIN_ISSUE } from './protocol.mjs';

const starts = (c, head) => typeof c?.body === 'string' && c.body.startsWith(head);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWNER_LINE = new RegExp(`^- ${esc(FIX_OWNER)}[ \\t]+(.+?)[ \\t]*$`, 'gm');

// comments: 시간 순서의 이슈 댓글. 돌려주는 값:
//   { action: 'none' }                       최근 판정이 거부가 아니거나 [사용자 결정] 이유가 없거나, 그 뒤에 사용자 결정이 있음
//   { action: 'wait', links: [번호...] }      결정 이슈를 이미 만들었고 아직 사용자 결정이 옮겨지지 않음
//   { action: 'create', items, verdictUrl }   [사용자 결정] 이유마다 결정 이슈를 만든다
export function decisionPlan(comments) {
  const list = Array.isArray(comments) ? comments : [];
  let at = -1;
  for (let i = list.length - 1; i >= 0; i--) if (starts(list[i], VERDICT_HEAD)) { at = i; break; }
  if (at < 0 || !starts(list[at], VERDICT_REJECT)) return { action: 'none' };
  const items = [...list[at].body.matchAll(OWNER_LINE)].map((m) => m[1]);
  if (items.length === 0) return { action: 'none' };
  const after = list.slice(at + 1);
  if (after.some((c) => starts(c, OWNER_DECISION_HEAD))) return { action: 'none' };
  const link = [...after].reverse().find((c) => starts(c, DECISION_LINKS_HEAD));
  if (link) return { action: 'wait', links: [...link.body.matchAll(/^- #([1-9]\d{0,8})\s*$/gm)].map((m) => Number(m[1])) };
  return { action: 'create', items, verdictUrl: list[at].url ?? null };
}

export const decisionIssueTitle = ({ origin, title, index, count }) => `[결정 필요] #${origin} ${title ?? ''}${count > 1 ? ` (${index}/${count})` : ''}`.replace(/\s+/g, ' ').trim();

// 결정 이슈 본문: 제안 / 이유 / 예상 결과(코디네이터 질문 양식)와 기계가 읽는 `- 원래 이슈: #n` 줄.
export function decisionIssueBody({ origin, title, item, verdictUrl }) {
  return [
    `- ${ORIGIN_ISSUE}: #${origin}`,
    '',
    '## 제안',
    `이슈 #${origin}${title ? `(${title})` : ''}의 리뷰어 판정에서 사용자 결정이 필요한 문제가 나왔습니다. 어떻게 할지 정해 주세요.`,
    '',
    `> ${item}`,
    '',
    '## 이유',
    `리뷰어가 이 문제를 이슈의 목표·완료 기준 안에서 워커가 고칠 수 없다고 보았습니다(기준을 바꾸거나 넓히기, 이슈가 정하지 않은 갈림길).${verdictUrl ? ` 판정: ${verdictUrl}` : ''}`,
    '',
    '## 예상 결과',
    `이 이슈에 댓글로 결정을 달면, 코디네이터 loop가 그 댓글을 이슈 #${origin}에 옮기고 다시 하달합니다. 그때까지 #${origin}은 \`결정대기\`입니다.`,
    '',
  ].join('\n');
}

export const decisionLinksComment = (numbers) => `${DECISION_LINKS_HEAD}\n${numbers.map((n) => `- #${n}`).join('\n')}\n`;
