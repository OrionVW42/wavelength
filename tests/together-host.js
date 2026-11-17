// Host side of the two-instance listen-together test (see tests/together.js).
const { sleep, waitFor, checker, writeJson, readJson, ready, shell } = require('./util');

module.exports = async (ctx) => {
  const check = checker('host');
  check('YouTube Music ready', await ready(ctx));
  const songs = (await ctx.ytmCall('search', 'queen greatest hits songs')).filter((s) => s.kind === 'Song').slice(0, 3);
  check('found songs to queue', songs.length === 3, songs.map((s) => s.title).join(' | '));

  await shell(ctx, 'window.__session.host()');
  const code = await waitFor(() => shell(ctx, "window.__session.status === 'live' && window.__session.code"), 20000);
  check('room opens on the public server', !!code, code || 'no code');
  if (!code) return false;
  writeJson('code.json', { code });

  await shell(ctx, `window.__session.do('add', { items: ${JSON.stringify(songs)}, where: 'end' })`);
  const playing = await waitFor(() => { const s = ctx.getPlayerState(); return s.playing && !s.ad && s.videoId === songs[0].videoId; }, 150000);
  check('host is playing song 1', !!playing);

  // Publish host playback continuously so the guest can measure drift.
  const pub = setInterval(() => {
    const s = ctx.getPlayerState();
    writeJson('host.json', { videoId: s.videoId, position: s.position + (s.playing ? (Date.now() - s.t) / 1000 : 0), at: Date.now(), playing: s.playing });
  }, 200);

  const joined = await waitFor(() => shell(ctx, 'window.__session.members.length === 2 && window.__session.members[1]'), 40000);
  check('guest joined the room', !!joined, joined ? joined.name : '');

  // Guest's live "now playing" reaches the host.
  const synced = await waitFor(() => shell(ctx, `(() => { const m = window.__session.members[1]; return m && m.np && m.np.videoId === ${JSON.stringify(songs[0].videoId)} && m.np.playing; })()`), 30000);
  check('host sees what the guest is playing, live', !!synced);

  // Guest adds a song: it lands in the host's queue tagged with the guest.
  const added = await waitFor(() => shell(ctx, "window.__session.queue.find(t => t.addedBy && t.addedBy.name === 'Guest Tester')"), 30000);
  check('guest-added song shows in the room queue with who added it', !!added, added ? `${added.title} by ${added.addedBy.name}` : '');

  writeJson('phase.json', { phase: 'pause' });
  await sleep(1000);
  ctx.handleAction('toggle');
  await waitFor(() => !ctx.getPlayerState().playing, 5000);
  await waitFor(() => readJson('guest-phase.json')?.phase === 'paused-ok' || readJson('guest-phase.json')?.phase === 'paused-fail', 15000);

  ctx.handleAction('toggle');
  await waitFor(() => ctx.getPlayerState().playing, 5000);
  await sleep(2000);
  writeJson('phase.json', { phase: 'next', expect: songs[1].videoId });
  ctx.handleAction('next');
  const nextOk = await waitFor(() => ctx.getPlayerState().videoId === songs[1].videoId, 60000);
  check('host skipped to song 2', !!nextOk);
  await waitFor(() => readJson('guest-phase.json')?.phase?.startsWith('next-'), 170000);

  // Guest skips: since guests may control playback, everyone moves on.
  writeJson('phase.json', { phase: 'guest-next' });
  const third = await waitFor(() => { const v = ctx.getPlayerState().videoId; return v && v !== songs[1].videoId ? v : null; }, 60000);
  check('a guest pressing Next skips for the whole room', !!third);

  writeJson('phase.json', { phase: 'unsync', expect: third });
  const solo = await waitFor(() => shell(ctx, 'window.__session.members[1] && window.__session.members[1].sync === false'), 15000);
  check('host sees the guest switch to listening solo', !!solo);

  await waitFor(() => readJson('guest-phase.json')?.phase === 'unsynced', 170000);
  await shell(ctx, 'window.__session.leave()');
  writeJson('phase.json', { phase: 'ended' });
  await waitFor(() => readJson('guest-phase.json')?.phase === 'done', 15000);
  clearInterval(pub);
  const g = readJson('guest-result.json');
  return check.all() && g && g.ok;
};
