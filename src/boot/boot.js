// Launcher: the only code that always runs from the installed copy.
// It picks the newest downloaded app version that fits this Electron build
// (versions/<v>/app.asar, verified on download) and runs it; otherwise it
// runs the installed app. A version that crashes before confirming it
// started fine is never tried again.
const { app } = require('electron');
const path = require('path');
const fs = require('original-fs');

if (process.env.WL_USERDATA) app.setPath('userData', process.env.WL_USERDATA);
const builtin = app.getVersion();
const dir = path.join(app.getPath('userData'), 'versions');
const stateFile = path.join(dir, 'state.json');

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { bad: [], good: [] }; } };
const writeState = (s) => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); } catch { /* read-only */ } };

function pick() {
  if (process.env.WL_NO_BOOT_UPDATES) return null;
  const state = readState();
  state.bad = state.bad || []; state.good = state.good || [];
  // Last start tried a version that never confirmed itself: it's bad.
  if (state.trying && !state.good.includes(state.trying)) { state.bad.push(state.trying); state.trying = null; writeState(state); }
  let best = null;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const v of names) {
    if (!/^\d+\.\d+\.\d+$/.test(v) || state.bad.includes(v) || !newer(v, builtin)) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(dir, v, 'info.json'), 'utf8'));
      if (info.shell !== process.versions.electron) continue;
      if (!fs.statSync(path.join(dir, v, 'app.asar')).isFile()) continue;
      if (!best || newer(v, best)) best = v;
    } catch { /* incomplete download */ }
  }
  if (best && !state.good.includes(best)) { state.trying = best; writeState(state); }
  return best;
}

function launch(chosen) {
  const root = chosen ? path.join(dir, chosen, 'app.asar') : path.join(__dirname, '..', '..');
  global.__wlBoot = {
    version: chosen || builtin, builtin, root, versionsDir: dir, fromUpdate: !!chosen,
    // Called by the app once it has started properly.
    confirm() {
      if (!chosen) return;
      const s = readState(); s.good = [...new Set([...(s.good || []), chosen])]; s.trying = null; writeState(s);
    },
  };
  require(path.join(root, 'src', 'main', 'main.js'));
}

const chosen = pick();
try {
  launch(chosen);
} catch (e) {
  if (!chosen) throw e;
  // The downloaded version wouldn't even load: never try it again and run
  // the installed one instead.
  const s = readState(); s.bad = [...new Set([...(s.bad || []), chosen])]; s.trying = null; writeState(s);
  console.error('[boot] update', chosen, 'failed to load, using', builtin, '-', e.message);
  launch(null);
}
