// The ad blocker and the audio-worklet allowance share one header hook:
// both must work together, also after turning the ad blocker off and on.
const { ready, sleep, waitFor, checker } = require('./util');
module.exports = async (ctx) => {
  const check = checker('hooks');
  await ready(ctx);
  const probe = () => ctx.runInYtm(`(async () => {
    const out = {};
    try { await fetch('https://www.youtube.com/api/stats/ads?ver=2&ns=1&event=2', { mode: 'no-cors', credentials: 'omit' }); out.ad = 'loaded'; } catch { out.ad = 'blocked'; }
    try { await fetch('https://www.youtube.com/generate_204', { mode: 'no-cors', credentials: 'omit' }); out.control = 'loaded'; } catch { out.control = 'blocked'; }
    const a = new AudioContext();
    try { const u = URL.createObjectURL(new Blob(["registerProcessor('p" + Math.random().toString(36).slice(2) + "', class extends AudioWorkletProcessor { process() { return true; } });"], { type: 'application/javascript' })); await a.audioWorklet.addModule(u); out.worklet = 'ok'; } catch (e) { out.worklet = 'FAIL'; }
    a.close();
    return out;
  })()`);
  await sleep(3000); // ad lists load
  let r = await waitFor(async () => { const x = await probe(); return x.ad === 'blocked' ? x : null; }, 30000, 2000) || await probe();
  check('ad blocker blocks ad servers', r.ad === 'blocked', JSON.stringify(r));
  check('audio worklet loads', r.worklet === 'ok');
  await ctx.mainWin.webContents.executeJavaScript('window.wl.setSettings({ adblock: false }).then(() => 0)');
  ctx.ytmView.webContents.reload(); await sleep(6000); await ready(ctx);
  r = await probe();
  check('ad blocker off: ads not blocked, worklet still loads', r.ad === 'loaded' && r.worklet === 'ok', JSON.stringify(r));
  await ctx.mainWin.webContents.executeJavaScript('window.wl.setSettings({ adblock: true }).then(() => 0)');
  ctx.ytmView.webContents.reload(); await sleep(6000); await ready(ctx);
  r = await probe();
  check('ad blocker back on: both work', r.ad === 'blocked' && r.worklet === 'ok', JSON.stringify(r));
  return check.all();
};
