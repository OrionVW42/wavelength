const { sleep, waitFor, put, get, shell, ready, shot, shotMini, setup } = require('./showcase-util');

module.exports = async (ctx) => {
  await ready(ctx);
  await setup(ctx, 'Maya', '#ff4d6d', 20);
  const pick = async (q, n) => (await ctx.ytmCall('search', q)).filter((s) => s.kind === 'Song').slice(0, n);
  const mine = [...await pick('daft punk get lucky', 1), ...await pick('tame impala the less i know the better', 1), ...await pick('dua lipa levitating', 1), ...await pick('fleetwood mac dreams', 1)];

  await shell(ctx, 'window.__session.host()');
  const code = await waitFor(() => shell(ctx, "window.__session.status === 'live' && window.__session.code"), 30000);
  if (!code) throw new Error('room did not open');
  put('code.json', { code });
  console.log('step room ' + code);
  await shell(ctx, `window.__session.do('add', { items: ${JSON.stringify(mine)}, where: 'end' })`);
  await waitFor(() => { const s = ctx.getPlayerState(); return s.playing && !s.ad && s.videoId === mine[0].videoId; }, 150000);
  await waitFor(() => shell(ctx, 'window.__session.members.length === 2'), 120000);
  // Alex adds two songs; wait until they show up interleaved in the queue.
  await waitFor(() => shell(ctx, "window.__session.queue.filter(t => t.addedBy && t.addedBy.name === 'Alex').length >= 2"), 90000);
  // Interleave for a nicer shared-queue picture: Maya, Alex, Maya, Alex, Maya.
  await shell(ctx, `(() => { const s = window.__session; const a = s.queue.filter(t => t.addedBy && t.addedBy.name === 'Alex'); for (const [i, t] of a.entries()) s.do('move', { uid: t.uid, to: i * 2 + 1 }); })()`);
  await waitFor(() => shell(ctx, '(() => { const m = window.__session.members[1]; return m && m.np && m.np.playing; })()'), 90000);
  await sleep(9000);
  await shot(ctx, 'player.png');
  put('phase.json', { phase: 'guest-shot' });

  // Mini player, shown for the capture.
  ctx.settings.set({ miniMode: 'always' });
  ctx.handleAction('toggleMini'); await sleep(300);
  if (!ctx.miniWin.isVisible()) ctx.handleAction('toggleMini');
  await sleep(2500);
  await shotMini(ctx, 'mini.png');
  ctx.miniWin.hide();

  // Search results.
  await shell(ctx, "(() => { const i = document.querySelector('#add-input'); i.value = 'the weeknd'; i.dispatchEvent(new Event('input')); })()");
  await waitFor(() => shell(ctx, "document.querySelectorAll('#results .track').length > 4"), 20000);
  await sleep(2500);
  await shot(ctx, 'search.png');
  await shell(ctx, "document.querySelector('#add-clear').click()");

  // Saved playlists (real tracks from this session).
  const tracks = await shell(ctx, '[...window.__session.history, window.__session.current, ...window.__session.queue].filter(Boolean).map(t => ({ videoId: t.videoId, title: t.title, artist: t.artist, art: t.art, duration: t.duration }))');
  const more = [...await pick('the weeknd blinding lights', 1), ...await pick('harry styles as it was', 1), ...await pick('arctic monkeys do i wanna know', 1), ...await pick('glass animals heat waves', 1), ...await pick('mgmt electric feel', 1)];
  const chill = [...await pick('khruangbin people everywhere', 1), ...await pick('bon iver holocene', 1), ...await pick('men i trust show me how', 1), ...await pick('still corners the trip', 1)];
  await ctx.mainWin.webContents.executeJavaScript(`Promise.all([
    window.wl.saved('save', { name: 'Late night drive', tracks: ${JSON.stringify(chill)} }),
    window.wl.saved('save', { name: 'Friday room with Alex', tracks: ${JSON.stringify([...tracks, ...more])} }),
  ]).then(() => 0)`);
  await shell(ctx, "document.querySelector('[data-tab=saved]').click(); 0");
  await sleep(1200);
  await shell(ctx, "document.querySelector('.pl-head').click(); 0");
  await sleep(2500);
  await shot(ctx, 'saved.png');
  await shell(ctx, "document.querySelector('[data-tab=session]').click(); 0");

  // Settings (hotkeys area).
  await shell(ctx, "document.querySelector('#btn-settings').click(); 0");
  await sleep(1500);
  await shell(ctx, "document.querySelector('#settings').scrollTop = document.querySelector('#settings h2:nth-of-type(3)').offsetTop - 30; 0");
  await sleep(800);
  await shot(ctx, 'settings.png');
  await shell(ctx, "document.querySelector('#btn-settings').click(); 0");

  await waitFor(() => get('guest.json')?.done, 120000);
  await shell(ctx, 'window.__session.leave()');
  await sleep(800);
  return true;
};
