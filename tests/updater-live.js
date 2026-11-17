// Live check: does a 1.1.0 install find and download the newest GitHub release?
// (Uses a temp folder; touches nothing installed.)
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createUpdater } = require('../src/main/updater');
module.exports = async (ctx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-live-upd-'));
  const store = { d: {}, get(k) { return this.d[k]; }, set(p) { Object.assign(this.d, p); } };
  const u = createUpdater({ app: ctx.app, settings: store, send: () => {}, current: process.env.LIVE_FROM || '1.1.0', shell: process.versions.electron, repo: 'OrionVW42/wavelength', versionsDir: dir, quit: () => {} });
  const t0 = Date.now();
  await u.run();
  const s = u.status();
  console.log(`LIVE phase=${s.phase} ready=${JSON.stringify(s.ready)} error=${s.error} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const f = s.ready && s.ready.kind === 'app' && path.join(dir, s.ready.version, 'app.asar');
  console.log('LIVE file', f ? `${(require('original-fs').statSync(f).size / 1e6).toFixed(1)} MB verified` : 'none');
  fs.rmSync(dir, { recursive: true, force: true });
  return !!(s.ready && s.ready.version === (process.env.LIVE_EXPECT || s.ready.version));
};
