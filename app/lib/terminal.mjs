// 코디네이터 터미널(소유자 결정 8-18): 관제탑 화면의 ORCHESTRA 칸에 진짜 Claude Code 대화형 세션을 띄운다.
// 앱은 실행 폴더에서 claude를 의사 터미널(node-pty)로 띄우고, 입출력을 화면의 xterm과 잇기만 한다.
import { randomUUID } from 'node:crypto';

// README "실행" 절과 같은 설정. 대화형이라 -p는 쓰지 않는다.
export const TOOLS = 'Bash Write Edit Read Glob Grep Agent TodoWrite Skill';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 앱을 Claude Code 안에서 띄우면 그 세션의 표지 변수가 따라온다. 그대로 넘기면 코디네이터가 자식 세션으로 여겨
// 대화 기록을 남기지 않는다(이어 열기가 안 됨, 실제 실행에서 확인). 표지만 지우고 사용자 설정 변수는 둔다.
export const SESSION_MARKERS = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_CHILD_NOTES_DIR', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_FORCE_TERMINAL_IMAGES', 'CLAUDE_CODE_SSE_PORT'];
export function coordinatorEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (SESSION_MARKERS.includes(k.toUpperCase())) delete out[k];
  return out;
}

// 세션 id를 앱이 정해 둔다: --continue("이 폴더의 가장 최근 대화")는 시험용 -p 실행이나 오퍼레이터 세션을 잡을 수 있다.
// settingsFile: 앱이 더하는 설정 파일(statusline 명령만 담는다. 실행 폴더의 훅·권한은 그대로다).
export function coordinatorArgs({ resume, sessionId, settingsFile } = {}) {
  for (const id of [resume, sessionId]) if (id !== undefined && !UUID.test(id)) throw new Error('세션 id 모양이 올바르지 않습니다.');
  return ['--setting-sources', 'project,local', '--allowedTools', TOOLS, ...(settingsFile ? ['--settings', settingsFile] : []), ...(resume ? ['--resume', resume] : ['--session-id', sessionId])];
}

// 터미널 하나. ptySpawn·onData·onExit를 받아 시험할 수 있다.
export class CoordinatorTerminal {
  // onSession(id): 띄울 때마다 세션 id를 알린다(앱이 실행 폴더별로 기억한다).
  constructor({ run, bin, preArgs = [], env, ptySpawn, onData, onExit, onSession = () => {}, resume, cols = 90, rows = 20, newId = randomUUID, settingsFile }) {
    Object.assign(this, { run, bin, preArgs, env, ptySpawn, onData, onExit, onSession, cols, rows, newId, settingsFile });
    this.resume = resume && UUID.test(resume) ? resume : undefined;
    this.sessionId = this.resume ?? newId();
    this.pty = null;
  }

  start() {
    if (this.pty) return this.sessionId;
    const resuming = Boolean(this.resume);
    const args = coordinatorArgs({ ...(resuming ? { resume: this.resume } : { sessionId: this.sessionId }), settingsFile: this.settingsFile });
    const p = this.ptySpawn(this.bin, [...this.preArgs, ...args], { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.run, env: this.env });
    this.pty = p;
    this.onSession(this.sessionId);
    let head = '';
    p.onData((d) => { if (head.length < 4000) head += d; this.onData(d); });
    p.onExit(({ exitCode }) => {
      if (this.pty !== p) return;
      this.pty = null;
      // 이어 열 대화가 없으면(첫 실행을 신뢰 확인 화면에서 끝낸 경우 등) 새 대화로 바로 다시 띄운다.
      if (resuming && /No conversation found/i.test(head)) {
        this.resume = undefined;
        this.sessionId = this.newId();
        this.onData('\r\n[이어 열 대화가 없어 새 대화로 시작합니다]\r\n');
        this.start();
        return;
      }
      // 한 번 띄운 세션은 다음부터 이어서 연다.
      this.resume = this.sessionId;
      this.onExit({ code: exitCode, sessionId: this.sessionId });
    });
    return this.sessionId;
  }

  write(data) { this.pty?.write(String(data)); }

  resize(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || rows < 4 || cols > 500 || rows > 300) return;
    this.cols = cols;
    this.rows = rows;
    try { this.pty?.resize(cols, rows); } catch { /* 이미 끝남 */ }
  }

  // kill(pid): 프로세스 트리째 끝낸다(코디네이터가 띄운 하달 대기가 남지 않게).
  stop(kill) {
    const p = this.pty;
    if (!p) return;
    this.pty = null;
    if (kill) kill(p.pid);
    try { p.kill(); } catch { /* 이미 끝남 */ }
  }
}
