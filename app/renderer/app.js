// 렌더러: window.terrarium(preload)만 쓴다. 바깥에서 온 글은 textContent로만 넣는다(innerHTML 없음).
const T = window.terrarium;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
let currentRun = '';

// ---- 탭 ---- (관제탑 메뉴 [설정]이 어느 탭으로 열지 정한다)
function showTab(tab) {
  const b = document.querySelector(`[data-tab="${tab}"]`);
  if (!b) return;
  for (const x of document.querySelectorAll('[data-tab]')) x.setAttribute('aria-selected', String(x === b));
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === `tab-${tab}`);
  if (tab === 'progress') refreshProgress();
}
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));
T.onSettingsTab(showTab);

// ---- 실행 폴더 ----
async function loadRuns(select) {
  const { runs, current } = await T.listRuns();
  const s = $('run-select');
  s.replaceChildren(el('option', '', '(없음)'));
  s.firstChild.value = '';
  for (const r of runs) { const o = el('option', '', r.split('/').pop()); o.value = r; s.append(o); }
  currentRun = select ?? current ?? '';
  s.value = currentRun;
}
$('run-select').addEventListener('change', async (e) => { currentRun = e.target.value; await T.selectRun(currentRun); refreshProgress(); });
$('run-add').addEventListener('click', async () => { const r = await T.addRun(); if (r.ok) { await loadRuns(r.run); refreshProgress(); } else if (r.error) alert(r.error); });

// ---- 계정 ----
$('pf-run').addEventListener('click', async () => {
  const box = $('pf-result');
  box.className = 'card muted';
  box.textContent = '점검 중… (모델 계정 확인에 1분쯤 걸릴 수 있습니다)';
  const r = await T.preflight($('pf-repo').value.trim() || undefined);
  box.replaceChildren();
  box.className = 'card';
  if (!r.ok) { box.append(el('div', 'bad', r.error)); return; }
  const rep = r.report;
  const list = el('ul', 'checks');
  for (const c of rep.checks ?? []) {
    const li = el('li', c.ok ? 'ok' : 'bad');
    li.append(el('span', 'mark', c.ok ? '통과' : '실패'), el('span', '', ` ${c.label}`));
    if (c.detail) li.append(el('span', 'muted', ` — ${c.detail}`));
    if (!c.ok && c.fix) li.append(el('div', 'fix', c.fix));
    list.append(li);
  }
  box.append(el('div', rep.ok ? 'ok' : 'bad', rep.ok ? '사전 점검 통과' : '사전 점검 실패: 아래 실패 항목을 고치세요'), list);
});
for (const b of document.querySelectorAll('[data-login]')) b.addEventListener('click', () => T.openLogin(b.dataset.login));

async function loadKeys() {
  const s = await T.keyStatus();
  const box = $('keys');
  box.replaceChildren();
  if (!s.encryption) box.append(el('div', 'bad', '이 컴퓨터에서 암호화 저장소를 쓸 수 없어 키를 보관할 수 없습니다.'));
  for (const name of s.names) {
    const row = el('div', 'row key');
    const input = el('input');
    input.type = 'password';
    input.placeholder = s.has[name] ? '저장됨 — 바꾸려면 새 값을 넣으세요' : '없음';
    input.autocomplete = 'off';
    const save = el('button', '', '저장');
    const msg = el('span', s.has[name] ? 'ok' : 'muted', s.has[name] ? '있음' : '없음');
    save.addEventListener('click', async () => {
      const r = await T.setKey(name, input.value);
      input.value = '';
      if (!r.ok) { msg.className = 'bad'; msg.textContent = r.error; return; }
      loadKeys();
    });
    row.append(el('label', '', `${s.labels[name]} (${name})`), input, save, msg);
    box.append(row);
  }
}

// ---- 설치 ----
$('in-pick').addEventListener('click', async () => { const p = await T.pickProject(); if (p) $('in-project').value = p; });
$('in-run').addEventListener('click', async () => {
  const out = $('in-result');
  out.className = 'card muted';
  out.textContent = '설치 중…';
  $('in-run').disabled = true;
  try {
    const r = await T.install({ repo: $('in-repo').value.trim(), runName: $('in-name').value.trim(), project: $('in-project').value.trim() || undefined });
    out.className = r.ok ? 'card ok' : 'card bad';
    out.textContent = r.ok ? `설치했습니다: ${r.run}\n\n${r.output ?? ''}` : `${r.error}${r.output ? `\n\n${r.output}` : ''}`;
    if (r.ok) { await T.selectRun(r.run); await loadRuns(r.run); }
  } finally { $('in-run').disabled = false; }
});

// ---- 진행 ----
const LABEL_CLASS = { 진행중: 'info', 리뷰대기: 'info', 허용됨: 'ok', 반영됨: 'ok', 미완료: 'warn', 보류: 'warn', 대기: 'warn', 막힘: 'bad', 거부목록: 'bad', 취소: 'muted' };
async function refreshProgress() {
  if (!currentRun) return;
  $('pg-time').textContent = '읽는 중…';
  const r = await T.status(currentRun);
  $('pg-time').textContent = new Date().toLocaleTimeString('ko-KR');
  if (!r.ok) { $('pg-issues').textContent = r.error; return; }
  const s = r.status;
  const issues = $('pg-issues');
  issues.replaceChildren();
  issues.className = '';
  if (s.issuesError) issues.append(el('div', 'bad', `이슈를 읽지 못했습니다: ${s.issuesError}`));
  if (s.issues.length === 0 && !s.issuesError) issues.append(el('div', 'muted', '이슈가 없습니다.'));
  for (const i of s.issues) {
    const row = el('div', `issue ${i.open ? '' : 'closed'}`);
    const a = el('a', '', `#${i.number} ${i.title}`);
    a.href = '#';
    a.addEventListener('click', (e) => { e.preventDefault(); T.openUrl(i.url); });
    row.append(el('span', `badge ${LABEL_CLASS[i.label] ?? 'muted'}`, i.label), a, el('span', 'muted', i.open ? '' : ' (닫힘)'));
    issues.append(row);
  }
  const h = $('pg-handoffs');
  h.replaceChildren();
  h.className = '';
  if (s.handoffs.length === 0) h.append(el('div', 'muted', '하달이 없습니다.'));
  for (const x of s.handoffs) h.append(el('div', 'line', `${x.name}  ${x.mode ?? ''}  이슈 ${x.issues.map((n) => `#${n}`).join(', ') || '—'}  ${x.stopped ? '중단됨' : x.running ? '실행 중' : x.orphaned ? '끊김(정리 필요)' : '끝남'}`));
  const a = $('pg-advice');
  a.replaceChildren();
  a.className = '';
  if (s.advice.length === 0) a.append(el('div', 'muted', '조언 판정이 없습니다.'));
  for (const x of s.advice) a.append(el('div', `line ${x.verdict === '허용' ? 'ok' : 'bad'}`, `${x.verdict}  ${x.adviceId}  ${x.sha}  시도 ${x.attempt}`));
  const g = $('pg-guard');
  g.replaceChildren();
  g.className = '';
  g.append(el('div', 'muted', `최근 판정 ${s.guard.total}건 중 거부 ${s.guard.denied.length}건`));
  for (const x of s.guard.denied) g.append(el('div', 'line bad', `${x.who} / ${x.tool}: ${x.reason}`));
}
$('pg-refresh').addEventListener('click', refreshProgress);
setInterval(() => { if (document.querySelector('#tab-progress.active')) refreshProgress(); }, 60000);

loadRuns();
loadKeys();
showTab(new URLSearchParams(location.search).get('tab') || 'accounts');
