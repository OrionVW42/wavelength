// The Discord audio tap: does real player audio reach the main process,
// and does it follow YouTube Music's volume?
const { sleep, waitFor, ready } = require('./util');
module.exports = async (ctx) => {
  await ready(ctx);
  let bytes = 0, sumSq = 0, n = 0;
  ctx.pcmSinks.add((buf) => {
    bytes += buf.length;
    for (let i = 0; i + 1 < buf.length; i += 8) { const s = buf.readInt16LE(i); sumSq += s * s; n++; }
  });
  const rms = () => { const r = n ? Math.sqrt(sumSq / n) : 0; sumSq = 0; n = 0; return Math.round(r); };
  const song = (await ctx.ytmCall('search', 'daft punk get lucky')).find((s) => s.kind === 'Song');
  await ctx.playerCmd('load', song.videoId);
  await waitFor(() => { const s = ctx.getPlayerState(); return s.playing && !s.ad; }, 150000);
  console.log('CAP enable ->', await ctx.runInYtm('window.__wl.cmd.capture(true)'));
  await sleep(4000); bytes = 0; rms();
  await sleep(5000);
  console.log(`CAP 5s: ${(bytes / 1024).toFixed(0)} KB (expect ~${(48000 * 4 * 5 / 1024).toFixed(0)}), rms ${rms()} at volume ${ctx.getPlayerState().volume}`);
  ctx.handleAction('volume', 20); await sleep(1500); rms();
  await sleep(3000);
  console.log(`CAP at volume 20: rms ${rms()}`);
  ctx.handleAction('toggle'); await sleep(1500); rms(); bytes = 0;
  await sleep(2000);
  console.log(`CAP paused: ${(bytes / 1024).toFixed(0)} KB, rms ${rms()}`);
  ctx.handleAction('toggle');
  await sleep(2000);
  const st = ctx.getPlayerState();
  console.log(`CAP local playback still fine: playing=${st.playing} pos=${st.position.toFixed(1)}`);
  return true;
};
