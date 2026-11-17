// Plays one song for ~90s and logs player errors + failed/blocked requests.
const { sleep, waitFor, ready } = require('./util');
module.exports = async (ctx) => {
  const ses = ctx.ytmView.webContents.session;
  const fails = [];
  ses.webRequest.onErrorOccurred((d) => { if (!/favicon/.test(d.url)) fails.push(`${Math.round(performance.now() / 1000)}s ERR ${d.error} ${d.url.slice(0, 110)}`); });
  ses.webRequest.onCompleted((d) => { if (d.statusCode >= 400) fails.push(`${Math.round(performance.now() / 1000)}s HTTP ${d.statusCode} ${d.url.slice(0, 110)}`); });
  if (process.env.DIAG_SHOW) ctx.mainWin.show();
  await ready(ctx);
  const song = (await ctx.ytmCall('search', process.env.DIAG_Q || 'queen bohemian rhapsody')).find((s) => s.kind === 'Song');
  const t0 = performance.now();
  await ctx.playerCmd('load', song.videoId);
  if (process.env.DIAG_SEEK) { await waitFor(() => ctx.getPlayerState().playing && !ctx.getPlayerState().ad, 150000); await sleep(3000); ctx.playerCmd('seek', ctx.getPlayerState().duration - 70); }
  for (let i = 0; i < 26; i++) {
    await sleep(5000);
    const s = ctx.getPlayerState();
    const err = await ctx.runInYtm(`(() => { const e = document.querySelector('yt-playability-error-supported-renderers, .ytp-error, ytmusic-player .error'); const vd = document.querySelector('#movie_player').getVideoData(); return (e && e.offsetParent !== null ? 'ERRORSCREEN: ' + e.innerText.replace(/\\s+/g, ' ').slice(0, 80) : '') + ' state=' + document.querySelector('#movie_player').getPlayerState() + ' err=' + vd.errorCode + ' ads=' + (window.__wl.adsSkipped||0) + ' stallfix=' + (window.__wl.stallsFixed||0); })()`);
    console.log(`DIAG t=${Math.round((performance.now() - t0) / 1000)}s pos=${s.position.toFixed(1)} playing=${s.playing} ${err}`);
  }
  console.log('DIAG failures:\n' + [...new Set(fails)].slice(0, 60).join('\n'));
  return true;
};
