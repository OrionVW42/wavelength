// Wavelength for Android: runs at the start of every music.youtube.com page in
// the hidden "engine" view, before YouTube Music and before bridge.js.
(() => {
  if (window.__wlEngine) return;
  window.__wlEngine = true;
  const post = (o) => { try { WLEngine.postMessage(JSON.stringify(o)); } catch (e) { /* not ready */ } };

  // 1) Keep playing in the background / with the screen off: the page is
  //    always told it's visible (YouTube pauses hidden pages).
  try {
    const def = (k, v) => Object.defineProperty(Document.prototype, k, { configurable: true, get: () => v });
    def('hidden', false); def('visibilityState', 'visible');
    def('webkitHidden', false); def('webkitVisibilityState', 'visible');
    Document.prototype.hasFocus = function () { return true; };
  } catch (e) { post({ t: 'log', msg: 'visibility patch failed: ' + e }); }
  const swallow = (e) => { if (e.target === window || e.target === document) e.stopImmediatePropagation(); };
  for (const ev of ['visibilitychange', 'webkitvisibilitychange', 'blur', 'freeze', 'pagehide']) window.addEventListener(ev, swallow, true);

  // 2) Keep the page's own timers running in the background. Android may
  //    slow a background page's timers to once a minute; the app calls
  //    __wlPump() every second while in the background, which runs any
  //    interval that is overdue (never twice).
  const timers = new Map();
  let tid = 0;
  const origSI = window.setInterval.bind(window), origCI = window.clearInterval.bind(window);
  window.setInterval = function (fn, delay, ...args) {
    if (typeof fn !== 'function') return origSI(fn, delay, ...args);
    const d = Math.max(4, +delay || 0);
    const rec = { fn, args, d, last: Date.now() };
    const run = () => { rec.last = Date.now(); try { fn(...args); } catch (e) { setTimeout(() => { throw e; }); } };
    rec.run = run;
    const real = origSI(run, delay);
    if (d <= 10000) timers.set(real, rec);
    return real;
  };
  window.clearInterval = function (id) { timers.delete(id); return origCI(id); };
  window.__wlPump = () => {
    const now = Date.now();
    for (const rec of timers.values()) if (now - rec.last >= rec.d * 1.5) rec.run();
  };

  // 3) bridge.js talks with window.postMessage; forward it to the app.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source === window && d && d.__wlBridge === 1 && typeof d.type === 'string' && d.type !== 'pcm') post({ t: 'bridge', type: d.type, data: d.data });
  });

  // 4) Calls from the app's UI: __wlRpc(id, 'api'|'cmd', name, args).
  const ready = async (needCfg) => {
    for (let i = 0; i < 100; i++) {
      if (window.__wl && (!needCfg || window.ytcfg)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('YouTube Music is still loading');
  };
  window.__wlRpc = async (id, kind, fn, args) => {
    try {
      await ready(kind === 'api');
      const target = kind === 'api' ? window.__wl.api : window.__wl.cmd;
      if (typeof target[fn] !== 'function') throw new Error('unknown ' + kind + ' ' + fn);
      const v = await target[fn](...(args || []));
      if (id) post({ t: 'rpc', id, ok: true, v: v === undefined ? null : v });
    } catch (e) {
      if (id) post({ t: 'rpc', id, ok: false, e: String((e && e.message) || e) });
    }
  };

  // 5) "Show video": make the player fill the (small) engine view.
  // The player page is moved with a transform, which traps position:fixed
  // children, so the page itself is pinned first.
  const css = `
    html.wl-vo, html.wl-vo body { background: #000 !important; overflow: hidden !important; }
    html.wl-vo ytmusic-nav-bar, html.wl-vo ytmusic-player-bar, html.wl-vo #side-panel, html.wl-vo .side-panel,
    html.wl-vo #guide-wrapper, html.wl-vo tp-yt-app-drawer { visibility: hidden !important; }
    html.wl-vo ytmusic-player-page, html.wl-vo #player-page {
      transform: none !important; position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
      margin: 0 !important; padding: 0 !important; z-index: 2147483646 !important; background: #000 !important; visibility: visible !important; }
    html.wl-vo ytmusic-player-page #main-panel, html.wl-vo ytmusic-player-page .content {
      position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; max-width: none !important;
      margin: 0 !important; padding: 0 !important; }
    html.wl-vo ytmusic-player#player, html.wl-vo ytmusic-player {
      position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
      max-width: none !important; max-height: none !important; margin: 0 !important; z-index: 2147483647 !important; background: #000 !important; visibility: visible !important; }
    html.wl-vo ytmusic-player .html5-video-player, html.wl-vo ytmusic-player #movie_player { width: 100% !important; height: 100% !important; }
    html.wl-vo ytmusic-player video { width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; object-fit: contain !important; }
    html.wl-vo #wl-art, html.wl-vo .ytp-chrome-top, html.wl-vo .ytp-chrome-bottom, html.wl-vo .ytp-gradient-bottom, html.wl-vo .ytp-gradient-top { display: none !important; }`;
  window.__wlVideoOnly = (on) => {
    if (!document.getElementById('wl-vo-style')) {
      const s = document.createElement('style'); s.id = 'wl-vo-style'; s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
    }
    document.documentElement.classList.toggle('wl-vo', !!on);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 400);
  };
  post({ t: 'log', msg: 'engine ready on ' + location.pathname });
  post({ t: 'ready' });
})();
