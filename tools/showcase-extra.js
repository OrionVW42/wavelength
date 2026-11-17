// Single-instance shots: mini player (short title) and settings.
const { sleep, waitFor, shell, ready, shot, shotMini, setup } = require('./showcase-util');

module.exports = async (ctx) => {
  await ready(ctx);
  await setup(ctx, 'Maya', '#ff4d6d', 20);
  const song = (await ctx.ytmCall('search', 'dua lipa levitating')).find((s) => s.kind === 'Song');
  await shell(ctx, `window.__session.do('add', { items: [${JSON.stringify(song)}], where: 'end' })`);
  await waitFor(() => { const s = ctx.getPlayerState(); return s.playing && !s.ad && s.videoId === song.videoId; }, 150000);
  await sleep(14000);
  ctx.settings.set({ miniMode: 'always' });
  ctx.handleAction('toggleMini'); await sleep(300);
  if (!ctx.miniWin.isVisible()) ctx.handleAction('toggleMini');
  await sleep(2500);
  await shotMini(ctx, 'mini.png');
  ctx.miniWin.hide();

  await shell(ctx, "document.querySelector('#btn-settings').click(); 0");
  await sleep(1500);
  // Show hotkeys in their normal state (other app copies on this PC hold them during capture).
  await ctx.mainWin.webContents.executeJavaScript(`window.wl.getSettings().then((s) => { s.hotkeyStatus = {}; s.miniMode = 'playing';
    renderSettings(document.querySelector('#settings'), s, window.wl, { onSaved() {}, toast() {} }); return 0; })`);
  await sleep(800);
  await shell(ctx, "document.querySelector('#settings').scrollTop = [...document.querySelectorAll('#settings h2')][1].offsetTop - 24; 0");
  await sleep(600);
  await shot(ctx, 'settings.png');
  return true;
};
