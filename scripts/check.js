// CI 검사: 의존성 없이 Node만으로 실행된다.
//  1) js/*.js 문법 검사
//  2) index.html 이 참조하는 로컬 파일(css, js, 이미지)이 존재하는지
//  3) js/app.js 가 쓰는 assets/sprites/<team>-<pose>.png 20장이 모두 있는지
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
let failed = false;
const fail = (msg) => { console.error('FAIL ' + msg); failed = true; };
const ok = (msg) => console.log('ok   ' + msg);

// 1) 문법
const jsDir = path.join(root, 'js');
for (const f of fs.readdirSync(jsDir).filter((n) => n.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', path.join(jsDir, f)], { stdio: 'pipe' });
    ok('syntax js/' + f);
  } catch (e) {
    fail('syntax js/' + f + '\n' + String(e.stderr || e.message));
  }
}

// 2) index.html 의 로컬 참조
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\/|^#|^data:/.test(u));
for (const r of new Set(refs)) {
  fs.existsSync(path.join(root, r)) ? ok('ref ' + r) : fail('index.html 이 없는 파일을 참조: ' + r);
}

// 3) 스프라이트
const teams = ['dev', 'design', 'tester', 'plan', 'sec'];
const poses = ['work', 'stand', 'sit', 'sleep'];
let missing = 0;
for (const t of teams) for (const p of poses) {
  const f = path.join(root, 'assets', 'sprites', t + '-' + p + '.png');
  if (!fs.existsSync(f)) { fail('스프라이트 없음: assets/sprites/' + t + '-' + p + '.png'); missing++; }
}
if (!missing) ok('sprites ' + teams.length * poses.length + '장');

process.exit(failed ? 1 : 0);
