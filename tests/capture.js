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
  ctx.handleAction('volume', 9); await sleep(1500);
  console.log('CAP enable ->', await ctx.runInYtm('window.__wl.cmd.capture(true)'));
  console.log('CAP element', await ctx.runInYtm("(() => { const v = document.querySelector('#movie_player video'); const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume'); return JSON.stringify({ reported: v.volume, real: d.get.call(v), own: Object.getOwnPropertyNames(v).includes('volume'), vids: document.querySelectorAll('video').length }); })()"));
  await sleep(4000); bytes = 0; rms();
  await sleep(5000);
  console.log(`CAP 5s: ${(bytes / 1024).toFixed(0)} KB (expect ~${(48000 * 4 * 5 / 1024).toFixed(0)}), rms ${rms()} at volume ${ctx.getPlayerState().volume}`);
  console.log('CAP element after', await ctx.runInYtm("(() => { const v = document.querySelector('#movie_player video'); const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume'); return JSON.stringify({ reported: v.volume, real: d.get.call(v) }); })()"));
  ctx.handleAction('volume', 20); await sleep(1500); rms();
  await sleep(3000);
  console.log(`CAP at volume 20: rms ${rms()}`);
  // The live bug: capture already on, then a NEW song loads at a low volume.
  ctx.handleAction('volume', 5); await sleep(1000);
  const song2 = (await ctx.ytmCall('search', 'middle class rut aunt betty')).find((x) => x.kind === 'Song');
  await ctx.playerCmd('load', song2.videoId);
  await waitFor(() => { const st = ctx.getPlayerState(); return st.playing && !st.ad && st.videoId === song2.videoId; }, 150000);
  await sleep(25000); rms(); await sleep(6000);
  console.log(`CAP new song at volume 5: rms ${rms()} (real element volume ${await ctx.runInYtm("Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume').get.call(document.querySelector('#movie_player video'))")})`);
  await ctx.runInYtm("document.querySelector('#movie_player').mute(); 0"); await sleep(1500); rms(); await sleep(3000);
  console.log(`CAP muted in Wavelength: rms ${rms()} (speakers muted: ${await ctx.runInYtm('window.__wl.cmd.state().tap && window.__wl.cmd.state().tap.local')})`);
  await ctx.runInYtm("document.querySelector('#movie_player').unMute(); 0"); await sleep(800);
  ctx.handleAction('toggle'); await sleep(1500); rms(); bytes = 0;
  await sleep(2000);
  console.log(`CAP paused: ${(bytes / 1024).toFixed(0)} KB, rms ${rms()}`);
  ctx.handleAction('toggle');
  await sleep(2000);
  const st = ctx.getPlayerState();
  console.log(`CAP local playback still fine: playing=${st.playing} pos=${st.position.toFixed(1)}`);
  return true;
};
