const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30000, step = 300) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(step); }
  return null;
}
const shared = (n) => path.join(process.env.WL_SHARED, n);
const put = (n, v) => fs.writeFileSync(shared(n), JSON.stringify(v));
const get = (n) => { try { return JSON.parse(fs.readFileSync(shared(n), 'utf8')); } catch { return null; } };
const shell = (ctx, code) => ctx.mainWin.webContents.executeJavaScript(code, true);
const ready = (ctx) => waitFor(() => ctx.runInYtm('!!(window.__wl && window.ytcfg)'), 60000, 400);

// Shell window + the YouTube Music view composited into one PNG.
async function shot(ctx, name) {
  const shellImg = await ctx.mainWin.webContents.capturePage();
  const { width, height } = shellImg.getSize();
  const sb = shellImg.toBitmap();
  if (ctx.ytmView.getVisible()) {
    const y = await ctx.ytmView.webContents.capturePage();
    const yb = y.toBitmap(), ys = y.getSize(), b = ctx.ytmView.getBounds();
    const sf = width / ctx.mainWin.getContentSize()[0];
    const ox = Math.round(b.x * sf), oy = Math.round(b.y * sf), w = Math.min(ys.width, width - ox);
    for (let r = 0; r < ys.height && oy + r < height; r++) yb.copy(sb, ((oy + r) * width + ox) * 4, r * ys.width * 4, (r * ys.width + w) * 4);
  }
  fs.writeFileSync(path.join(process.env.WL_SHOTS, name), nativeImage.createFromBitmap(sb, { width, height }).toPNG());
  console.log('shot ' + name);
}
async function shotMini(ctx, name) {
  fs.writeFileSync(path.join(process.env.WL_SHOTS, name), (await ctx.miniWin.webContents.capturePage()).toPNG());
  console.log('shot ' + name);
}
async function setup(ctx, name, color, x) {
  ctx.settings.set({ name, color, miniMode: 'never' });
  await shell(ctx, `window.__session.me.name = ${JSON.stringify(name)}; window.__session.me.color = ${JSON.stringify(color)}; 0`);
  ctx.mainWin.setContentSize(1440, 900);
  ctx.mainWin.setPosition(x, 40);
  ctx.mainWin.show();
}
module.exports = { sleep, waitFor, put, get, shell, ready, shot, shotMini, setup };
