// Guest side of the two-instance listen-together test (see tests/together.js).
const { sleep, waitFor, checker, writeJson, readJson, ready, shell } = require('./util');

module.exports = async (ctx) => {
  const check = checker('guest');
  const done = (ok) => { writeJson('guest-result.json', { ok }); writeJson('guest-phase.json', { phase: 'done' }); return ok; };
  check('YouTube Music ready', await ready(ctx));
  await ctx.settings.set({ name: 'Guest Tester' });
  await shell(ctx, "window.__session.me.name = 'Guest Tester'");

  const code = (await waitFor(() => readJson('code.json'), 60000))?.code;
  if (!check('got the room code', !!code)) return done(false);
  await shell(ctx, `window.__session.join(${JSON.stringify(code)})`);
  const live = await waitFor(() => shell(ctx, "window.__session.role === 'guest' && window.__session.status === 'live'"), 30000);
  if (!check('joined the room by code', !!live)) return done(false);

  const host = () => readJson('host.json');
  const same = await waitFor(() => { const h = host(), s = ctx.getPlayerState(); return h && s.videoId === h.videoId && s.playing && !s.ad; }, 150000);
  check('guest player loads the host\'s song by itself', !!same);

  // Drift: compare positions a few times once settled.
  await sleep(4000);
  const drifts = [];
  for (let i = 0; i < 5; i++) {
    const h = host(), s = ctx.getPlayerState();
    const hp = h.position + (h.playing ? (Date.now() - h.at) / 1000 : 0);
    const gp = s.position + (s.playing ? (Date.now() - s.t) / 1000 : 0);
    drifts.push(Math.abs(hp - gp));
    await sleep(700);
  }
  const maxDrift = Math.max(...drifts);
  check('guest stays in sync with the host', maxDrift < 2.5, `max drift ${maxDrift.toFixed(2)}s`);

  const room = await shell(ctx, '({ q: window.__session.queue.length, cur: window.__session.current && window.__session.current.title, members: window.__session.members.map(m => m.name) })');
  check('guest sees the room queue and members', room.q === 2 && room.members.length === 2, JSON.stringify(room));

  const extra = (await ctx.ytmCall('search', 'daft punk get lucky')).find((s) => s.kind === 'Song');
  await shell(ctx, `window.__session.do('add', { items: [${JSON.stringify(extra)}], where: 'end' })`);
  const mine = await waitFor(() => shell(ctx, "window.__session.queue.some(t => t.addedBy && t.addedBy.name === 'Guest Tester')"), 15000);
  check('guest\'s added song comes back in the shared queue', !!mine);

  await waitFor(() => readJson('phase.json')?.phase === 'pause', 60000);
  const paused = await waitFor(() => !ctx.getPlayerState().playing, 8000);
  check('host pause pauses the guest', !!paused);
  writeJson('guest-phase.json', { phase: paused ? 'paused-ok' : 'paused-fail' });

  const ph = await waitFor(() => { const x = readJson('phase.json'); return x && x.phase === 'next' && x; }, 30000);
  const followed = await waitFor(() => { const s = ctx.getPlayerState(); return ph && s.videoId === ph.expect && s.playing && !s.ad; }, 150000);
  check('host Next moves the guest to the same song', !!followed);
  writeJson('guest-phase.json', { phase: 'next-' + (followed ? 'ok' : 'fail') });

  await waitFor(() => readJson('phase.json')?.phase === 'guest-next', 200000);
  await sleep(1500);
  ctx.handleAction('next');
  const ph2 = await waitFor(() => { const x = readJson('phase.json'); return x && x.phase === 'unsync' && x; }, 200000);
  const followed2 = await waitFor(() => ph2 && ctx.getPlayerState().videoId === ph2.expect && ctx.getPlayerState().playing, 150000);
  check('guest follows its own skip', followed2);

  await shell(ctx, 'window.__session.setSync(false)');
  await sleep(1500);
  writeJson('guest-phase.json', { phase: 'unsynced' });

  await waitFor(() => readJson('phase.json')?.phase === 'ended', 200000);
  const solo = await waitFor(() => shell(ctx, "window.__session.role === 'solo'"), 10000);
  check('guest returns to solo when the host ends the room', !!solo);
  return done(check.all());
};
