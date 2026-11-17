const { sleep, waitFor, put, get, shell, ready, shot, setup } = require('./showcase-util');

module.exports = async (ctx) => {
  await ready(ctx);
  await setup(ctx, 'Alex', '#27c3ff', 120);
  const code = (await waitFor(() => get('code.json'), 120000)).code;
  await shell(ctx, `window.__session.join(${JSON.stringify(code)})`);
  await waitFor(() => shell(ctx, "window.__session.role === 'guest' && window.__session.status === 'live'"), 40000);
  console.log('step joined');
  const pick = async (q) => (await ctx.ytmCall('search', q)).find((s) => s.kind === 'Song');
  const items = [await pick('frank ocean pink + white'), await pick('the strokes reptilia')].filter(Boolean);
  await shell(ctx, `window.__session.do('add', { items: ${JSON.stringify(items)}, where: 'end' })`);
  await waitFor(() => { const s = ctx.getPlayerState(); return s.playing && !s.ad; }, 150000);
  await waitFor(() => get('phase.json')?.phase === 'guest-shot', 200000);
  await sleep(1500);
  await shot(ctx, 'together.png');
  put('guest.json', { done: true });
  await waitFor(() => shell(ctx, "window.__session.role === 'solo'"), 300000);
  return true;
};
