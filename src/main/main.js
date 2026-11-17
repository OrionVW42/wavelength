// Wavelength — YouTube Music desktop player with mini player, hotkeys,
// ad blocking and listen-together rooms.
const {
  app, BrowserWindow, WebContentsView, ipcMain, globalShortcut, Tray, Menu,
  nativeImage, session, shell, screen, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { JsonStore } = require('./store');
const { enableAdblock, disableAdblock } = require('./adblock');
const { createUpdater } = require('./updater');

if (process.env.WL_USERDATA) app.setPath('userData', process.env.WL_USERDATA);
const TEST = !!process.env.WL_TEST_SCRIPT;
const BOOT = global.__wlBoot || null;
const VERSION = BOOT ? BOOT.version : app.getVersion();

const ROOT = path.join(__dirname, '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ICON = path.join(ROOT, 'build', 'icon.png');
const YTM_URL = 'https://music.youtube.com/';
const TITLEBAR = 44;
// Mini player base size (CSS px at 100%); it scales with the chosen width.
const MINI_W = 468;
const MINI_H = { bar: 100, search: 278 };
const MINI_MIN_W = 380, MINI_MAX_W = 960;
const COLORS = ['#ff4d6d', '#ff8a3d', '#ffd23f', '#3ddc97', '#27c3ff', '#7c6cff', '#e15bff', '#ff5fa2'];

// ------------------------------------------------------------------ settings
const DEFAULT_HOTKEYS = {
  toggle: 'Ctrl+Alt+Space',
  next: 'Ctrl+Alt+Right',
  prev: 'Ctrl+Alt+Left',
  volUp: 'Ctrl+Alt+Up',
  volDown: 'Ctrl+Alt+Down',
  like: 'Ctrl+Alt+L',
  showFull: 'Ctrl+Alt+M',
  toggleMini: 'Ctrl+Alt+N',
  miniSearch: 'Ctrl+Alt+S',
  toggleVideo: 'Ctrl+Alt+V',
};
const settings = new JsonStore(path.join(app.getPath('userData'), 'settings.json'), {
  id: crypto.randomUUID(),
  name: (() => { try { return os.userInfo().username; } catch { return 'Listener'; } })(),
  color: COLORS[Math.floor(Math.random() * COLORS.length)],
  miniMode: 'playing',       // playing | always | background | never
  miniPos: null,
  miniWidth: MINI_W,
  closeToTray: true,
  openAtLogin: false,
  adblock: true,
  dataSaver: true,           // album art + 144p instead of full video
  mediaKeys: true,
  signinCompat: true,
  autoUpdate: true,
  hotkeys: DEFAULT_HOTKEYS,
  panelOpen: true,
  bounds: null,
  peerServer: '',            // optional self-hosted PeerJS server "host:port"
});
const saved = new JsonStore(path.join(app.getPath('userData'), 'saved.json'), { playlists: [], session: null });
settings.save(); // persist the generated identity on first run

// Own the keyboard media keys ourselves (so they follow the listening room);
// Chromium's built-in handler would otherwise also toggle playback.
if (settings.get('mediaKeys')) app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');
// Guests in a room start tracks without clicking anything.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Keep the player at full speed while hidden in the tray, so bringing the
// window back is instant.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');

if (!TEST && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('app.wavelength.player');

let mainWin = null, ytmView = null, miniWin = null, tray = null, updater = null;
let layoutState = { panel: settings.get('panelOpen') ? 380 : 0, hideYtm: false };
let playerState = {};
let sessionSummary = null;
let miniDismissed = false, miniWanted = false, miniForced = null, miniMode = 'bar';
let quitting = false;
let hotkeysSuspended = false;
const hotkeyStatus = {};

const SIGNIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
const BRIDGE = fs.readFileSync(path.join(ROOT, 'src', 'inject', 'bridge.js'), 'utf8');

const send = (win, ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); };
const toShell = (ch, ...a) => send(mainWin, ch, ...a);
const toMini = (ch, ...a) => send(miniWin, ch, ...a);

// ------------------------------------------------------------------ session
function setupYtmSession() {
  const ses = session.fromPartition('persist:ytm');
  // Keep Electron's default user agent here: presenting as plain Chrome makes
  // YouTube's streaming server stop sending audio (seeks and ~50s in freeze).
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (d, cb) => {
    if (!settings.get('signinCompat')) return cb({ requestHeaders: d.requestHeaders });
    const h = { ...d.requestHeaders, 'User-Agent': SIGNIN_UA };
    for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k)) delete h[k];
    cb({ requestHeaders: h });
  });
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'fullscreen', 'clipboard-sanitized-write'].includes(perm)));
  if (settings.get('adblock')) {
    enableAdblock(ses, app.getPath('userData')).catch((e) => console.error('[adblock] lists unavailable:', e.message));
  }
  return ses;
}

