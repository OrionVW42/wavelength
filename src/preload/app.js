// Preload for Wavelength's own windows (shell + mini player).
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('wl', {
  // player
  player: (cmd, ...args) => ipcRenderer.send('player:cmd', cmd, ...args),
  ytm: (fn, ...args) => ipcRenderer.invoke('ytm:call', fn, ...args),
  browse: (id) => ipcRenderer.send('ytm:browse', id),
  reloadYtm: () => ipcRenderer.send('ytm:reload'),
  onPlayerState: on('player:state'),
  onPlayerEvent: on('player:event'),
  // semantic actions (play/pause/next/prev...) routed through the session
  action: (name, arg) => ipcRenderer.send('action', name, arg),
  onAction: on('action'),
  onSessionAdd: on('session:add'),
  sessionSummary: (s) => ipcRenderer.send('session:summary', s),
  onSessionSummary: on('session:summary'),
  // settings + saved playlists
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettings: on('settings'),
  saved: (op, ...args) => ipcRenderer.invoke('saved:' + op, ...args),
  sessionState: (s) => ipcRenderer.invoke('session:state', s),
  // windows
  layout: (l) => ipcRenderer.send('win:layout', l),
  showMain: () => ipcRenderer.send('win:show-main'),
  hideMini: () => ipcRenderer.send('mini:hide'),
  miniHover: (h) => ipcRenderer.send('mini:hover', h),
  copy: (text) => ipcRenderer.send('clipboard:write', text),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  info: () => ipcRenderer.invoke('app:info'),
  suspendHotkeys: (on) => ipcRenderer.send('hotkeys:suspend', on),
  onToast: on('toast'),
  onUi: on('ui'),
});
