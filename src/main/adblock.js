// Network-level ad/tracker blocking (Ghostery engine, cached on disk).
// In-player YouTube ads are handled separately by the bridge (response
// pruning + skip fallback); this layer drops ad/tracking requests.
const fs = require('fs');
const path = require('path');

let blocker = null;
let enabledOn = null;

async function enableAdblock(ses, cacheDir) {
  if (blocker) { if (!enabledOn) { blocker.enableBlockingInSession(ses); enabledOn = ses; } return true; }
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  const cache = path.join(cacheDir, 'adblock-engine.bin');
  // Refresh the cached lists every 3 days.
  try {
    const age = Date.now() - fs.statSync(cache).mtimeMs;
    if (age > 3 * 24 * 3600e3) fs.rmSync(cache, { force: true });
  } catch { /* no cache yet */ }
  blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
    path: cache,
    read: fs.promises.readFile,
    write: fs.promises.writeFile,
  });
  // Cosmetic filtering injects its own preload + scriptlets into YouTube,
  // which fights our player bridge. Network blocking only.
  blocker.config.loadCosmeticFilters = false;
  blocker.enableBlockingInSession(ses);
  enabledOn = ses;
  return true;
}

function disableAdblock() {
  if (blocker && enabledOn) {
    try { blocker.disableBlockingInSession(enabledOn); } catch { /* already off */ }
    enabledOn = null;
  }
}

module.exports = { enableAdblock, disableAdblock };