// ------------------------------------------------------------------ windows
function createMain() {
  const b = settings.get('bounds');
  mainWin = new BrowserWindow({
    width: b?.width || 1280, height: b?.height || 820,
    x: b?.x, y: b?.y,
    minWidth: 900, minHeight: 560,
    show: false,
    backgroundColor: '#0a0a0f',
    icon: ICON,
    title: 'Wavelength',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0a0f', symbolColor: '#c9c9d6', height: TITLEBAR },
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'app.js'),
      contextIsolation: true, sandbox: true, backgroundThrottling: false,
    },
  });
  if (b?.maximized) mainWin.maximize();
  if (TEST) mainWin.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) console.log('RENDERER', e.message, e.sourceId ? `(${String(e.sourceId).split(/[\/]/).pop()}:${e.lineNumber})` : ''); });
  mainWin.loadFile(path.join(ROOT, 'src', 'renderer', 'shell', 'index.html'));

  ytmView = new WebContentsView({
    webPreferences: {
      session: setupYtmSession(),
      preload: path.join(ROOT, 'src', 'preload', 'ytm.js'),
      contextIsolation: true, sandbox: true, backgroundThrottling: false,
    },
  });
  ytmView.setBackgroundColor('#030303');
  mainWin.contentView.addChildView(ytmView);
  const wc = ytmView.webContents;
  if (TEST) wc.setAudioMuted(true);
  wc.loadURL(YTM_URL);
  wc.setWindowOpenHandler(({ url }) => {
    if (isYtmUrl(url)) { wc.loadURL(url); return { action: 'deny' }; }
    shell.openExternal(url); return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => { if (!isInternalUrl(url)) { e.preventDefault(); shell.openExternal(url); } });
  wc.on('context-menu', onYtmContextMenu);
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) toShell('ui', { offline: true, reason: desc });
  });
  wc.on('did-finish-load', () => toShell('ui', { offline: false }));
  wc.on('render-process-gone', () => setTimeout(() => wc.reload(), 1000));
  // Coming back from Google sign-in, reload once so YouTube Music starts
  // cleanly signed in (the first load after sign-in could be half-signed-in).
  let lastHost = '';
  wc.on('did-navigate', (_e, url) => {
    let h = ''; try { h = new URL(url).hostname; } catch { /* about:blank */ }
    if (/(^|\.)accounts\.google\.com$/.test(lastHost) && h === 'music.youtube.com') setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 1500);
    lastHost = h;
  });

  mainWin.on('resize', layout);
  mainWin.on('maximize', layout);
  mainWin.on('unmaximize', layout);
  mainWin.once('ready-to-show', () => {
    layout();
    if (!process.argv.includes('--hidden') && !TEST) mainWin.show();
  });
  const saveBounds = () => {
    if (mainWin.isDestroyed() || mainWin.isMinimized()) return;
    settings.set({ bounds: { ...mainWin.getNormalBounds(), maximized: mainWin.isMaximized() } });
  };
  mainWin.on('moved', saveBounds);
  mainWin.on('resized', saveBounds);
  mainWin.on('close', (e) => {
    if (!quitting && settings.get('closeToTray')) {
      e.preventDefault(); mainWin.hide(); autoShowMini();
      if (!saved.get('trayHintShown')) {
        saved.set({ trayHintShown: true });
        tray?.displayBalloon?.({ title: 'Wavelength is still playing', content: 'It lives in the tray. Right-click the icon to quit.', iconType: 'info' });
      }
    }
  });
  mainWin.on('minimize', autoShowMini);
  mainWin.on('show', updateMini);
  mainWin.on('hide', updateMini);
  mainWin.on('restore', updateMini);
  mainWin.on('focus', updateMini);
}

