// Preload for the embedded YouTube Music view (sandboxed, context-isolated).
// Injects the player bridge into the page's main world at document start and
// relays its messages to the main process. The page itself gets no Node/IPC.
const { ipcRenderer, webFrame } = require('electron');

const host = location.hostname;

if (host === 'music.youtube.com') {
  const { code, cfg } = ipcRenderer.sendSync('wl:bridge');
  webFrame.executeJavaScript(`window.__wlCfg=${JSON.stringify(cfg)};\n${code}`);
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.__wlBridge === 1 && typeof d.type === 'string') ipcRenderer.send('ytm:msg', d.type, d.data);
  });
} else if (host === 'accounts.google.com') {
  // Google's sign-in page refuses embedded Chromium builds. Present a
  // consistent desktop-Firefox identity on this one domain (the HTTP headers
  // are rewritten to match in the main process).
  const compat = ipcRenderer.sendSync('wl:signin-compat');
  if (compat) {
    webFrame.executeJavaScript(`(() => {
      const ua = ${JSON.stringify(compat)};
      const def = (k, v) => { try { Object.defineProperty(Navigator.prototype, k, { get: () => v, configurable: true }); } catch {} };
      def('userAgent', ua); def('appVersion', ua.replace(/^Mozilla\\//, ''));
      def('vendor', ''); def('platform', 'Win32'); def('userAgentData', undefined);
    })()`);
  }
}
