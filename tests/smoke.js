// Smoke test: real YouTube Music in the real app (audio muted).
// Checks bridge state, ad pruning, search/resolve, Up Next advancing through
// the session engine, volume, mini player visibility; saves screenshots.
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.WL_SHOTS || path.join(__dirname, '..', 'test-shots');

module.exports = async (ctx) => {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
  const shell = (code) => ctx.mainWin.webContents.executeJavaScript(code, true);
  const waitFor = async (fn, ms = 20000, step = 250) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

  ctx.mainWin.show();
  const ready = await waitFor(() => ctx.getPlayerState().ready || ctx.runInYtm('!!window.ytcfg').catch(() => false), 30000);
  check('YouTube Music loads with bridge', !!ready);

  const search = await ctx.ytmCall('search', 'daft punk around the world').catch((e) => e.message);
  check('search returns songs', Array.isArray(search) && search.length > 3, Array.isArray(search) ? `${search.length} results, first: ${search[0].title} / ${search[0].artist} (${search[0].duration}s)` : search);

  const res = await ctx.ytmCall('resolve', 'fJ9rUzIMcZQ').catch((e) => e.message);
  check('resolve videoId metadata', res && res.title && /Bohemian/i.test(res.title), JSON.stringify(res).slice(0, 140));

  const albumId = await ctx.runInYtm(`(async () => { const r = await fetch('/youtubei/v1/search?prettyPrint=false', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: ytcfg.get('INNERTUBE_CONTEXT'), query: 'daft punk discovery album' }) }); const t = await r.text(); const m = t.match(/"(MPREb_[A-Za-z0-9_-]+)"/); return m && m[1]; })()`);
  const pl = albumId ? await ctx.ytmCall('playlist', albumId).catch((e) => e.message) : 'no album id found';
  check('album songs parse', Array.isArray(pl) && pl.length > 3, Array.isArray(pl) ? `${albumId}: ${pl.length} songs, first ${pl[0] && pl[0].title}` : pl);
  const songId = Array.isArray(search) && search.find((x) => x.kind === 'Song')?.videoId;
  const mix = songId ? await ctx.ytmCall('playlist', 'RDAMVM' + songId).catch((e) => e.message) : 'no song';
  check('mix/radio playlist parses', Array.isArray(mix) && mix.length > 3, Array.isArray(mix) ? `${mix.length} songs` : mix);
  check('search tags songs vs videos', Array.isArray(search) && search.some((x) => x.kind === 'Song') && search.some((x) => x.kind === 'Video'), Array.isArray(search) ? search.slice(0, 5).map((x) => x.kind + ':' + x.title).join(' | ') : '');

  // Queue two songs through the session engine (as if added from the panel).
  const items = Array.isArray(search) ? search.filter((s) => s.kind === 'Song').slice(0, 2) : [];
  await shell(`window.__session.do('add', { items: ${JSON.stringify(items)}, where: 'end' })`);
  const first = await waitFor(() => { const s = ctx.getPlayerState(); return s.videoId === items[0].videoId && s.playing && !s.ad ? s : null; }, 150000);
  check('adding to empty Up Next starts playing it', !!first, first ? `${first.title} — ${first.artist}` : JSON.stringify(ctx.getPlayerState()).slice(0, 200));
  const q1 = await shell('window.__session.queue.length');
  check('first song left the queue, second waits', q1 === 1, `queue=${q1}`);
  const adSeen = await ctx.runInYtm("document.querySelector('#movie_player').classList.contains('ad-showing')");
  console.log(`info ad showing at start: ${adSeen}`);

  // Hold-at-end: seek near the end; the session should advance to song 2.
  const dur = ctx.getPlayerState().duration;
  ctx.playerCmd('seek', dur - 8);
  const second = await waitFor(() => { const s = ctx.getPlayerState(); return s.videoId === items[1].videoId && !s.ad ? s : null; }, 150000);
  check('end of song advances to Up Next', !!second, second ? second.title : `still ${ctx.getPlayerState().title}`);
  const hist = await shell('window.__session.history.map(h => h.videoId)');
  check('finished song moved to history', hist.includes(items[0].videoId));

  // Next with an empty queue falls through to YouTube Music's own next.
  const before = ctx.getPlayerState().videoId;
  ctx.handleAction('next');
  const moved = await waitFor(() => ctx.getPlayerState().videoId && ctx.getPlayerState().videoId !== before, 15000);
  check('next with empty Up Next uses YouTube Music autoplay', !!moved, ctx.getPlayerState().title);

  // Prev goes back into our history.
  await sleep(1500);
  ctx.handleAction('prev'); await sleep(400); ctx.handleAction('prev');
  const back = await waitFor(() => ctx.getPlayerState().videoId === items[1].videoId, 15000);
  check('previous returns to the last played song', !!back, ctx.getPlayerState().title);

  // Volume via action (after the track switch settles).
  await sleep(4000);
  ctx.handleAction('volume', 37); await sleep(1200);
  check('volume command', ctx.getPlayerState().volume === 37, `volume=${ctx.getPlayerState().volume}`);

  // Toggle pause.
  ctx.handleAction('toggle');
  const paused = await waitFor(() => !ctx.getPlayerState().playing, 5000);
  check('play/pause toggles', !!paused);
  ctx.handleAction('toggle');
  await waitFor(() => ctx.getPlayerState().playing, 5000);

  check('mini player is visible while playing', ctx.miniWin.isVisible());
  check('hotkeys registered', Object.values(ctx.hotkeyStatus).filter((v) => v === 'ok').length >= 6, JSON.stringify(ctx.hotkeyStatus));

  await sleep(1500);
  fs.writeFileSync(path.join(OUT, 'main.png'), (await ctx.mainWin.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(OUT, 'ytm.png'), (await ctx.ytmView.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(OUT, 'mini.png'), (await ctx.miniWin.webContents.capturePage()).toPNG());
  return results.every(Boolean);
};