const isYtmUrl = (u) => { try { return new URL(u).hostname === 'music.youtube.com'; } catch { return false; } };
function isInternalUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'music.youtube.com' || h.endsWith('.google.com') || h === 'google.com' ||
      h.endsWith('.youtube.com') || h === 'youtube.com' || h.endsWith('.google.co.uk') || h.endsWith('gstatic.com');
  } catch { return false; }
}

function layout() {
  if (!mainWin || mainWin.isDestroyed() || !ytmView) return;
  const [w, h] = mainWin.getContentSize();
  const panel = Math.min(layoutState.panel, Math.max(0, w - 480));
  ytmView.setVisible(!layoutState.hideYtm);
  ytmView.setBounds({ x: 0, y: TITLEBAR, width: Math.max(0, w - panel), height: Math.max(0, h - TITLEBAR) });
}

// ------------------------------------------------------------------ mini player
const miniScale = () => Math.max(MINI_MIN_W, Math.min(MINI_MAX_W, settings.get('miniWidth') || MINI_W)) / MINI_W;
function miniSize(mode = miniMode) {
  const s = miniScale();
  return { width: Math.round(MINI_W * s), height: Math.round(MINI_H[mode] * s) };
}
function createMini() {
  const pos = settings.get('miniPos');
  const wa = screen.getPrimaryDisplay().workArea;
  const { width, height } = miniSize('bar');
  let x = Math.round(wa.x + (wa.width - width) / 2), y = wa.y;
  if (pos && screen.getAllDisplays().some((d) => pointIn(d.workArea, pos.x + 40, pos.y + 20))) ({ x, y } = pos);
  miniWin = new BrowserWindow({
    width, height, x, y,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, hasShadow: false,
    backgroundColor: '#00000000', icon: ICON, title: 'Wavelength mini player',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'app.js'),
      contextIsolation: true, sandbox: true, backgroundThrottling: false,
    },
  });
  miniWin.setAlwaysOnTop(true, 'screen-saver');
  miniWin.setVisibleOnAllWorkspaces(true);
  miniWin.loadFile(path.join(ROOT, 'src', 'renderer', 'mini', 'index.html'));
  miniWin.on('close', (e) => { if (!quitting) { e.preventDefault(); miniWin.hide(); } });
  miniWin.on('blur', () => { if (miniMode === 'search') toMini('ui', { blur: true }); });
  miniWin.webContents.on('did-finish-load', () => {
    miniWin.webContents.setZoomFactor(miniScale());
    toMini('player:state', playerState);
    if (sessionSummary) toMini('session:summary', sessionSummary);
    toMini('settings', publicSettings());
  });
}
const pointIn = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;

function applyMiniSize() {
  if (!miniWin) return;
  const [x, y] = miniWin.getPosition();
  const { width, height } = miniSize();
  miniWin.setBounds({ x, y, width, height });
  miniWin.webContents.setZoomFactor(miniScale());
}

