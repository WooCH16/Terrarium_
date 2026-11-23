// 코디네이터(Claude Code)의 statusline 명령. 앱이 코디네이터를 띄울 때 --settings로 이 명령을 넘긴다.
// Claude Code가 stdin으로 주는 JSON에서 화면에 쓸 값만 골라 파일 하나에 쓰고(관제탑의 사용량·모델 칸),
// 터미널 아래 줄에는 짧은 한 줄을 찍는다. 앱의 Electron이 아니라 사용자의 node로 돈다(설치본은 asar 밖에 푼다).
//   node statusline.mjs <쓸 파일>
// 사용량(rate_limits)은 Claude 구독(Pro·Max) 계정에서, 세션의 첫 응답 뒤에만 온다(Claude Code statusline 문서).
import { writeFileSync, renameSync } from 'node:fs';

const out = process.argv[2];
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw); } catch { /* 빈 입력 */ }
  const pick = (w) => (w && typeof w.used_percentage === 'number' ? { pct: Math.round(w.used_percentage), resetsAt: typeof w.resets_at === 'number' ? w.resets_at : null } : null);
  const snap = {
    at: new Date().toISOString(),
    model: typeof j.model?.display_name === 'string' ? j.model.display_name : null,
    version: typeof j.version === 'string' ? j.version : null,
    fiveHour: pick(j.rate_limits?.five_hour),
    sevenDay: pick(j.rate_limits?.seven_day),
    context: typeof j.context_window?.used_percentage === 'number' ? Math.round(j.context_window.used_percentage) : null,
  };
  if (out) {
    try { writeFileSync(`${out}.tmp`, JSON.stringify(snap)); renameSync(`${out}.tmp`, out); } catch { /* 못 써도 줄은 찍는다 */ }
  }
  const parts = [snap.model ?? 'Claude'];
  if (snap.fiveHour) parts.push(`5h ${snap.fiveHour.pct}%`);
  if (snap.sevenDay) parts.push(`7d ${snap.sevenDay.pct}%`);
  if (snap.context !== null) parts.push(`ctx ${snap.context}%`);
  process.stdout.write(`${parts.join(' · ')} · Terrarium 코디네이터`);
});
