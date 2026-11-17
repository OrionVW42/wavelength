// Screenshots of the 1.1 additions (single instance).
const { sleep, waitFor, shell, ready, shot, shotMini, setup } = require('./showcase-util');
const fs = require('fs');
const path = require('path');

module.exports = async (ctx) => {
  await ready(ctx);
  await setup(ctx, 'Maya', '#ff4d6d', 20);
  ctx.settings.set({ dataSaver: true });
  const pick = async (q) => (await ctx.ytmCall('search', q)).find((s) => s.kind === 'Song');
  const items = [await pick('daft punk get lucky'), await pick('tame impala the less i know the better'), await pick('dua lipa levitating'), await pick('fleetwood mac dreams')];
  await shell(ctx, `window.__session.do('add', { items: ${JSON.stringify(items)}, where: 'end' })`);
  await waitFor(() => { const s = ctx.getPlayerState(); return s.playing && !s.ad; }, 150000);
  await sleep(6000);
  await shot(ctx, 'v11-player.png');
  await shell(ctx, "(() => { const i = document.querySelector('#add-input'); i.value = 'the weeknd'; i.dispatchEvent(new Event('input')); i.focus(); return 0; })()");
  await waitFor(() => shell(ctx, "document.querySelectorAll('#results .track[data-vid]').length > 4"), 20000);
  await sleep(2500);
  await shot(ctx, 'v11-search.png');
  await shell(ctx, "document.querySelector('#results-close').click(); 0");
  // mini: bar + search
  ctx.settings.set({ miniMode: 'always' });
  ctx.handleAction('toggleMini'); await sleep(300);
  if (!ctx.miniWin.isVisible()) ctx.handleAction('toggleMini');
  await sleep(1500);
  await ctx.miniWin.webContents.executeJavaScript("document.querySelector('.handle .pill').style.opacity = 1; document.querySelector('.grip').style.opacity = .8; 0");
  await shotMini(ctx, 'v11-mini.png');
  ctx.handleAction('miniSearch'); await sleep(500);
  await ctx.miniWin.webContents.executeJavaScript("(() => { const i = document.querySelector('#s-q'); i.value = 'arctic monkeys'; i.dispatchEvent(new Event('input')); return 0; })()");
  await waitFor(() => ctx.miniWin.webContents.executeJavaScript("document.querySelectorAll('.s-row').length === 2"), 20000);
  await sleep(1500);
  await shotMini(ctx, 'v11-mini-search.png');
  await ctx.miniWin.webContents.executeJavaScript("document.querySelector('.s-row').click(); 0");
  await sleep(900);
  await shotMini(ctx, 'v11-mini-added.png');
  // settings top (updates) and hotkeys
  await shell(ctx, "document.querySelector('#btn-settings').click(); 0");
  await sleep(1500);
  await ctx.mainWin.webContents.executeJavaScript("window.wl.getSettings().then((s) => { s.hotkeyStatus = {}; renderSettings(document.querySelector('#settings'), s, window.wl, { onSaved() {}, toast() {} }); return 0; })");
  await sleep(1200);
  await shot(ctx, 'v11-settings-top.png');
  await shell(ctx, "document.querySelector('#settings').scrollTop = [...document.querySelectorAll('#settings h2')][4].offsetTop - 24; 0");
  await sleep(600);
  await shot(ctx, 'v11-settings-hotkeys.png');
  return true;
};