// Dragging and resizing follow the real cursor at 60fps (independent of the
// page's zoom), started and stopped by the mini player's handle / grip.
let miniGesture = null;
function startMiniGesture(kind) {
  stopMiniGesture();
  const c = screen.getCursorScreenPoint();
  const [x, y] = miniWin.getPosition();
  miniGesture = { kind, cx: c.x, cy: c.y, x, y, w: miniSize().width };
  miniGesture.timer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    if (miniGesture.kind === 'drag') {
      miniWin.setPosition(Math.round(miniGesture.x + p.x - miniGesture.cx), Math.round(miniGesture.y + p.y - miniGesture.cy));
    } else {
      const w = Math.max(MINI_MIN_W, Math.min(MINI_MAX_W, miniGesture.w + (p.x - miniGesture.cx)));
      if (Math.round(w) !== settings.get('miniWidth')) { settings.data.miniWidth = Math.round(w); applyMiniSize(); }
    }
  }, 16);
}
function stopMiniGesture() {
  if (!miniGesture) return;
  clearInterval(miniGesture.timer);
  const [x, y] = miniWin.getPosition();
  settings.set({ miniPos: { x, y }, miniWidth: settings.get('miniWidth') });
  miniGesture = null;
}

// Decide whether the mini player should be on screen.
function updateMini() {
  if (!miniWin || miniWin.isDestroyed()) return;
  const mode = settings.get('miniMode');
  const mainVisible = mainWin && mainWin.isVisible() && !mainWin.isMinimized();
  let show = false;
  if (mode === 'always') show = !miniDismissed;
  else if (mode === 'playing') show = miniWanted && !miniDismissed;
  else if (mode === 'background') show = miniWanted && !miniDismissed && !mainVisible;
  if (miniForced !== null) show = miniForced;
  if (show && !miniWin.isVisible()) { miniWin.showInactive(); miniWin.setAlwaysOnTop(true, 'screen-saver'); }
  else if (!show && miniWin.isVisible()) miniWin.hide();
  updateTray();
}
// Minimizing or closing the full player brings the mini player out.
function autoShowMini() {
  if (settings.get('miniMode') === 'never' || !playerState.videoId) { updateMini(); return; }
  miniDismissed = false; miniForced = null; miniWanted = true;
  updateMini();
}
function toggleMini() {
  const vis = miniWin && miniWin.isVisible();
  miniForced = !vis;
  if (!vis) miniDismissed = false;
  updateMini();
}
function openMiniSearch() {
  miniForced = true; miniDismissed = false;
  updateMini();
  miniWin.show(); miniWin.focus();
  toMini('ui', { search: true });
}

function showMain() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  if (!mainWin.isVisible()) mainWin.show();
  mainWin.focus();
}
function toggleMain() {
  if (mainWin.isVisible() && !mainWin.isMinimized() && mainWin.isFocused()) { mainWin.hide(); autoShowMini(); }
  else showMain();
}

// ------------------------------------------------------------------ player
let lastTrackKey = '';
function onPlayerState(s) {
  const prev = playerState;
  playerState = s;
  toShell('player:state', s);
  toMini('player:state', s);
  const key = s.videoId || '';
  if (key !== lastTrackKey) { lastTrackKey = key; miniDismissed = false; if (miniForced === false) miniForced = null; }
  // Mini player appears once something actually plays.
  if (s.playing && (!prev.playing || prev.videoId !== s.videoId || prev.ad !== s.ad)) { miniWanted = true; updateMini(); }
  if (prev.playing !== s.playing || prev.videoId !== s.videoId || prev.title !== s.title) updateTray();
}

function runInYtm(code) {
  if (!ytmView) return Promise.reject(new Error('not ready'));
  return ytmView.webContents.executeJavaScript(code, true);
}
// Bridge config survives page reloads: the bridge reads it when injected.
const bridgeCfg = {};
function playerCmd(cmd, ...args) {
  if (!/^[a-zA-Z]+$/.test(cmd)) return Promise.resolve(null);
  if (cmd === 'setCfg' && args[0] && typeof args[0] === 'object') Object.assign(bridgeCfg, args[0]);
  return runInYtm(`window.__wl && window.__wl.cmd.${cmd}(...${JSON.stringify(args)})`).catch(() => null);
}
async function ytmCall(fn, ...args) {
  if (!/^[a-zA-Z]+$/.test(fn)) throw new Error('bad call');
  for (let i = 0; i < 40; i++) {
    const ready = await runInYtm('!!(window.__wl && window.ytcfg)').catch(() => false);
    if (ready) break;
    if (i === 39) throw new Error('YouTube Music is not loaded yet');
    await new Promise((r) => setTimeout(r, 250));
  }
  return runInYtm(`window.__wl.api.${fn}(...${JSON.stringify(args)})`);
}

