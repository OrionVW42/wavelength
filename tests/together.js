// Runs two Wavelength instances (separate profiles) against the real PeerJS
// server and YouTube Music: one hosts a room, the other joins it.
//   node tests/together.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const root = path.join(__dirname, '..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-together-'));
const sharedDir = path.join(base, 'shared');
fs.mkdirSync(sharedDir);

function run(role) {
  return new Promise((resolve) => {
    const p = spawn(electron, ['.'], {
      cwd: root,
      env: { ...process.env, WL_TEST_SCRIPT: `tests/together-${role}.js`, WL_USERDATA: path.join(base, role), WL_SHARED: sharedDir },
    });
    let pass = false;
    const onData = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (/^(ok|FAIL)/.test(line)) console.log(line);
        if (/WLTEST PASS/.test(line)) pass = true;
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const kill = setTimeout(() => { console.log(`[${role}] timed out`); p.kill(); }, 15 * 60 * 1000);
    p.on('exit', () => { clearTimeout(kill); resolve(pass); });
  });
}

(async () => {
  const [h, g] = await Promise.all([run('host'), run('guest')]);
  console.log(h && g ? 'TOGETHER PASS' : `TOGETHER FAIL (host ${h}, guest ${g})`);
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(h && g ? 0 : 1);
})();
