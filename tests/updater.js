// End-to-end auto-update test on the PACKAGED app (dist/win-unpacked):
//   1. a fake GitHub release offers v9.9.9 → the app downloads + verifies it
//   2. next start: the launcher runs 9.9.9 from the versions folder and it
//      confirms itself as good
//   3. a damaged v9.9.10 is never used: the launcher falls back
//   node tests/updater.js   (after `npm run dist`)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const exe = path.join(root, 'dist', 'win-unpacked', 'Wavelength.exe');
const asar = require('fs').readFileSync(path.join(root, 'dist', fs.readdirSync(path.join(root, 'dist')).find((f) => /^wavelength-app-.*\.asar$/.test(f))));
const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const SHELL = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'wavelength-update.json'), 'utf8')).shell;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-upd-'));
let ok = true;
const check = (name, cond, detail = '') => { ok = ok && !!cond; console.log(`${cond ? 'ok  ' : 'FAIL'} [updater] ${name}${detail ? ' — ' + detail : ''}`); };

const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.url === '/repos/test/wavelength/releases/latest') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ tag_name: 'v9.9.9', body: 'Test release notes', assets: [
      { name: 'wavelength-update.json', browser_download_url: `${base}/dl/manifest` },
      { name: 'wavelength-app-9.9.9.asar', browser_download_url: `${base}/dl/asar` },
    ] }));
  }
  if (req.url === '/dl/manifest') {
    return res.end(JSON.stringify({ version: '9.9.9', shell: process.env.WL_DEV ? electronVersion : SHELL,
      app: { name: 'wavelength-app-9.9.9.asar', size: asar.length, sha256: crypto.createHash('sha256').update(asar).digest('hex') } }));
  }
  if (req.url === '/dl/asar') { res.setHeader('content-length', asar.length); return res.end(asar); }
  res.statusCode = 404; res.end();
});

function run(script, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.env.WL_DEV ? require('electron') : exe, process.env.WL_DEV ? [root] : [], { env: { ...process.env, WL_USERDATA: userData, WL_TEST_SCRIPT: path.join(__dirname, script),
      WL_UPDATE_API: `http://127.0.0.1:${server.address().port}`, WL_UPDATE_REPO: 'test/wavelength', ...extraEnv } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => p.kill(), 120000);
    p.on('exit', () => { clearTimeout(t); resolve(out); });
  });
}
const lines = (out) => out.split(/\r?\n/).filter((l) => /^UPD /.test(l)).map((l) => l.slice(4));

server.listen(0, '127.0.0.1', async () => {
  // 1) download
  const a = lines(await run('updater-a.js', { WL_TEST_UPDATER: '1' }));
  const sa = JSON.parse(a.find((l) => l.startsWith('{')) || '{}');
  a.filter((l) => /pill-debug/.test(l)).forEach((l) => console.log('ok   debug ' + l));
  check('finds v9.9.9 and downloads just the app file', sa.ready && sa.ready.version === '9.9.9' && sa.ready.kind === 'app', JSON.stringify(sa.ready));
  const file = path.join(userData, 'versions', '9.9.9', 'app.asar');
  const gotSha = fs.existsSync(file) ? crypto.createHash('sha256').update(require('original-fs' in process.versions ? 'fs' : 'fs').readFileSync(file)).digest('hex') : '';
  check('download saved and verified', gotSha === crypto.createHash('sha256').update(asar).digest('hex'));
  check('title bar shows "Update ready"', a.includes('pill visible'));

  const unpacked = path.join(userData, 'versions', '9.9.9', 'app.asar.unpacked');
  check('the download brings the native voice files along', fs.existsSync(unpacked));
  // Simulate a copy updated by 1.3.1, which did not copy them: remove them.
  fs.rmSync(unpacked, { recursive: true, force: true });

  // 2) next start runs it (and repairs the missing native files itself)
  const b = lines(await run('updater-b.js'));
  check('next start runs v9.9.9 from the versions folder', b.includes('version 9.9.9 fromUpdate true'), b.join(' | '));
  check('a copy missing them repairs itself on start', fs.existsSync(unpacked));
  check('the updated copy can load Discord\'s native voice module', b.some((l) => /^natives ok/.test(l)), b.find((l) => /^natives/.test(l)));
  const st = JSON.parse(fs.readFileSync(path.join(userData, 'versions', 'state.json'), 'utf8'));
  check('the new version confirmed it started fine', (st.good || []).includes('9.9.9') && !st.trying, JSON.stringify(st));

  // 3) a damaged update is skipped
  const bad = path.join(userData, 'versions', '9.9.10');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'app.asar'), 'not an asar file');
  fs.writeFileSync(path.join(bad, 'info.json'), JSON.stringify({ version: '9.9.10', shell: process.env.WL_DEV ? electronVersion : SHELL }));
  const c = lines(await run('updater-b.js'));
  const st2 = JSON.parse(fs.readFileSync(path.join(userData, 'versions', 'state.json'), 'utf8'));
  check('a damaged update falls back without an error', c.some((l) => /^version 9\.9\.9 /.test(l) || /^version 1\./.test(l)), c.join(' | '));
  check('…and is never tried again', (st2.bad || []).includes('9.9.10'), JSON.stringify(st2));

  server.close();
  fs.rmSync(userData, { recursive: true, force: true });
  console.log(ok ? 'UPDATER PASS' : 'UPDATER FAIL');
  process.exit(ok ? 0 : 1);
});