// Semantic actions. Volume/like/windows are local; play/next/prev go through
// the session logic in the shell so listening rooms stay in step.
function handleAction(name, arg) {
  switch (name) {
    case 'volUp': case 'volDown': {
      const v = Math.max(0, Math.min(100, (playerState.volume ?? 50) + (name === 'volUp' ? 5 : -5)));
      playerState.volume = v;
      playerCmd('volume', v); toMini('ui', { volume: v });
      return;
    }
    case 'volume': playerCmd('volume', arg); toMini('ui', { volume: arg }); return;
    case 'like': playerCmd('like'); return;
    case 'showFull': toggleMain(); return;
    case 'openFull': showMain(); return;
    case 'toggleMini': toggleMini(); return;
    case 'miniSearch': openMiniSearch(); return;
    case 'toggleVideo': playerCmd('toggleVideo'); return;
    default: toShell('action', name, arg);
  }
}

// ------------------------------------------------------------------ hotkeys
const MEDIA_KEYS = { MediaPlayPause: 'toggle', MediaNextTrack: 'next', MediaPreviousTrack: 'prev', MediaStop: 'pause' };
function registerHotkeys() {
  globalShortcut.unregisterAll();
  for (const k of Object.keys(hotkeyStatus)) delete hotkeyStatus[k];
  if (hotkeysSuspended) return;
  const hk = settings.get('hotkeys') || {};
  for (const [action, accel] of Object.entries(hk)) {
    if (!accel || !(action in DEFAULT_HOTKEYS)) continue;
    let ok = false;
    try { ok = globalShortcut.register(accel, () => handleAction(action)); } catch { ok = false; }
    hotkeyStatus[action] = ok ? 'ok' : 'taken';
  }
  if (settings.get('mediaKeys')) {
    for (const [key, action] of Object.entries(MEDIA_KEYS)) {
      let ok = false;
      try { ok = globalShortcut.register(key, () => handleAction(action)); } catch { ok = false; }
      hotkeyStatus['media:' + key] = ok ? 'ok' : 'taken';
    }
  }
}

// ------------------------------------------------------------------ tray
function trayImage(size) {
  const img = nativeImage.createFromPath(ICON);
  return img.isEmpty() ? img : img.resize({ width: size, height: size, quality: 'best' });
}
function createTray() {
  tray = new Tray(trayImage(16));
  tray.on('click', showMain);
  updateTray();
}
let trayKey = '';
function updateTray() {
  if (!tray) return;
  const s = playerState;
  const np = s.title ? `${s.title}${s.artist ? ' — ' + s.artist : ''}` : 'Nothing playing';
  const ready = updater && updater.status().ready;
  const key = JSON.stringify([np, !!s.playing, !!miniWin?.isVisible(), ready && ready.version]);
  if (key === trayKey) return;
  trayKey = key;
  tray.setToolTip(`Wavelength\n${np}`.slice(0, 127));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: np.length > 60 ? np.slice(0, 57) + '…' : np, enabled: false },
    { type: 'separator' },
    { label: s.playing ? 'Pause' : 'Play', click: () => handleAction('toggle') },
    { label: 'Next', click: () => handleAction('next') },
    { label: 'Previous', click: () => handleAction('prev') },
    { type: 'separator' },
    { label: 'Open Wavelength', click: showMain },
    { label: miniWin?.isVisible() ? 'Hide mini player' : 'Show mini player', click: () => toggleMini() },
    ...(ready ? [{ type: 'separator' }, { label: `Restart to update to ${ready.version}`, click: () => updater.apply() }] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ------------------------------------------------------------------ context menu
// Songs and playlists are handled in the page (right-click adds to Up Next);
// the native menu only appears for text: cut / copy / paste.
function onYtmContextMenu(_e, params) {
  const items = [];
  if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
  else if (params.selectionText && params.selectionText.trim()) items.push({ role: 'copy' });
  else if (params.linkURL && !/music\.youtube\.com\/(watch|playlist|browse)/.test(params.linkURL)) items.push({ label: 'Copy link', click: () => clipboard.writeText(params.linkURL) });
  if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWin });
}

