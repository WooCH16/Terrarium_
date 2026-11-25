// 하네스 시험 실행(이슈 #27). 의존성 없이 node만 쓴다.
//   node scripts/test.mjs           전체
//   node scripts/test.mjs --fast    빠른 시험(SLOW 목록 제외, 1분 안쪽)
//   node scripts/test.mjs --slow    오래 걸리는 통합 시험만(git 저장소·하위 프로세스를 많이 만든다)
//   node scripts/test.mjs --changed <기준>   기준 브랜치와 갈라진 뒤 바뀐 파일에 닿는 시험만. 가릴 수 없으면 전체(scripts/changed-tests.mjs)
// - 동시 실행은 2개다(더 많으면 Windows에서 uv_spawn·메모리 오류가 난다).
// - 진짜 모델 CLI가 불리지 않게 HARNESS_PI_BIN·HARNESS_AGY_BIN·HARNESS_CLAUDE_BIN의 기본값을 덫(harness/test/helpers/cli-trap.mjs)으로 둔다.
//   시험이 자기 가짜를 주면 그것이 쓰인다. 덫이 불리면 harness/test/.cli-trap.log에 남고 이 스크립트가 실패로 끝난다.
import { readdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectTests, changedFiles } from './changed-tests.mjs';

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
  const at = args.indexOf('--changed');
  const base = at < 0 ? null : args.splice(at, 2)[1] ?? '';
  const mode = args.includes('--fast') ? 'fast' : args.includes('--slow') ? 'slow' : 'all';
  if (args.some((a) => !['--fast', '--slow'].includes(a)) || (args.includes('--fast') && args.includes('--slow')) || (base !== null && (args.length > 0 || base === '' || base.startsWith('-')))) {
    console.error('usage: node scripts/test.mjs [--fast | --slow | --changed <기준 ref>]');
    process.exit(2);
  }
  const files = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).sort();
  const missing = SLOW.filter((f) => !files.includes(f));
  if (missing.length) { console.error(`SLOW 목록에 없는 파일이 있습니다: ${missing.join(', ')}`); process.exit(2); }
  let chosen = pick(mode, files);
  let picked = null;
  if (base !== null) {
    const changed = changedFiles(base);
    picked = selectTests(changed, { root });
    console.log(`changed: 기준 ${base}, 바뀐 파일 ${changed ? changed.length : '알 수 없음'}개`);
    for (const f of changed ?? []) console.log(`  ${f}`);
    if (picked.all) console.log(`전체를 돌립니다: ${picked.reason}`);
    else {
      chosen = files.filter((f) => picked.tests.includes(f));
      console.log(`고른 시험: ${chosen.join(', ') || '없음'}${picked.app ? ' + 앱 논리 시험' : ''}`);
      console.log(`건너뛴 하네스 시험 파일: ${files.length - chosen.length}개(바뀐 파일에 닿지 않음)`);
    }
  }
  const trap = join(testDir, 'helpers', 'cli-trap.mjs');
  const trapLog = join(testDir, '.cli-trap.log');
  rmSync(trapLog, { force: true });
  const env = { ...process.env, HARNESS_CLI_TRAP_LOG: trapLog };
  for (const k of ['HARNESS_PI_BIN', 'HARNESS_AGY_BIN', 'HARNESS_CLAUDE_BIN']) if (!env[k]) env[k] = trap;
  console.log(`${base === null ? mode : 'changed'}: 시험 파일 ${chosen.length}개`);
  // 데스크톱 앱의 논리 시험(Electron 없이 돈다)은 빠른 시험에 넣는다.
  const appTests = mode === 'slow' || (picked && !picked.all && !picked.app) ? [] : [join('app', 'test', 'lib.test.mjs'), join('app', 'test', 'flow.test.mjs'), join('app', 'test', 'testgo.test.mjs'), join('app', 'test', 'updater.test.mjs'), join('app', 'test', 'limits.test.mjs'), join('app', 'test', 'links.test.mjs')];
  // 파일 없이 node --test를 부르면 저장소 전체를 스스로 찾아 돌린다. 고른 것이 없으면 부르지 않는다.
  if (chosen.length === 0 && appTests.length === 0) { console.log('돌릴 시험이 없습니다.'); process.exit(0); }
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...chosen.map((f) => join('harness', 'test', f)), ...appTests], { cwd: root, env, stdio: 'inherit' });
  let code = r.status ?? 1;
  if (existsSync(trapLog)) {
    console.error(`\n진짜 모델 CLI를 부르려 한 시험이 있습니다(덫이 막음):\n${readFileSync(trapLog, 'utf8')}`);
    rmSync(trapLog, { force: true });
    code = code || 1;
  }
  process.exit(code);
}
