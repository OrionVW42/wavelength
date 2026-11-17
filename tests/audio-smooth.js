// Does the bot's audio stay smooth when the app is busy?
// Plays a real song through the audio tap and feeds two simulated Discord
// players that read 20 ms frames on Discord's clock:
//   A) through the new AudioFeeder (cushion + refill)
//   B) the old way (written straight through)
// while the YouTube Music page and the main process are made busy on purpose.
// Counts "missed frames" (= audible skips) for each, and audio lost in capture.
const { PassThrough } = require('stream');
const { sleep, waitFor, ready, checker } = require('./util');
const { AudioFeeder } = require('../src/main/discord');

function fakeDiscord() {
  const stream = new PassThrough({ highWaterMark: 48000 * 4 * 3 });
  const resource = { playbackDuration: 0 };
  const player = { state: { status: 'playing', missedFrames: 0 } };
  const r = { stream, resource, player, misses: 0, started: false, counting: false, stop: false };
  const t0 = Date.now(); let frames = 0;
  const cycle = () => {
    if (r.stop) return;
    frames++;
    const chunk = stream.read(3840);
    if (chunk) { resource.playbackDuration += 20; player.state.missedFrames = 0; r.started = true; } else if (r.started) { player.state.missedFrames++; if (r.counting) r.misses++; }
    setTimeout(cycle, Math.max(0, t0 + frames * 20 - Date.now()));
  };
  setTimeout(cycle, 20);
  return r;
}

module.exports = async (ctx) => {
  const check = checker('audio');
  await ready(ctx);
  const song = (await ctx.ytmCall('search', 'daft punk get lucky')).find((s) => s.kind === 'Song');
  await ctx.playerCmd('load', song.videoId);
  await waitFor(() => { const s = ctx.getPlayerState(); return s.playing && !s.ad; }, 150000);
  ctx.handleAction('volume', 0); // quiet test
  await ctx.runInYtm('window.__wl.cmd.capture(true)');
  const mode = await waitFor(() => ctx.runInYtm('(window.__wl.cmd.state().tap || {}).mode').then((m) => (m && m !== 'starting' ? m : null)), 10000);
  check('captures on the audio thread (worklet)', mode === 'worklet', mode);

  const A = fakeDiscord(), B = fakeDiscord();
  const feeder = new AudioFeeder();
  feeder.attach(A.stream, A.resource, A.player);
  const tick = setInterval(() => feeder.tick(), 20);
  let bytes = 0;
  const sink = (buf) => {
    bytes += buf.length;
    feeder.push(buf);
    if (B.stream.writableLength < 48000 * 4) B.stream.write(buf); // old: drop if >1s queued
  };
  ctx.pcmSinks.add(sink);

  await sleep(4000); // warm up
  A.counting = B.counting = true;
  // Calm: 10 s.
  let t = Date.now(); bytes = 0;
  await sleep(10000);
  const calm = { a: A.misses, b: B.misses, kb: bytes, ms: Date.now() - t };
  console.log(`AUDIO calm 10s: feeder misses ${calm.a}, old misses ${calm.b}, captured ${(calm.kb / 192 / calm.ms * 100).toFixed(1)}%`);

  // Busy: the page blocks its main thread for 250 ms every 1.2 s, and the
  // main process blocks for 120 ms every 2.5 s (like a song loading / UI work).
  await ctx.runInYtm('window.__busyT = setInterval(() => { const e = performance.now() + 250; while (performance.now() < e); }, 1200); 0');
  const mainBusy = setInterval(() => { const e = Date.now() + 120; while (Date.now() < e); }, 2500);
  A.misses = 0; B.misses = 0; t = Date.now(); bytes = 0;
  await sleep(20000);
  const busy = { a: A.misses, b: B.misses, kb: bytes, ms: Date.now() - t };
  clearInterval(mainBusy);
  await ctx.runInYtm('clearInterval(window.__busyT); 0');
  console.log(`AUDIO busy 20s: feeder misses ${busy.a} (${feeder.stats.underruns} refills, cushion ${feeder.target} ms, ${feeder.stats.skips} skip-aheads), old misses ${busy.b}, captured ${(busy.kb / 192 / busy.ms * 100).toFixed(1)}%`);

  // Song change while playing.
  const song2 = (await ctx.ytmCall('search', 'middle class rut aunt betty')).find((x) => x.kind === 'Song');
  A.misses = 0; B.misses = 0;
  await ctx.playerCmd('load', song2.videoId);
  await waitFor(() => { const s = ctx.getPlayerState(); return s.playing && !s.ad && s.videoId === song2.videoId; }, 150000);
  await sleep(6000);
  console.log(`AUDIO song change: feeder misses ${A.misses}, old misses ${B.misses}, feeder ${JSON.stringify(feeder.info())}`);

  check('capture keeps all the audio even when the page is busy', busy.kb / 192 / busy.ms > 0.97, `${(busy.kb / 192 / busy.ms * 100).toFixed(1)}%`);
  check('no skips while calm', calm.a === 0, `${calm.a} missed frames`);
  check('busy app: far fewer skips than before', busy.a <= Math.max(2, busy.b / 4), `feeder ${busy.a} vs old ${busy.b} missed frames`);
  check('latency stays reasonable', feeder.bufferedMs() < 2000, `${Math.round(feeder.bufferedMs())} ms buffered`);

  A.stop = B.stop = true; clearInterval(tick); ctx.pcmSinks.delete(sink);
  await ctx.runInYtm('window.__wl.cmd.capture(false)');
  return check.all();
};