// ------------------------------------------------------------------ IPC
const publicSettings = () => ({ ...settings.get(), hotkeyStatus: { ...hotkeyStatus }, defaults: { hotkeys: DEFAULT_HOTKEYS }, version: VERSION });

ipcMain.on('wl:bridge', (e) => {
  e.returnValue = { code: BRIDGE, cfg: { ...bridgeCfg, adblock: settings.get('adblock'), dataSaver: settings.get('dataSaver') } };
});
ipcMain.on('wl:signin-compat', (e) => { e.returnValue = settings.get('signinCompat') ? SIGNIN_UA : null; });
ipcMain.on('ytm:msg', (e, type, data) => {
  if (!ytmView || e.sender !== ytmView.webContents) return;
  if (type === 'state') onPlayerState(data || {});
  else if (type === 'add') toShell('session:add', data);
  else if (type === 'video') { bridgeCfg.videoFlip = !!data.flip; toShell('ui', { videoOn: !!data.on }); }
  else toShell('player:event', type, data);
});
ipcMain.on('player:cmd', (_e, cmd, ...args) => playerCmd(cmd, ...args));
ipcMain.handle('ytm:call', (_e, fn, ...args) => ytmCall(fn, ...args));
ipcMain.on('ytm:browse', (_e, id) => { playerCmd('browse', id); showMain(); });
ipcMain.on('ytm:search-page', (_e, q) => { playerCmd('searchPage', String(q).slice(0, 200)); showMain(); });
ipcMain.on('ytm:reload', () => ytmView?.webContents.loadURL(YTM_URL));
ipcMain.on('action', (_e, name, arg) => handleAction(name, arg));
ipcMain.on('session:summary', (_e, s) => { sessionSummary = s; toMini('session:summary', s); });
ipcMain.on('session:add-items', (_e, items, where) => toShell('session:add', { items, where: where === 'next' ? 'next' : 'end', source: 'mini' }));
ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('settings:set', async (_e, patch) => {
  const before = settings.get();
  const prevAd = before.adblock, prevLogin = before.openAtLogin, prevSaver = before.dataSaver;
  if (patch.hotkeys) patch.hotkeys = { ...settings.get('hotkeys'), ...patch.hotkeys };
  settings.set(patch);
  if ('hotkeys' in patch || 'mediaKeys' in patch) registerHotkeys();
  if ('openAtLogin' in patch && patch.openAtLogin !== prevLogin) {
    app.setLoginItemSettings({ openAtLogin: !!patch.openAtLogin, args: ['--hidden'] });
  }
  if ('adblock' in patch && patch.adblock !== prevAd) {
    playerCmd('setCfg', { adblock: !!patch.adblock });
    if (patch.adblock) enableAdblock(ytmView.webContents.session, app.getPath('userData')).catch(() => {});
    else disableAdblock();
  }
  if ('dataSaver' in patch && patch.dataSaver !== prevSaver) playerCmd('setCfg', { dataSaver: !!patch.dataSaver, videoFlip: false });
  if ('miniMode' in patch) { miniForced = null; miniDismissed = false; updateMini(); }
  if ('miniWidth' in patch) applyMiniSize();
  if ('miniPos' in patch && !patch.miniPos && miniWin) {
    const wa = screen.getPrimaryDisplay().workArea;
    miniWin.setPosition(Math.round(wa.x + (wa.width - miniSize().width) / 2), wa.y);
    settings.set({ miniPos: null });
  }
  if ('autoUpdate' in patch && patch.autoUpdate && updater) updater.run();
  const pub = publicSettings();
  toMini('settings', pub); toShell('settings', pub);
  return pub;
});
ipcMain.handle('saved:list', () => saved.get('playlists'));
ipcMain.handle('saved:save', (_e, pl) => {
  const list = saved.get('playlists').slice();
  const item = { id: pl.id || crypto.randomUUID(), name: String(pl.name || 'Untitled').slice(0, 100), tracks: (pl.tracks || []).slice(0, 2000), createdAt: pl.createdAt || Date.now(), updatedAt: Date.now() };
  const i = list.findIndex((p) => p.id === item.id);
  if (i >= 0) list[i] = item; else list.unshift(item);
  saved.replace('playlists', list);
  return item;
});
ipcMain.handle('saved:delete', (_e, id) => { saved.replace('playlists', saved.get('playlists').filter((p) => p.id !== id)); return true; });
ipcMain.handle('session:state', (_e, s) => { if (s === undefined) return saved.get('session'); saved.replace('session', s); return true; });
ipcMain.on('win:layout', (_e, l) => {
  layoutState = { ...layoutState, ...l };
  if ('panel' in l) settings.set({ panelOpen: l.panel > 0 });
  layout();
});
ipcMain.on('win:show-main', showMain);
ipcMain.on('mini:hide', () => { miniDismissed = true; miniForced = null; updateMini(); });
ipcMain.on('mini:gesture', (_e, kind, phase) => { if (phase === 'start') startMiniGesture(kind === 'resize' ? 'resize' : 'drag'); else stopMiniGesture(); });
ipcMain.on('mini:mode', (_e, mode) => {
  miniMode = mode === 'search' ? 'search' : 'bar';
  applyMiniSize();
  if (miniMode === 'bar' && miniForced === true && !miniWanted) { miniForced = null; updateMini(); }
});
ipcMain.on('clipboard:write', (_e, t) => clipboard.writeText(String(t)));
ipcMain.on('open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.on('hotkeys:suspend', (_e, on) => { hotkeysSuspended = !!on; registerHotkeys(); });
ipcMain.handle('app:info', () => ({ version: VERSION, electron: process.versions.electron, fromUpdate: !!BOOT?.fromUpdate }));
ipcMain.handle('update:status', () => updater ? updater.status() : null);
ipcMain.handle('update:check', () => updater ? updater.run().then(() => updater.status()) : null);
ipcMain.handle('update:apply', () => updater ? updater.apply() : { ok: false });

// ------------------------------------------------------------------ lifecycle
app.on('second-instance', showMain);
app.on('before-quit', () => { quitting = true; settings.flush(); saved.flush(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (quitting) app.quit(); });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createMain();
  createMini();
  createTray();
  registerHotkeys();
  updater = createUpdater({
    app, settings, current: VERSION,
    repo: process.env.WL_UPDATE_REPO || (PKG.wavelength && PKG.wavelength.github) || 'OrionVW42/wavelength',
    versionsDir: BOOT ? BOOT.versionsDir : path.join(app.getPath('userData'), 'versions'),
    send: (s) => { toShell('update', s); updateTray(); },
    quit: (relaunch) => { quitting = true; if (relaunch) app.relaunch(); app.quit(); },
  });
  if (!TEST || process.env.WL_TEST_UPDATER) updater.schedule();
  // This version started fine: the launcher may keep using it.
  setTimeout(() => BOOT && BOOT.confirm(), TEST ? 3000 : 15000);
  if (TEST) {
    const ctx = { app, mainWin, miniWin, ytmView, playerCmd, ytmCall, handleAction, settings, saved, updater, boot: BOOT, version: VERSION,
      getPlayerState: () => playerState, getSummary: () => sessionSummary, hotkeyStatus, runInYtm };
    require(path.resolve(process.env.WL_TEST_SCRIPT))(ctx).then(
      (ok) => { console.log(ok === false ? 'WLTEST FAIL' : 'WLTEST PASS'); quitting = true; app.exit(ok === false ? 1 : 0); },
      (err) => { console.log('WLTEST FAIL', err && err.stack); quitting = true; app.exit(1); },
    );
  }
});
