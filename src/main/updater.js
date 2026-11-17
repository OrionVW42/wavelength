// Auto-updater (same idea as HomeCable's):
//  - asks GitHub for the latest release (plain request, nothing identifying)
//  - downloads just the app file (a few MB) when the Electron build matches,
//    or the full installer when Electron itself changed
//  - verifies the app file's SHA-256, then "Restart to update" runs it
// The launcher (src/boot/boot.js) picks the newest verified version at start.
const path = require('path');
const fs = require('original-fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EVERY = 6 * 3600e3;

function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

function createUpdater({ app, settings, send, current, repo, versionsDir, quit }) {
  const api = (process.env.WL_UPDATE_API || 'https://api.github.com').replace(/\/$/, '');
  const headers = { 'User-Agent': 'Wavelength-Updater', Accept: 'application/vnd.github+json' };
  const state = { phase: 'idle', version: null, kind: null, pct: 0, error: null, notes: '', lastCheck: settings.get('lastUpdateCheck') || 0 };
  let running = null;

  const status = () => ({ ...state, current, ready: readyInfo() });
  const emit = () => send(status());

  function readyInfo() {
    let bad = [];
    try { bad = JSON.parse(fs.readFileSync(path.join(versionsDir, 'state.json'), 'utf8')).bad || []; } catch { /* no launcher state yet */ }
    let names = [];
    try { names = fs.readdirSync(versionsDir); } catch { /* nothing downloaded */ }
    for (const v of names.filter((x) => /^\d+\.\d+\.\d+$/.test(x)).sort((a, b) => (newer(a, b) ? -1 : 1))) {
      if (!newer(v, current) || bad.includes(v)) continue;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(versionsDir, v, 'info.json'), 'utf8'));
        if (info.shell === process.versions.electron && fs.existsSync(path.join(versionsDir, v, 'app.asar'))) return { version: v, kind: 'app', notes: info.notes || '' };
      } catch { /* incomplete */ }
    }
    try {
      const p = JSON.parse(fs.readFileSync(path.join(versionsDir, 'installer.json'), 'utf8'));
      if (newer(p.version, current) && fs.existsSync(p.file)) return { version: p.version, kind: 'installer', notes: p.notes || '' };
    } catch { /* none */ }
    return null;
  }

  async function getJson(url) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return r.json();
  }
  async function download(url, file, size, onPct) {
    const r = await fetch(url, { headers: { 'User-Agent': headers['User-Agent'], Accept: 'application/octet-stream' } });
    if (!r.ok || !r.body) throw new Error(`Download failed (${r.status})`);
    const total = +r.headers.get('content-length') || size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(file + '.part');
    let got = 0;
    const reader = r.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value); got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
        if (total) onPct(got / total);
      }
    } finally { await new Promise((res) => out.end(res)); }
    fs.renameSync(file + '.part', file);
    return hash.digest('hex');
  }

  async function check() {
    state.phase = 'checking'; state.error = null; emit();
    const rel = await getJson(`${api}/repos/${repo}/releases/latest`);
    state.lastCheck = Date.now(); settings.set({ lastUpdateCheck: state.lastCheck });
    const asset = (n) => (rel.assets || []).find((a) => a.name === n);
    const man = asset('wavelength-update.json');
    if (!man) { state.phase = 'uptodate'; emit(); return null; }
    const m = await getJson(man.browser_download_url);
    if (!newer(m.version, current)) { state.phase = 'uptodate'; emit(); return null; }
    state.version = m.version; state.notes = String(rel.body || '').slice(0, 4000);
    return { m, asset };
  }

  async function fetchUpdate({ m, asset }) {
    const r = readyInfo();
    if (r && !newer(m.version, r.version)) { state.phase = 'ready'; state.kind = r.kind; emit(); return; }
    fs.mkdirSync(versionsDir, { recursive: true });
    const onPct = (p) => { state.pct = p; emit(); };
    if (m.shell === process.versions.electron && m.app && asset(m.app.name)) {
      state.kind = 'app'; state.phase = 'downloading'; state.pct = 0; emit();
      const vdir = path.join(versionsDir, m.version);
      fs.mkdirSync(vdir, { recursive: true });
      const file = path.join(vdir, 'app.asar');
      const sha = await download(asset(m.app.name).browser_download_url, file, m.app.size, onPct);
      if (sha !== m.app.sha256) { fs.rmSync(vdir, { recursive: true, force: true }); throw new Error('The download was damaged. It will retry later.'); }
      fs.writeFileSync(path.join(vdir, 'info.json'), JSON.stringify({ version: m.version, shell: m.shell, sha256: sha, notes: state.notes }, null, 2));
    } else if (m.setup && asset(m.setup.name)) {
      state.kind = 'installer'; state.phase = 'downloading'; state.pct = 0; emit();
      const file = path.join(versionsDir, m.setup.name);
      await download(asset(m.setup.name).browser_download_url, file, m.setup.size, onPct);
      fs.writeFileSync(path.join(versionsDir, 'installer.json'), JSON.stringify({ version: m.version, file, notes: state.notes }));
    } else { state.phase = 'uptodate'; emit(); return; }
    state.phase = 'ready'; state.pct = 1; emit();
  }

  function run() {
    if (running) return running;
    running = (async () => {
      try {
        const found = await check();
        if (found) await fetchUpdate(found);
        else if (readyInfo()) { state.phase = 'ready'; emit(); }
      } catch (e) {
        state.phase = 'error'; state.error = e.message || String(e); emit();
      } finally { running = null; }
    })();
    return running;
  }

  // Restart into the new version.
  function apply() {
    const r = readyInfo();
    if (!r) return { ok: false };
    if (r.kind === 'installer') {
      const p = JSON.parse(fs.readFileSync(path.join(versionsDir, 'installer.json'), 'utf8'));
      spawn(p.file, [], { detached: true, stdio: 'ignore' }).unref();
      quit(false);
    } else {
      quit(true);
    }
    return { ok: true, version: r.version };
  }

  // Keep the versions folder small: current + newest only.
  function cleanup() {
    try {
      const keep = new Set([current, readyInfo()?.version].filter(Boolean));
      for (const v of fs.readdirSync(versionsDir)) {
        if (/^\d+\.\d+\.\d+$/.test(v) && !keep.has(v) && !newer(v, current)) fs.rmSync(path.join(versionsDir, v), { recursive: true, force: true });
      }
      const inst = path.join(versionsDir, 'installer.json');
      if (fs.existsSync(inst)) { const p = JSON.parse(fs.readFileSync(inst, 'utf8')); if (!newer(p.version, current)) { fs.rmSync(p.file, { force: true }); fs.rmSync(inst, { force: true }); } }
    } catch { /* nothing to clean */ }
  }

  function schedule() {
    cleanup();
    if (readyInfo()) { state.phase = 'ready'; state.version = readyInfo().version; state.kind = readyInfo().kind; }
    const tick = () => { if (settings.get('autoUpdate') !== false && Date.now() - (settings.get('lastUpdateCheck') || 0) > EVERY) run(); };
    setTimeout(() => { if (settings.get('autoUpdate') !== false) run(); }, 12000);
    setInterval(tick, 30 * 60e3);
  }

  return { run, apply, status, schedule };
}

module.exports = { createUpdater, newer };
