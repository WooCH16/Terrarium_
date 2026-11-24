// CI 검사: 의존성 없이 Node만으로 실행된다(npm install 없이).
//  1) 관제탑 화면(app/tower/*.js) 문법 검사
//  2) app/tower/index.html 이 참조하는 로컬 파일이 있는지. 앱 의존성(../node_modules/<패키지>/...)은 app/package.json에 그 패키지가 고정 버전으로 있는지 본다
//  3) 화면에 가짜 데이터·거짓 장식(예시 계정·폴더, YOLO, bypass permissions)이 남지 않았는지
//  4) 화면의 CSP가 인라인 스크립트를 막는지
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const tower = path.join(root, 'app', 'tower');
let failed = false;
const fail = (msg) => { console.error('FAIL ' + msg); failed = true; };
const ok = (msg) => console.log('ok   ' + msg);

// 1) 문법
for (const f of fs.readdirSync(tower).filter((n) => n.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', path.join(tower, f)], { stdio: 'pipe' });
    ok('syntax app/tower/' + f);
  } catch (e) {
    fail('syntax app/tower/' + f + '\n' + String(e.stderr || e.message));
  }
}

// 2) index.html 의 로컬 참조
const html = fs.readFileSync(path.join(tower, 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'app', 'package.json'), 'utf8'));
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\/|^#|^data:/.test(u));
for (const r of new Set(refs)) {
  const dep = r.match(/^\.\.\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (dep) {
    const v = pkg.dependencies && pkg.dependencies[dep[1]];
    v && /^\d+\.\d+\.\d+$/.test(v) ? ok('dep ' + dep[1] + '@' + v + ' (' + r + ')') : fail('index.html 이 app/package.json에 고정 버전으로 없는 패키지를 참조: ' + r);
  } else {
    fs.existsSync(path.join(tower, r)) ? ok('ref ' + r) : fail('index.html 이 없는 파일을 참조: ' + r);
  }
}

// 3) 가짜 데이터·거짓 장식
const screen = html + fs.readdirSync(tower).filter((n) => n.endsWith('.js')).map((n) => fs.readFileSync(path.join(tower, n), 'utf8')).join('\n');
for (const bad of ['YOLO', 'bypass permissions', 'Votelanding', 'kai@example.com', '예시 데이터']) {
  screen.includes(bad) ? fail('화면에 가짜 데이터·거짓 장식이 남음: ' + bad) : ok('no ' + JSON.stringify(bad));
}

// 4) CSP
const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) || '';
scriptSrc === "script-src 'self'" ? ok('CSP ' + scriptSrc) : fail("CSP의 script-src가 'self'만이 아님: " + (scriptSrc || csp));

process.exit(failed ? 1 : 0);
