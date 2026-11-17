// 1.1 quality-of-life checks against real YouTube Music (muted, hidden window).
const { sleep, waitFor, checker, ready, shell } = require('./util');

module.exports = async (ctx) => {
  const check = checker('qol');
  const ev = (c) => ctx.runInYtm(c);
  const mini = (c) => ctx.miniWin.webContents.executeJavaScript(c, true);
  const queue = () => shell(ctx, 'window.__session.queue.map(t => t.videoId)');
  check('YouTube Music ready', await ready(ctx));
  ctx.settings.set({ miniMode: 'playing', dataSaver: true });

  // ---------------------------------------------------------------- title bar search
  await shell(ctx, "(() => { const i = document.querySelector('#add-input'); i.value = 'daft punk get lucky'; i.dispatchEvent(new Event('input')); return 0; })()");
  const rows = await waitFor(() => shell(ctx, "document.querySelectorAll('#results .track[data-vid]').length"), 20000);
  check('title bar search shows results in the panel', rows > 3 && await shell(ctx, "!document.querySelector('#results-wrap').hidden"), `${rows} results`);
  const firstVid = await shell(ctx, "document.querySelector('#results .track[data-vid]').dataset.vid");
  await shell(ctx, "document.querySelector('#results .track[data-vid] .meta').click(); 0");
  const added1 = await waitFor(async () => (await queue()).includes(firstVid) || ctx.getPlayerState().videoId === firstVid, 15000);
  check('clicking a search result adds it (starts playing when Up Next was empty)', !!added1);
  await waitFor(() => { const s = ctx.getPlayerState(); return s.playing && !s.ad; }, 150000);

  // ---------------------------------------------------------------- data saver
  await sleep(4000);
  const saverOn = await ev("JSON.stringify({ res: document.querySelector('#movie_player').getStatsForNerds().resolution, art: getComputedStyle(document.getElementById('wl-art') || document.body).display, cls: document.documentElement.classList.contains('wl-saver') })");
  const so = JSON.parse(saverOn);
  check('data saver: album art over the video', so.cls && so.art === 'flex', saverOn);
  check('data saver: stream held at 144p', /256x144/.test(so.res), so.res);
  check('state reports video off', ctx.getPlayerState().video === false);
  ctx.handleAction('toggleVideo');
  await sleep(6000);
  const saverOff = JSON.parse(await ev("JSON.stringify({ res: document.querySelector('#movie_player').getStatsForNerds().resolution, art: getComputedStyle(document.getElementById('wl-art')).display })"));
  check('Show video: overlay gone, quality back up', saverOff.art === 'none' && /(426x240|640x360|854x480|1280x720|1920x1080)/.test(saverOff.res), JSON.stringify(saverOff));
  check('title bar video button follows', await shell(ctx, "document.querySelector('#btn-video').classList.contains('on')"));
  ctx.handleAction('toggleVideo');
  await sleep(1500);

  // ---------------------------------------------------------------- like heart in the big player
  check('Now Playing card has a like heart', await shell(ctx, "!!document.querySelector('#np-like svg') && !document.querySelector('#np').hidden"));

  // ---------------------------------------------------------------- right-click = add
  await ev("document.querySelector('ytmusic-app').dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint: { searchEndpoint: { query: 'tame impala' } } } })); 0");
  await waitFor(() => ev("[...document.querySelectorAll('ytmusic-responsive-list-item-renderer')].filter(r => r.querySelector('a[href*=\"watch?v=\"]')).length > 2"), 30000);
  await sleep(2000);
  const ROW = (n) => `[...document.querySelectorAll('ytmusic-responsive-list-item-renderer')].filter(r => r.querySelector('a[href*="watch?v="]'))[${n}]`;
  const rcVid = await ev(`new URL(${ROW(0)}.querySelector('a[href*="watch?v="]').href).searchParams.get('v')`);
  const rc = await ev(`(() => { const t = ${ROW(0)}.querySelector('.title') || ${ROW(0)}; const e = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, button: 2 }); t.dispatchEvent(e); return e.defaultPrevented; })()`);
  const rcAdded = await waitFor(async () => (await queue()).includes(rcVid), 15000);
  check('right-click on a song adds it to Up Next', !!rcAdded, rcVid);
  await sleep(800);
  check('YouTube Music\'s own popup stays closed', !(await ev("[...document.querySelectorAll('tp-yt-iron-dropdown')].some(d => d.opened)")));
  check('toast offers Undo', await shell(ctx, "!!document.querySelector('#toast.show .undo')"));
  await shell(ctx, "document.querySelector('#toast .undo').click(); 0");
  await sleep(1000);
  check('Undo removes it again', !(await queue()).includes(rcVid));

  // ---------------------------------------------------------------- ⋮ menu "Play next" → Up Next
  await shell(ctx, `window.__session.do('add', { items: [${JSON.stringify((await ctx.ytmCall('search', 'dua lipa levitating')).find((s) => s.kind === 'Song'))}], where: 'end' })`);
  await sleep(800);
  ctx.mainWin.showInactive(); await sleep(1500); // menus render on animation frames, which hidden windows skip
  const pnVid = await ev(`new URL(${ROW(1)}.querySelector('a[href*="watch?v="]').href).searchParams.get('v')`);
  await ev(`(() => { const bs = [...${ROW(1)}.querySelectorAll('ytmusic-menu-renderer button')]; const b = bs[bs.length - 1]; b.click(); return 0; })()`);
  await sleep(1500);
  const clicked = await ev("(() => { const it = [...document.querySelectorAll('ytmusic-menu-popup-renderer ytmusic-menu-service-item-renderer')].find(e => { const d = e.data || (e.__data && e.__data.data); return d && d.serviceEndpoint && d.serviceEndpoint.queueAddEndpoint && /AFTER_CURRENT/.test(d.serviceEndpoint.queueAddEndpoint.queueInsertPosition); }); if (!it) return false; it.click(); return true; })()");
  await sleep(1200);
  const q = await queue();
  check('YouTube Music\'s "Play next" puts the song first in Up Next', clicked && q[0] === pnVid, `clicked=${clicked} first=${q[0]} want=${pnVid}`);
  check('its menu closes afterwards', !(await ev("[...document.querySelectorAll('tp-yt-iron-dropdown')].some(d => d.opened)")));
  ctx.mainWin.hide();

  // ---------------------------------------------------------------- mini player
  ctx.handleAction('miniSearch');
  await sleep(700);
  const h0 = ctx.miniWin.getBounds().height;
  check('mini search opens and grows the mini player', ctx.miniWin.isVisible() && await mini("!document.querySelector('#search').hidden") && h0 > 200, `height ${h0}`);
  await mini("(() => { const i = document.querySelector('#s-q'); i.value = 'arctic monkeys'; i.dispatchEvent(new Event('input')); return 0; })()");
  const nRes = await waitFor(() => mini("document.querySelectorAll('.s-row').length"), 20000);
  check('mini search shows the top two results', nRes === 2, `${nRes} rows`);
  const miniVid = await mini("(() => { const r = document.querySelector('.s-row'); r.click(); return 0; })()").then(() => sleep(1200)).then(queue);
  const qLen = miniVid.length;
  check('clicking a mini result adds it to Up Next', qLen >= 2, `queue ${qLen}`);
  check('mini search resets and shrinks back', await mini("document.querySelector('#search').hidden && document.querySelector('#s-q').value === ''") && ctx.miniWin.getBounds().height < 120, `height ${ctx.miniWin.getBounds().height}`);
  check('mini player confirms what was added', /Added/.test(await mini("document.querySelector('#room').textContent")));
  check('mini player has a move handle with a grab cursor', await mini("getComputedStyle(document.querySelector('#handle')).cursor === 'grab' && getComputedStyle(document.querySelector('#grip')).cursor === 'nwse-resize'"));
  await ctx.mainWin.webContents.executeJavaScript("window.wl.setSettings({ miniWidth: 640 }).then(() => 0)");
  await sleep(500);
  const b = ctx.miniWin.getBounds();
  check('mini player resizes (width and zoom)', Math.abs(b.width - 640) <= 2 && Math.abs(ctx.miniWin.webContents.getZoomFactor() - 640 / 468) < 0.01, `${b.width}x${b.height} zoom ${ctx.miniWin.webContents.getZoomFactor().toFixed(2)}`);
  await ctx.mainWin.webContents.executeJavaScript("window.wl.setSettings({ miniWidth: 468 }).then(() => 0)");

  // ---------------------------------------------------------------- mini pops out when the big player goes away
  ctx.miniWin.webContents.send('player:state', ctx.getPlayerState());
  await mini("document.querySelector('#b-close').click(); 0");
  await sleep(400);
  const hiddenNow = !ctx.miniWin.isVisible();
  ctx.mainWin.show(); await sleep(400);
  ctx.mainWin.minimize(); await sleep(800);
  check('minimizing the full player brings the mini player back', hiddenNow && ctx.miniWin.isVisible());
  ctx.mainWin.restore(); await sleep(400);
  ctx.miniWin.hide();
  ctx.mainWin.close(); await sleep(800);
  check('closing the full player (to tray) brings the mini player back', !ctx.mainWin.isVisible() && ctx.miniWin.isVisible());

  // ---------------------------------------------------------------- settings
  await shell(ctx, "document.querySelector('#btn-settings').click(); 0");
  await sleep(1200);
  const st = await shell(ctx, "({ groups: [...document.querySelectorAll('.kbd-group')].map(g => g.textContent), keys: document.querySelectorAll('[data-hk]').length, upd: document.querySelector('#upd-desc').textContent, saver: !!document.querySelector('#st-saver'), size: !!document.querySelector('#st-mini-size') })");
  check('settings: grouped hotkeys incl. new ones', st.keys === 10 && st.groups.length >= 4, JSON.stringify(st.groups));
  check('settings: updates, data saver and mini size', st.saver && st.size && st.upd.length > 0, st.upd);
  return check.all();
};
