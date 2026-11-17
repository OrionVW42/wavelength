// Produces the screenshots for the website: runs two real Wavelength
// instances (host "Maya", guest "Alex") in a real room over the public server.
//   node tools/showcase.js <outDir>
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const root = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'docs', 'media', 'raw'));
fs.mkdirSync(out, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-showcase-'));
const shared = path.join(base, 'shared');
fs.mkdirSync(shared);

function run(role) {
  return new Promise((resolve) => {
    const p = spawn(electron, ['.'], {
      cwd: root,
      env: { ...process.env, WL_TEST_SCRIPT: path.join(__dirname, `showcase-${role}.js`), WL_USERDATA: path.join(base, role), WL_SHARED: shared, WL_SHOTS: out },
    });
    let pass = false;
    const onData = (d) => String(d).split(/\r?\n/).forEach((l) => { if (/^(shot|step|FAIL)/.test(l)) console.log(`[${role}] ${l}`); if (/WLTEST PASS/.test(l)) pass = true; });
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    const kill = setTimeout(() => p.kill(), 12 * 60 * 1000);
    p.on('exit', () => { clearTimeout(kill); resolve(pass); });
  });
}
(async () => {
  const [h, g] = await Promise.all([run('host'), run('guest')]);
  fs.rmSync(base, { recursive: true, force: true });
  console.log(h && g ? 'SHOWCASE DONE' : `SHOWCASE FAILED (host ${h}, guest ${g})`);
  process.exit(h && g ? 0 : 1);
})();
