// 앱 스모크 시험: npm run smoke (app 폴더에서). 진짜 앱 창을 띄워 입력 이벤트로 움직이고, 화면 그림을 남긴다.
//   node test/smoke.mjs [--out <폴더>]
// 임시 앱 데이터 폴더와 임시 실행 폴더를 만들어 쓴다(사용자의 %APPDATA%\Terrarium은 건드리지 않는다).
// 코디네이터는 진짜 claude 대신 가짜 코디네이터(fake-coordinator.mjs)다: 모델·네트워크·GitHub를 부르지 않는다.
// 결과: <out>/results.json, 화면 그림. 모든 검사가 통과하면 종료 코드 0.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const harnessDir = resolve(appDir, '..', 'harness').replace(/\\/g, '/');
const outArg = process.argv.indexOf('--out');
const out = resolve(outArg > 0 ? process.argv[outArg + 1] : join(appDir, 'out', 'smoke'));
mkdirSync(out, { recursive: true });
rmSync(join(out, 'results.json'), { force: true }); // 앞선 결과가 남아 통과로 읽히지 않게

const tmp = mkdtempSync(join(tmpdir(), 'terrarium-smoke-'));
const userData = join(tmp, 'userdata');
const run = join(tmp, 'smoke-run').replace(/\\/g, '/');
mkdirSync(userData, { recursive: true });
mkdirSync(`${run}/handoffs`, { recursive: true });
writeFileSync(`${run}/harness.json`, JSON.stringify({ harnessDir, designatedRepo: 'owner/smoke-issues', projectName: 'memo', runDir: run }, null, 2));
writeFileSync(join(userData, 'prefs.json'), JSON.stringify({ currentRun: run, extraRuns: [run], preflightOk: true }));

const electron = createRequire(import.meta.url)('electron');
const r = spawnSync(electron, ['.'], {
  cwd: appDir,
  stdio: 'inherit',
  timeout: 240000,
  env: {
    ...process.env,
    TERRARIUM_USER_DATA: userData,
    TERRARIUM_SMOKE: out,
    TERRARIUM_FAKE_CLAUDE: join(here, 'fake-coordinator.mjs'),
    TERRARIUM_FLOW_QUIET_MS: '3000',
    TERRARIUM_FLOW_LINGER_MS: '2000',
    TERRARIUM_TESTGO_MS: '15000',
  },
});
let results = [];
try { results = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')); } catch { /* 앱이 결과를 못 씀 */ }
const failed = results.filter((x) => !x.ok);
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 가짜 코디네이터가 아직 잡고 있음 */ }
if (!results.length) { console.error(`SMOKE FAILED: 결과 없음(종료 코드 ${r.status}${r.error ? `, ${r.error.message}` : ''})`); process.exit(1); }
console.log(failed.length ? `SMOKE FAILED: ${failed.length} of ${results.length}` : `SMOKE OK: ${results.length} checks`);
for (const f of failed) console.log(`  FAIL ${f.name} ${JSON.stringify(f.detail ?? '')}`);
process.exit(failed.length || r.status ? 1 : 0);
