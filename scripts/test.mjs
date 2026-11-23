// 하네스 시험 실행(이슈 #27). 의존성 없이 node만 쓴다.
//   node scripts/test.mjs           전체
//   node scripts/test.mjs --fast    빠른 시험(SLOW 목록 제외, 1분 안쪽)
//   node scripts/test.mjs --slow    오래 걸리는 통합 시험만(git 저장소·하위 프로세스를 많이 만든다)
// - 동시 실행은 2개다(더 많으면 Windows에서 uv_spawn·메모리 오류가 난다).
// - 진짜 모델 CLI가 불리지 않게 HARNESS_PI_BIN·HARNESS_AGY_BIN·HARNESS_CLAUDE_BIN의 기본값을 덫(harness/test/helpers/cli-trap.mjs)으로 둔다.
//   시험이 자기 가짜를 주면 그것이 쓰인다. 덫이 불리면 harness/test/.cli-trap.log에 남고 이 스크립트가 실패로 끝난다.
import { readdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'harness', 'test');
// 10초 넘게 걸리는 파일(2026-11-19 Windows에서 잰 값). 새로 오래 걸리는 시험을 넣으면 여기에 더한다.
export const SLOW = [
  'operator-merge.test.mjs', 'operator-launch.test.mjs', 'operator-worker.test.mjs', 'operator-smoke.test.mjs',
  'run-worker.test.mjs', 'operator-rework.test.mjs', 'setup.test.mjs', 'guard.test.mjs',
  'roles-base.test.mjs',
];

export function pick(mode, files) {
  if (mode === 'fast') return files.filter((f) => !SLOW.includes(f));
  if (mode === 'slow') return files.filter((f) => SLOW.includes(f));
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const mode = args.includes('--fast') ? 'fast' : args.includes('--slow') ? 'slow' : 'all';
  if (args.some((a) => !['--fast', '--slow'].includes(a)) || (args.includes('--fast') && args.includes('--slow'))) {
    console.error('usage: node scripts/test.mjs [--fast | --slow]');
    process.exit(2);
  }
  const files = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).sort();
  const missing = SLOW.filter((f) => !files.includes(f));
  if (missing.length) { console.error(`SLOW 목록에 없는 파일이 있습니다: ${missing.join(', ')}`); process.exit(2); }
  const chosen = pick(mode, files);
  const trap = join(testDir, 'helpers', 'cli-trap.mjs');
  const trapLog = join(testDir, '.cli-trap.log');
  rmSync(trapLog, { force: true });
  const env = { ...process.env, HARNESS_CLI_TRAP_LOG: trapLog };
  for (const k of ['HARNESS_PI_BIN', 'HARNESS_AGY_BIN', 'HARNESS_CLAUDE_BIN']) if (!env[k]) env[k] = trap;
  console.log(`${mode}: 시험 파일 ${chosen.length}개`);
  // 데스크톱 앱의 논리 시험(Electron 없이 돈다)은 빠른 시험에 넣는다.
  const appTests = mode === 'slow' ? [] : [join('app', 'test', 'lib.test.mjs'), join('app', 'test', 'flow.test.mjs')];
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...chosen.map((f) => join('harness', 'test', f)), ...appTests], { cwd: root, env, stdio: 'inherit' });
  let code = r.status ?? 1;
  if (existsSync(trapLog)) {
    console.error(`\n진짜 모델 CLI를 부르려 한 시험이 있습니다(덫이 막음):\n${readFileSync(trapLog, 'utf8')}`);
    rmSync(trapLog, { force: true });
    code = code || 1;
  }
  process.exit(code);
}
