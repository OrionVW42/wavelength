// Desktop guest joins a room by code (env WL_JOIN_CODE) — e.g. one hosted by
// Wavelength for Android — and reports what it sees.
const { sleep, waitFor, ready, checker, shell } = require('./util');
module.exports = async (ctx) => {
  const check = checker('join');
  await ready(ctx);
  await ctx.mainWin.webContents.executeJavaScript(`window.wl.setSettings({ name: 'PC Tester' }).then(() => 0)`);
  await sleep(500);
  await shell(ctx, `window.__session.me.name = 'PC Tester'; window.__session.join(${JSON.stringify(process.env.WL_JOIN_CODE)}); 0`);
  const live = await waitFor(() => shell(ctx, `window.__session.status === 'live' && window.__session.role === 'guest'`), 40000);
  check('PC joins the phone\'s room', !!live);
  const room = await waitFor(() => shell(ctx, `(() => { const s = window.__session; return s.members.length >= 2 && s.current ? JSON.stringify({ members: s.members.map((m) => m.name), current: s.current.title, queue: s.queue.length, via: s.via || null }) : null; })()`), 20000);
  check('sees the members, current song and Up Next', !!room, room);
  const host = JSON.parse(room || '{}');
  const logT = setInterval(() => { const p = ctx.getPlayerState(); console.log('JOIN pc player', JSON.stringify({ t: p.title, pos: Math.round(p.position || 0), playing: p.playing, ad: p.ad, vid: p.videoId })); }, 5000);
  const synced = await waitFor(() => { const p = ctx.getPlayerState(); return p.playing && p.title && host.current && (p.title === host.current || host.current.startsWith(p.title.slice(0, 10))) ? p.title : null; }, 90000, 1000);
  clearInterval(logT);
  check('PC plays the same song as the phone', !!synced, synced);
  // Add a song from the PC: it should land in the phone's Up Next.
  const song = (await ctx.ytmCall('search', 'daft punk get lucky')).find((s) => s.kind === 'Song');
  await shell(ctx, `window.__session.do('add', { items: [${JSON.stringify(song)}], where: 'next' }); 0`);
  await sleep(4000);
  const q0 = await shell(ctx, `window.__session.queue[0] && window.__session.queue[0].title + ' by ' + (window.__session.queue[0].addedBy || {}).name`);
  check('a song added on the PC comes back in the room\'s Up Next', /Get Lucky/.test(q0 || '') && /PC Tester/.test(q0 || ''), q0);
  console.log('JOIN ADDED ' + song.videoId);
  await sleep(3000);
  await shell(ctx, `window.__session.leave(); 0`);
  await sleep(1500);
  return check.all();
};
