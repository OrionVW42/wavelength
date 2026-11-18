/* global Session, WLApp */
// Wavelength for Android: the app's own interface.
// YouTube Music runs hidden in the "engine" view (driven by bridge.js); this
// page talks to it through the Android app (see MainActivity.java), and runs
// the same listen-together engine as the desktop app (session.js).
(() => {
  'use strict';

  // ---------------------------------------------------------------- utils
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (sec) => {
    sec = Math.max(0, Math.round(+sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const sized = (url, n) => {
    if (!url) return BLANK;
    if (/googleusercontent\.com|ggpht\.com/.test(url)) return url.replace(/=w\d+-h\d+[^&?#]*$/, `=w${n}-h${n}-l90-rj`).replace(/=s\d+[^&?#]*$/, `=s${n}`);
    // Video thumbnails: small ones are 16:9 (crop cleanly); big ones are the
    // 4:3 hqdefault (always exists) whose black bars app.css crops away.
    const yt = /^https:\/\/i\d?\.ytimg\.com\/vi(?:_webp)?\/([\w-]{11})\/[\w]+\.(?:jpg|webp)/.exec(url);
    if (yt) return `https://i.ytimg.com/vi/${yt[1]}/${n <= 320 ? 'mqdefault' : 'hqdefault'}.jpg`;
    return url;
  };
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } };
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  // Tracks from the bridge (playlists, radio) carry no type: a videoId means a song.
  const typeOf = (i) => (i && (i.type || (i.videoId ? 'song' : ''))) || '';
  const isSong = (i) => typeOf(i) === 'song' && /^[\w-]{11}$/.test(i.videoId || '');
  const clean = (i) => ({ videoId: i.videoId, title: i.title || 'Unknown', artist: i.artist || '', art: i.art || null, duration: +i.duration || 0 });
  const shuffled = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const errText = (e) => String((e && e.message) || e || 'Something went wrong');

  const P = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const I = {
    home: P('M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z'),
    search: P('M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'),
    library: P('M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 5h-3v5.5a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1 2.5-2.5c.57 0 1.08.19 1.5.51V5h4v2zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z'),
    group: P('M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z'),
    back: P('M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z'),
    more: P('M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z'),
    play: P('M8 5v14l11-7z'),
    pause: P('M6 19h4V5H6v14zm8-14v14h4V5h-4z'),
    next: P('M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z'),
    prev: P('M6 6h2v12H6zm3.5 6l8.5 6V6z'),
    shuffle: P('M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z'),
    down: P('M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z'),
    like: P('M9 21h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.58 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2zM9 9l4.34-4.34L12 10h9v2l-3 7H9V9zM1 9h4v12H1z'),
    liked: P('M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z'),
    plAdd: P('M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z'),
    share: P('M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z'),
    radio: P('M20 6H8.3l8.26-3.34L15.88 1 3.24 6.15C2.51 6.43 2 7.17 2 8v12c0 1.1.89 2 2 2h16c1.11 0 2-.9 2-2V8c0-1.11-.89-2-2-2zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-8h-2v-2h-2v2H4V8h16v4z'),
    queue: P('M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z'),
    playNext: P('M21 3H3c-1.11 0-2 .89-2 2v12c0 1.1.89 2 2 2h5v2h8v-2h2v-2H3V5h18v8h2V5c0-1.11-.9-2-2-2zm-8 7V7h-2v3H8v2h3v3h2v-3h3v-2h-3zm11 8l-4.5 4.5L18 21l3-3-3-3 1.5-1.5L24 18z'),
    close: P('M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'),
    add: P('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z'),
    check: P('M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z'),
    person: P('M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'),
    copy: P('M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z'),
    note: P('M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z'),
    history: P('M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z'),
    trash: P('M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z'),
    logout: P('M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z'),
    login: P('M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z'),
    download: P('M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z'),
    save: P('M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z'),
    up: P('M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z'),
    link: P('M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z'),
  };
  const LOGO = '<svg viewBox="0 0 64 64"><defs><linearGradient id="wlg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff4d6d"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#wlg)"/><path d="M10 34c4 0 4-10 8-10s4 18 8 18 4-24 8-24 4 28 8 28 4-16 8-16 4 6 4 6" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const COLORS = ['#ff4d6d', '#8b5cf6', '#22c55e', '#f59e0b', '#06b6d4', '#ec4899', '#3b82f6', '#f97316'];

  // ---------------------------------------------------------------- Android bridge
  const pending = new Map();
  let rpcN = 0;
  const post = (o) => { try { WLApp.postMessage(JSON.stringify(o)); } catch (e) { console.warn('no app bridge', e); } };
  const call = (kind, fn, ...args) => new Promise((resolve, reject) => {
    const id = ++rpcN;
    pending.set(id, { resolve, reject });
    post({ t: 'rpc', id, kind, fn, args });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('YouTube Music is taking too long. Check your connection.')); } }, 45000);
  });
  const ytm = (fn, ...a) => call('api', fn, ...a);
  const cmd = (c, ...a) => post({ t: 'cmd', cmd: c, args: a });

  // ---------------------------------------------------------------- state
  let info = {};
  let player = {};
  let signedIn = false;
  let account = null;
  const settings = Object.assign({ dataSaver: true, transport: 'auto', peerServer: '' }, load('wl.settings', {}));
  let me = load('wl.me', null);
  if (!me) { me = { id: uid(), name: '', color: COLORS[Math.floor(Math.random() * COLORS.length)] }; }
  const saveSettings = () => save('wl.settings', settings);

  const api = {
    player: (c, ...args) => cmd(c, ...args),
    sessionState: (s) => { if (s === undefined) return load('wl.session', null); save('wl.session', s); return true; },
    // Up Next + room line for the lock screen player, notification and widget.
    sessionSummary: (sm) => {
      const room = sm.role === 'solo' ? '' : sm.status === 'live' || sm.members.length > 1
        ? `Listening together · ${sm.members.length} ${sm.members.length === 1 ? 'person' : 'people'}` : 'Listening together';
      post({ t: 'queue', room, upNext: (sm.upNext || []).map((t) => ({ uid: t.uid, videoId: t.videoId, title: t.title || '', artist: t.artist || '', art: t.art ? sized(t.art, 120) : `https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`, by: t.by || null })) });
    },
  };
  let sys = { battery: true, fullScreen: true };
  let lastSaved = '';
  let session = null;

  // ---------------------------------------------------------------- toasts + sheets
  let toastT = null;
  function toast(msg, opts = {}) {
    const el = $('#toast');
    el.className = 'show' + (opts.error ? ' error' : '');
    el.innerHTML = `<span>${esc(msg)}</span>`;
    const btn = (label, run) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { hideToast(); run(); }; el.appendChild(b); };
    if (opts.undo) btn('Undo', opts.undo);
    else if (opts.button) btn(opts.button.label, opts.button.run);
    else if (opts.action === 'resync') btn('Re-sync', () => session.setSync(true));
    else if (opts.action === 'unsync') btn('Leave sync', () => session.setSync(false));
    clearTimeout(toastT);
    toastT = setTimeout(hideToast, opts.error ? 6000 : (opts.undo || opts.button || opts.action) ? 5500 : 2800);
  }
  const hideToast = () => $('#toast').classList.remove('show');

  function openSheet(html, bind) {
    const s = $('#sheet');
    s.innerHTML = html;
    s.hidden = false; $('#sheet-scrim').hidden = false;
    if (bind) bind(s);
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheet-scrim').hidden = true; $('#sheet').innerHTML = ''; }
  $('#sheet-scrim').onclick = closeSheet;
  const sheetHead = (it) => `<div class="sheet-head"><img src="${esc(sized(it.art, 120))}" alt=""><div class="txt"><div class="t1">${esc(it.title)}</div><div class="t2">${esc(subtitle(it))}</div></div></div>`;
  function menu(head, items) {
    openSheet(head + items.map((x, n) => `<button class="sheet-item" data-n="${n}">${x[0]}<span>${esc(x[1])}</span></button>`).join(''), (s) => {
      s.onclick = (e) => { const b = e.target.closest('.sheet-item'); if (!b) return; closeSheet(); items[+b.dataset.n][2](); };
    });
  }
  function prompt(title, placeholder, initial, okLabel) {
    return new Promise((resolve) => {
      openSheet(`<div class="sheet-title">${esc(title)}</div><div class="sheet-input"><input id="sp-in" placeholder="${esc(placeholder)}" value="${esc(initial || '')}" maxlength="100"><button class="pillbtn white" id="sp-ok">${esc(okLabel || 'OK')}</button></div>`, (s) => {
        const inp = $('#sp-in', s);
        const done = (v) => { closeSheet(); resolve(v); };
        $('#sp-ok', s).onclick = () => done(inp.value.trim() || null);
        inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); };
        setTimeout(() => inp.focus(), 50);
      });
      const scrim = $('#sheet-scrim');
      const prev = scrim.onclick;
      scrim.onclick = () => { scrim.onclick = prev; closeSheet(); resolve(null); };
    });
  }

  // ---------------------------------------------------------------- items
  const reg = new Map();
  let regN = 0;
  const keep = (it) => { const k = 'i' + (++regN); reg.set(k, it); return k; };
  function subtitle(it) {
    if (typeOf(it) === 'song') return [it.kind === 'Video' ? 'Video' : null, it.artist || it.subtitle, it.duration ? fmt(it.duration) : null].filter(Boolean).join(' • ').replace(/^Song • /, '');
    return it.subtitle || ({ album: 'Album', playlist: 'Playlist', artist: 'Artist', podcast: 'Podcast' }[it.type] || '');
  }
  function rowHtml(it, o = {}) {
    const k = keep({ ...it, ctx: o.ctx });
    const cur = it.videoId && player.videoId === it.videoId;
    const who = o.who ? `<span class="who" style="background:${esc(o.who.color || '#555')}">${esc(o.who.name)}</span>` : '';
    const lead = o.idx != null ? `<div class="idx">${cur ? '<span class="eq"><i></i><i></i><i></i></span>' : o.idx}</div>`
      : `<img class="art" loading="lazy" src="${esc(sized(it.art, 120))}" alt="">`;
    return `<div class="row${it.type === 'artist' ? ' artist' : ''}${cur ? ' playing' : ''}" data-k="${k}" data-act="${o.act || 'open'}">${lead}
      <div class="txt"><div class="t1">${esc(it.title)}</div><div class="t2">${who}${cur && o.idx == null ? '<span class="eq"><i></i><i></i><i></i></span>' : ''}<span>${esc(o.sub != null ? o.sub : subtitle(it))}</span></div></div>
      ${o.noMenu ? '' : `<button class="more" data-k="${k}" data-act="${o.menuAct || 'menu'}">${I.more}</button>`}</div>`;
  }
  function cardHtml(it) {
    const k = keep(it);
    if (it.type === 'category') return `<div class="card mood" data-k="${k}" data-act="open" style="--c:${it.color ? '#' + (it.color >>> 0).toString(16).slice(-6) : 'var(--accent2)'}"><div class="t1">${esc(it.title)}</div></div>`;
    const video = it.type === 'song' && it.kind === 'Video';
    return `<div class="card ${it.type}${video ? ' video' : ''}" data-k="${k}" data-act="open"><img class="art" loading="lazy" src="${esc(sized(it.art, 320))}" alt="">
      <div class="t1">${esc(it.title)}</div><div class="t2">${esc(subtitle(it))}</div></div>`;
  }
  function shelfHtml(sh, opts = {}) {
    if (sh.text) return `<div class="shelf"><div class="shelf-head"><div class="t"><h2>${esc(sh.title)}</h2></div></div><div class="about">${esc(sh.text)}</div></div>`;
    const items = sh.items || [];
    if (!items.length) return '';
    const songs = items.every(isSong);
    const head = sh.title ? `<div class="shelf-head"><div class="t">${sh.strapline ? `<div class="strap">${esc(sh.strapline)}</div>` : ''}<h2>${esc(sh.title)}</h2></div></div>` : '';
    const ctx = songs ? { list: items } : null;
    let body;
    if (songs && sh.carousel && items.filter((i) => i.kind === 'Video').length < items.length / 2) {
      body = `<div class="grid4">${items.map((it, n) => rowHtml(it, { ctx: { ...ctx, index: n } })).join('')}</div>`;
    } else if (songs && !sh.carousel) {
      const list = opts.limit ? items.slice(0, opts.limit) : items;
      body = list.map((it, n) => rowHtml(it, { ctx: { ...ctx, index: n } })).join('');
    } else if (!sh.carousel && !sh.grid && items.every((i) => i.type !== 'category')) {
      body = items.map((it) => rowHtml(it)).join('');
    } else {
      body = `<div class="carousel">${items.map(cardHtml).join('')}</div>`;
    }
    return `<div class="shelf">${head}${body}</div>`;
  }

  // Taps on anything with data-k / data-act.
  function onItemClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const it = reg.get(el.dataset.k);
    const act = el.dataset.act;
    if (act === 'menu' && it) { e.stopPropagation(); return itemMenu(it); }
    if (act === 'qmenu' && it) { e.stopPropagation(); return queueMenu(it); }
    if (act === 'open' && it) return openItem(it);
    if (act === 'qplay' && it) return session.do('playNow', { uid: it.uid });
    if (act === 'hist' && it) return playSong(it);
  }
  function onItemLongPress(e) {
    const el = e.target.closest('[data-k]');
    if (!el) return;
    const it = reg.get(el.dataset.k);
    if (!it) return;
    e.preventDefault();
    if (isSong(it)) addItems([clean(it)], 'end');
    else if (it.browseId) addList(it, 'end');
  }
  for (const r of ['#view', '#np-drawer-body']) {
    $(r).addEventListener('click', onItemClick);
    $(r).addEventListener('contextmenu', onItemLongPress);
  }

  function openItem(it) {
    if (isSong(it)) return playSong(it, it.ctx);
    if (it.browseId) return push(pageBrowse(it));
  }

  // ---------------------------------------------------------------- playing
  function playSong(it, ctx) {
    if (ctx && ctx.list && session.role === 'solo') {
      // Like YouTube Music: play from here and let the rest of the list follow.
      const rest = ctx.list.slice(ctx.index || 0).filter(isSong).map(clean);
      session.do('replace', { items: rest });
    } else {
      session.do('add', { items: [clean(it)], where: 'now' });
      if (session.role !== 'solo') toast(`Playing “${it.title}” for everyone`);
    }
    openNp();
  }
  function addItems(items, where = 'end') {
    if (!items.length) return;
    session.do('add', { items, where });
    const what = items.length === 1 ? `“${items[0].title}”` : plural(items.length, 'song');
    const ids = items.map((t) => t.videoId);
    toast(where === 'next' ? `${what} plays next` : `Added ${what} to Up Next`, { undo: () => undoAdd(ids, where) });
  }
  function undoAdd(ids, where) {
    const mine = session.queue.filter((t) => t.addedBy && t.addedBy.id === me.id && ids.includes(t.videoId));
    const pick = where === 'next' ? mine.slice(0, ids.length) : mine.slice(-ids.length);
    for (const t of pick) session.do('remove', { uid: t.uid });
  }
  async function listSongs(it) {
    if (it.type === 'artist') {
      const p = await ytm('page', it.browseId);
      const id = p.header && (p.header.radioId || p.header.playlistId);
      if (id) return ytm('playlist', id, 100);
      const top = p.shelves.find((s) => s.items.length && s.items.every(isSong));
      return top ? top.items : [];
    }
    const songs = await ytm('playlist', it.browseId || it.playlistId, 300);
    for (const s of songs) if (!s.art) s.art = it.art;
    return songs;
  }
  async function playList(it, opts = {}) {
    toast(opts.where ? 'Loading songs…' : 'Starting…');
    try {
      let songs = (await listSongs(it)).filter(isSong).map(clean);
      if (!songs.length) { toast('Nothing to play there.', { error: true }); return; }
      if (opts.shuffle) songs = shuffled(songs);
      if (opts.where) { addItems(songs, opts.where); return; }
      if (session.role === 'solo') session.do('replace', { items: songs });
      else { session.do('add', { items: songs, where: 'now' }); toast(`Playing ${it.title} for everyone`); }
      hideToast();
      openNp();
    } catch (e) { toast(errText(e), { error: true }); }
  }
  const addList = (it, where) => playList(it, { where });
  async function startRadio(it) {
    toast('Starting radio…');
    try {
      const songs = (await ytm('radio', it.videoId)).filter(isSong).map(clean);
      if (!songs.length) throw new Error('No radio for this song');
      if (session.role === 'solo') {
        if (player.videoId === it.videoId) session.do('replace', { items: songs.filter((s) => s.videoId !== it.videoId) });
        else session.do('replace', { items: songs });
        hideToast();
      } else addItems(songs.filter((s) => s.videoId !== it.videoId).slice(0, 25), 'next');
    } catch (e) { toast(errText(e), { error: true }); }
  }
  const shareUrl = (it) => (isSong(it) ? `https://music.youtube.com/watch?v=${it.videoId}`
    : it.type === 'playlist' && /^VL/.test(it.browseId) ? `https://music.youtube.com/playlist?list=${it.browseId.slice(2)}`
      : `https://music.youtube.com/browse/${it.browseId}`);
  const share = (it) => post({ t: 'share', text: `${it.title}${it.artist ? ' — ' + it.artist : ''}\n${shareUrl(it)}`, title: 'Share' });

  function itemMenu(it) {
    if (isSong(it)) {
      const items = [
        [I.playNext, 'Play next', () => addItems([clean(it)], 'next')],
        [I.queue, 'Add to Up Next', () => addItems([clean(it)], 'end')],
        [I.radio, 'Start radio', () => startRadio(it)],
      ];
      if (signedIn) items.push([I.plAdd, 'Save to playlist', () => saveToPlaylist([it.videoId], it.title)]);
      items.push([I.share, 'Share', () => share(it)]);
      return menu(sheetHead(it), items);
    }
    if (it.type === 'artist') {
      return menu(sheetHead(it), [
        [I.radio, 'Start radio', () => playList(it)],
        [I.shuffle, 'Shuffle', () => playList(it, { shuffle: true })],
        [I.share, 'Share', () => share(it)],
      ]);
    }
    return menu(sheetHead(it), [
      [I.play, 'Play', () => playList(it)],
      [I.shuffle, 'Shuffle play', () => playList(it, { shuffle: true })],
      [I.playNext, 'Play next', () => playList(it, { where: 'next' })],
      [I.queue, 'Add to Up Next', () => playList(it, { where: 'end' })],
      [I.share, 'Share', () => share(it)],
    ]);
  }
  function queueMenu(t) {
    const mine = !t.addedBy || t.addedBy.id === me.id;
    const items = [
      [I.play, 'Play now', () => session.do('playNow', { uid: t.uid })],
      [I.playNext, 'Move to next', () => session.do('move', { uid: t.uid, to: 0 })],
      [I.radio, 'Start radio', () => startRadio(t)],
    ];
    if (signedIn) items.push([I.plAdd, 'Save to playlist', () => saveToPlaylist([t.videoId], t.title)]);
    if (session.role !== 'guest' || mine || session.guestsControl) items.push([I.trash, 'Remove from Up Next', () => session.do('remove', { uid: t.uid })]);
    menu(sheetHead({ ...t, type: 'song' }), items);
  }
  async function saveToPlaylist(videoIds, what) {
    openSheet('<div class="sheet-title">Save to playlist</div><div class="spinner"></div>');
    let lists = [];
    try { lists = (await ytm('library')).filter((l) => l.id !== 'LM'); } catch (e) { closeSheet(); toast(errText(e), { error: true }); return; }
    const rows = [[I.add, 'New playlist', null], ...lists.map((l) => [`<img src="${esc(sized(l.art, 96))}" style="width:40px;height:40px;border-radius:4px;object-fit:cover;background:#333" alt="">`, l.title, l])];
    openSheet(`<div class="sheet-title">Save to playlist</div>${rows.map((r, n) => `<button class="sheet-item" data-n="${n}">${r[0]}<span>${esc(r[1])}</span></button>`).join('')}`, (s) => {
      s.onclick = async (e) => {
        const b = e.target.closest('.sheet-item'); if (!b) return;
        const r = rows[+b.dataset.n];
        closeSheet();
        try {
          if (!r[2]) {
            const name = await prompt('New playlist', 'Playlist name', what ? `${what} mix` : '', 'Create');
            if (!name) return;
            await ytm('createPlaylist', name, videoIds);
            toast(`Saved to new playlist “${name}”`);
            libraryCache = null;
          } else {
            await ytm('addToPlaylist', r[2].id, videoIds);
            toast(`Saved to “${r[2].title}”`);
          }
        } catch (err) { toast(errText(err), { error: true }); }
      };
    });
  }

  // ---------------------------------------------------------------- navigation
  // One stack of pages per tab, like the YouTube Music app.
  const stacks = { home: [], search: [], library: [], together: [] };
  let tab = 'home';
  const view = $('#view');
  function makePage(p) {
    const el = document.createElement('div');
    el.className = 'page';
    p.el = el;
    return p;
  }
  function showTop() {
    const st = stacks[tab];
    const p = st[st.length - 1];
    view.replaceChildren(p.el);
    view.scrollTop = p.scroll || 0;
    if (!p.rendered) { p.rendered = true; p.render(p.el); }
    else if (p.refresh) p.refresh(p.el);
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  }
  function push(p) {
    const st = stacks[tab];
    if (st.length) st[st.length - 1].scroll = view.scrollTop;
    st.push(makePage(p));
    view.scrollTop = 0;
    showTop();
  }
  function pop() {
    const st = stacks[tab];
    if (st.length <= 1) return false;
    st.pop();
    showTop();
    return true;
  }
  function switchTab(t, reset) {
    const st = stacks[tab];
    if (st.length) st[st.length - 1].scroll = view.scrollTop;
    if (t === tab && reset) { while (stacks[t].length > 1) stacks[t].pop(); stacks[t][0].scroll = 0; }
    tab = t;
    if (!stacks[t].length) stacks[t].push(makePage(ROOT[t]()));
    showTop();
  }
  $$('#tabs button').forEach((b) => { b.innerHTML = `<i>${{ home: I.home, search: I.search, library: I.library, together: I.group }[b.dataset.tab]}</i>` + b.innerHTML.replace('<i></i>', ''); b.onclick = () => switchTab(b.dataset.tab, true); });
  view.addEventListener('scroll', () => {
    $('#topbar').classList.toggle('scrolled', view.scrollTop > 8);
    const st = stacks[tab];
    const p = st[st.length - 1];
    if (p && p.onScroll && view.scrollTop + view.clientHeight > view.scrollHeight - 600) p.onScroll();
  }, { passive: true });
  const pageHead = (title, extra = '') => `<div class="page-head"><button class="icon-btn" data-back>${I.back}</button><h1>${esc(title)}</h1>${extra}</div>`;
  view.addEventListener('click', (e) => { if (e.target.closest('[data-back]')) pop(); });

  function back() {
    if (!$('#sheet').hidden) { closeSheet(); return; }
    if ($('#np-drawer').classList.contains('open')) { closeDrawer(); return; }
    if ($('#np').classList.contains('open')) { closeNp(); return; }
    if (pop()) return;
    if (tab !== 'home') { switchTab('home'); return; }
    post({ t: 'exit' });
  }

  // ---------------------------------------------------------------- pages
  const ROOT = {
    home: () => ({
      render(el) {
        el.innerHTML = skeleton();
        let more = null, loading = false;
        const add = (shelves) => { el.insertAdjacentHTML('beforeend', shelves.map((s) => shelfHtml(s)).join('')); };
        const loadMore = async () => {
          if (!more || loading) return;
          loading = true;
          try { const r = await ytm('homeMore', more); more = r.more; add(r.shelves); } catch { more = null; }
          loading = false;
        };
        this.onScroll = loadMore;
        ytm('home').then((r) => {
          el.innerHTML = signedIn ? '' : signinNudge();
          add(r.shelves);
          more = r.more;
          loadMore();
        }).catch((e) => { el.innerHTML = errorBox(e, () => { this.rendered = false; showTop(); }); });
        this.homeFor = signedIn;
      },
      refresh() { if (this.homeFor !== signedIn) { this.rendered = false; showTop(); } },
    }),
    search: () => ({ render: renderSearch }),
    library: () => ({ render: renderLibrary, refresh: renderLibrary }),
    together: () => ({ render: renderTogether, refresh: renderTogether }),
  };
  const skeleton = () => `<div style="padding:8px 16px"><div class="skel" style="height:26px;width:40%;margin-bottom:14px"></div>${'<div style="display:flex;gap:12px;margin-bottom:12px"><div class="skel" style="width:48px;height:48px"></div><div style="flex:1"><div class="skel" style="height:14px;width:70%;margin:6px 0"></div><div class="skel" style="height:12px;width:40%"></div></div></div>'.repeat(4)}<div class="skel" style="height:26px;width:50%;margin:22px 0 14px"></div><div style="display:flex;gap:12px"><div class="skel" style="width:152px;height:152px;flex:none"></div><div class="skel" style="width:152px;height:152px;flex:none"></div><div class="skel" style="width:152px;height:152px;flex:none"></div></div></div>`;
  function errorBox(e, retry) {
    const id = 'r' + uid();
    setTimeout(() => { const b = document.getElementById(id); if (b) b.onclick = retry; });
    return `<div class="empty"><div class="big">Couldn't load this</div>${esc(errText(e))}<br><button class="pillbtn" id="${id}">Try again</button></div>`;
  }
  function signinNudge() {
    const id = 'sn' + uid();
    setTimeout(() => { const b = document.getElementById(id); if (b) b.onclick = () => post({ t: 'signin' }); });
    return `<div class="room-card" style="margin-top:0"><h2>Your music, here</h2><p>Sign in to YouTube Music for your playlists, likes and recommendations.</p><button class="pillbtn white" id="${id}">${I.login}<span>Sign in</span></button></div>`;
  }

  // ---- album / playlist / artist page
  function pageBrowse(it) {
    return {
      render(el) {
        el.innerHTML = pageHead(it.title) + '<div class="spinner"></div>';
        ytm('page', it.browseId).then((p) => {
          const h = p.header || { title: it.title, subtitle: it.subtitle, art: it.art };
          const k = keep({ ...it, art: it.art || h.art, title: h.title || it.title });
          if (it.type === 'artist' || h.artist) {
            el.innerHTML = `${pageHead('')}<div class="artist-hero" style="margin-top:-48px"><img src="${esc(sized(h.art, 900))}" alt=""><div class="over"><h1>${esc(h.title)}</h1>
              <div class="acts"><button class="pillbtn white" data-a="shuffle">${I.shuffle}<span>Shuffle</span></button><button class="pillbtn" data-a="radio">${I.radio}<span>Radio</span></button></div></div></div>
              ${p.shelves.map((s) => shelfHtml(s, { limit: 5 })).join('')}`;
          } else if (p.tracks.length) {
            const album = /^MPRE/.test(it.browseId);
            const total = p.tracks.reduce((a, t) => a + (t.duration || 0), 0);
            el.innerHTML = `${pageHead('')}<div class="hero"><img class="cover" src="${esc(sized(h.art || it.art, 600))}" alt=""><h1>${esc(h.title)}</h1>
              <div class="sub">${esc(h.subtitle || it.subtitle || '')}</div>${h.description ? `<div class="desc">${esc(h.description)}</div>` : ''}
              <div class="hero-actions"><button class="round" data-a="queue" aria-label="Add to Up Next">${I.queue}</button><button class="play" data-a="play" aria-label="Play">${I.play}</button><button class="round" data-a="shuffle" aria-label="Shuffle">${I.shuffle}</button><button class="round" data-a="menu" aria-label="More">${I.more}</button></div></div>
              ${p.tracks.map((t, n) => rowHtml(t, { ctx: { list: p.tracks, index: n }, idx: album ? n + 1 : null, sub: album ? (t.artist && h.subtitle && h.subtitle.includes(t.artist) ? fmt(t.duration) : subtitle(t)) : null })).join('')}
              <div class="section-title" style="text-transform:none">${plural(p.tracks.length, 'song')}${total ? ' • ' + fmt(total) : ''}${p.more ? ' • more in the full playlist' : ''}</div>
              ${p.shelves.map((s) => shelfHtml(s)).join('')}`;
          } else {
            el.innerHTML = pageHead(h.title || it.title) + (p.shelves.length ? p.shelves.map((s) => shelfHtml(s)).join('') : '<div class="empty">Nothing here.</div>');
          }
          el.onclick = (e) => {
            const b = e.target.closest('[data-a]'); if (!b) return;
            const a = b.dataset.a, target = reg.get(k);
            if (a === 'play') playList(target);
            else if (a === 'shuffle') playList(target, { shuffle: true });
            else if (a === 'radio') playList(target);
            else if (a === 'queue') playList(target, { where: 'end' });
            else if (a === 'menu') itemMenu(target);
          };
        }).catch((e) => { el.innerHTML = pageHead(it.title) + errorBox(e, () => { this.rendered = false; showTop(); }); });
      },
    };
  }

  // ---- search
  let recent = load('wl.recent', []);
  function renderSearch(el) {
    el.innerHTML = `<div class="search-bar"><div class="box">${I.search}<input id="q" type="search" placeholder="Search songs, artists, links" autocomplete="off" enterkeyhint="search"><button class="icon-btn" id="q-clear" hidden>${I.close}</button></div></div><div id="sbody"></div>`;
    const input = $('#q', el), body = $('#sbody', el), clr = $('#q-clear', el);
    let t = null, seq = 0;
    const showRecent = () => {
      body.innerHTML = recent.length ? `<div class="section-title">Recent searches</div><div class="sugg">${recent.map((q) => `<div class="row" data-q="${esc(q)}"><div class="ic">${I.history}</div><div class="txt"><div class="t1">${esc(q)}</div></div></div>`).join('')}</div>`
        : '<div class="empty"><div class="big">Find music</div>Search for songs, albums, artists or playlists, or paste a YouTube Music link.</div>';
    };
    const suggest = async (q) => {
      const my = ++seq;
      try {
        const r = await ytm('suggest', q);
        if (my !== seq || input.value.trim() !== q) return;
        body.innerHTML = `<div class="sugg">${r.words.map((w) => `<div class="row" data-q="${esc(w)}"><div class="ic">${I.search}</div><div class="txt"><div class="t1">${esc(w)}</div></div></div>`).join('')}
          ${r.items.map((it) => rowHtml(it)).join('')}</div>`;
      } catch { /* keep typing */ }
    };
    const run = async (q) => {
      q = q.trim(); if (!q) return;
      input.value = q; input.blur(); clr.hidden = false;
      recent = [q, ...recent.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 12); save('wl.recent', recent);
      const my = ++seq;
      const link = parseLink(q);
      body.innerHTML = '<div class="spinner"></div>';
      try {
        if (link) {
          if (link.videoId) {
            const s = await ytm('resolve', link.videoId);
            body.innerHTML = shelfHtml({ title: 'From your link', items: [{ ...s, type: 'song' }] });
          } else {
            const id = /^(MPRE|VL|UC)/.test(link.listId) ? link.listId : 'VL' + link.listId;
            push(pageBrowse({ type: /^UC/.test(id) ? 'artist' : /^MPRE/.test(id) ? 'album' : 'playlist', browseId: id, title: 'Playlist' }));
            body.innerHTML = '';
          }
          return;
        }
        const shelves = await ytm('searchAll', q);
        if (my !== seq) return;
        body.innerHTML = shelves.length ? shelves.map((s) => (s.top ? topResult(s) : shelfHtml({ ...s, carousel: !s.items.every(isSong) && s.items.some((i) => i.type !== 'artist' || true) && !['Songs', 'Videos', 'Podcasts', 'Episodes'].includes(s.title) }, { limit: 6 }))).join('')
          : '<div class="empty"><div class="big">No results</div>Try different words.</div>';
      } catch (e) { body.innerHTML = errorBox(e, () => run(q)); }
    };
    input.addEventListener('input', () => {
      const q = input.value.trim();
      clr.hidden = !input.value;
      clearTimeout(t);
      if (!q) { showRecent(); return; }
      t = setTimeout(() => suggest(q), 180);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(t); run(input.value); } });
    clr.onclick = () => { input.value = ''; clr.hidden = true; showRecent(); input.focus(); };
    body.addEventListener('click', (e) => { const r = e.target.closest('[data-q]'); if (r) run(r.dataset.q); });
    showRecent();
    this.focus = () => setTimeout(() => input.focus(), 80);
    this.focus();
  }
  function topResult(s) {
    const [top, ...rest] = s.items;
    if (!top) return '';
    const k = keep(top);
    return `<div class="shelf"><div class="shelf-head"><div class="t"><h2>Top result</h2></div></div>
      <div class="row${top.type === 'artist' ? ' artist' : ''}" data-k="${k}" data-act="open" style="min-height:84px"><img class="art" style="width:72px;height:72px" src="${esc(sized(top.art, 200))}" alt="">
      <div class="txt"><div class="t1" style="font-size:18px;font-weight:600">${esc(top.title)}</div><div class="t2"><span>${esc(subtitle(top))}</span></div></div><button class="more" data-k="${k}" data-act="menu">${I.more}</button></div>
      ${rest.map((it) => rowHtml(it)).join('')}</div>`;
  }
  function parseLink(text) {
    const t = text.trim();
    if (!/^(https?:\/\/|www\.|music\.|youtu)/i.test(t)) return null;
    try {
      const u = new URL(/^https?:/i.test(t) ? t : 'https://' + t);
      if (/youtu\.be$/.test(u.hostname)) return { videoId: u.pathname.slice(1, 12) };
      const v = u.searchParams.get('v'), list = u.searchParams.get('list');
      if (v) return { videoId: v };
      if (list) return { listId: list };
      const b = u.pathname.match(/\/(?:browse|channel)\/([\w-]+)/);
      if (b) return { listId: b[1] };
    } catch { /* not a link */ }
    return null;
  }

  // ---- library
  let libraryCache = null;
  async function renderLibrary(el) {
    const saved = load('wl.saved', []);
    const head = `<div class="lib-tiles">
      <button class="lib-tile" data-l="liked"><span class="ic">${I.liked}</span>Liked music</button>
      <button class="lib-tile" data-l="history"><span class="ic">${I.history}</span>Recently played</button></div>`;
    if (!signedIn) {
      el.innerHTML = signinNudge() + head + savedHtml(saved);
    } else {
      el.innerHTML = head + `<div class="shelf-head"><div class="t"><h2>Playlists</h2></div><button class="more" data-l="new">+ New</button></div><div id="lib-list">${libraryCache ? '' : '<div class="spinner"></div>'}</div>` + savedHtml(saved);
      const fill = (lists) => { const box = $('#lib-list', el); if (box) box.innerHTML = lists.filter((l) => l.id !== 'LM').map((l) => rowHtml({ type: 'playlist', browseId: 'VL' + l.id, title: l.title, subtitle: l.subtitle, art: l.art })).join('') || '<div class="empty">No playlists yet.</div>'; };
      if (libraryCache) fill(libraryCache);
      ytm('library').then((l) => { libraryCache = l; fill(l); }).catch((e) => { const box = $('#lib-list', el); if (box) box.innerHTML = errorBox(e, () => renderLibrary(el)); });
    }
    el.onclick = async (e) => {
      const b = e.target.closest('[data-l]'); if (!b) return;
      const l = b.dataset.l;
      if (l === 'liked') push(pageBrowse({ type: 'playlist', browseId: 'VLLM', title: 'Liked music' }));
      else if (l === 'history') push(pageHistory());
      else if (l === 'new') {
        const name = await prompt('New playlist', 'Playlist name', '', 'Create');
        if (name) { try { await ytm('createPlaylist', name, []); toast(`Created “${name}”`); libraryCache = null; renderLibrary(el); } catch (err) { toast(errText(err), { error: true }); } }
      } else if (l.startsWith('saved:')) {
        const s = saved.find((x) => x.id === l.slice(6));
        if (!s) return;
        menu(`<div class="sheet-title">${esc(s.name)}</div>`, [
          [I.play, 'Play', () => { if (session.role === 'solo') session.do('replace', { items: s.items }); else addItems(s.items, 'next'); openNp(); }],
          [I.queue, 'Add to Up Next', () => addItems(s.items, 'end')],
          [I.trash, 'Delete', () => { save('wl.saved', load('wl.saved', []).filter((x) => x.id !== s.id)); renderLibrary(el); }],
        ]);
      }
    };
  }
  function savedHtml(saved) {
    if (!saved.length) return '';
    return `<div class="section-title">Saved on this phone</div>${saved.map((s) => `<div class="row" data-l="saved:${esc(s.id)}"><img class="art" src="${esc(sized(s.items[0] && s.items[0].art, 120))}" alt=""><div class="txt"><div class="t1">${esc(s.name)}</div><div class="t2"><span>${plural(s.items.length, 'song')}</span></div></div></div>`).join('')}`;
  }
  function pageHistory() {
    return {
      render(el) {
        const h = session.history.slice().reverse();
        el.innerHTML = pageHead('Recently played') + (h.length ? h.map((t) => rowHtml({ ...t, type: 'song' }, { act: 'hist' })).join('') : '<div class="empty">Songs you play show up here.</div>');
      },
    };
  }

  // ---- together (rooms)
  function renderTogether(el) {
    const s = session;
    const pretty = Session.prettyCode ? Session.prettyCode(s.code) : s.code;
    let html = '';
    if (s.role === 'solo' && s.status === 'idle') {
      html = `<div class="room-card"><h2>Listen together</h2><p>Start a room and share the code. Friends on Wavelength (phone or PC) hear the same music at the same time, and everyone can add songs.</p>
        <div class="btn-row"><button class="pillbtn white" id="r-host">${I.group}<span>Start a room</span></button></div>
        <div class="join-row"><input id="r-code" placeholder="Room code" maxlength="8" autocapitalize="characters" autocomplete="off"><button class="pillbtn" id="r-join">Join</button></div></div>`;
    } else {
      const live = s.status === 'live';
      html = `<div class="room-card"><h2>${s.role === 'host' ? 'Your room' : 'In a room'}</h2>
        <p>${live ? (s.role === 'host' ? 'Share this code so friends can join.' : 'You\'re listening with the room.') : s.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</p>
        ${s.code ? `<div class="room-code">${esc(pretty)}</div>` : ''}
        <div class="btn-row">${s.code ? `<button class="pillbtn white" id="r-share">${I.share}<span>Share code</span></button>` : ''}<button class="pillbtn" id="r-leave">${s.role === 'host' ? 'End room' : 'Leave'}</button></div></div>
        <div class="section-title">Listening (${s.members.length})</div>
        ${s.members.map((m) => {
    const you = m.id === me.id;
    const np = m.np;
    return `<div class="member"><div class="av" style="background:${esc(m.color || '#555')}">${esc((m.name || '?')[0].toUpperCase())}${m.isHost ? '<span class="crown">👑</span>' : ''}</div>
            <div class="txt" style="flex:1;min-width:0"><div class="t1">${esc(m.name)}${you ? '<span class="tag">you</span>' : ''}${!m.isHost && m.sync === false ? '<span class="tag">solo</span>' : ''}${m.via === 'relay' ? '<span class="tag">relay</span>' : ''}</div>
            <div class="t2">${np ? `${np.playing ? '▶' : '⏸'} ${esc(np.title)} · ${esc(np.artist)}` : 'Nothing playing'}</div></div></div>`;
  }).join('')}
        ${s.role === 'guest' ? `<div class="setting"><div class="txt"><div class="t1">In sync with the room</div><div class="t2">Off: listen to your own music while staying in the room.</div></div><button class="switch${s.sync ? ' on' : ''}" id="r-sync"></button></div>` : ''}
        ${s.role === 'host' ? `<div class="setting"><div class="txt"><div class="t1">Everyone can control playback</div><div class="t2">Off: only you can pause and skip. Anyone can still add songs.</div></div><button class="switch${s.guestsControl ? ' on' : ''}" id="r-gc"></button></div>` : ''}`;
    }
    html += `<div class="section-title">You</div><div class="setting"><div class="member" style="padding:0"><div class="av" style="background:${esc(me.color)}">${esc((me.name || '?')[0].toUpperCase())}</div></div>
      <div class="txt"><div class="t1">Your name in rooms</div><div class="t2">Shown next to the songs you add.</div></div><input type="text" id="r-name" value="${esc(me.name)}" maxlength="24"></div>`;
    el.innerHTML = html;
    const on = (id, f) => { const b = $('#' + id, el); if (b) b.onclick = f; };
    on('r-host', () => { if (!ensureName()) return; s.host(); });
    on('r-join', () => { if (!ensureName()) return; const c = $('#r-code', el).value.trim(); if (c) s.join(c); });
    const code = $('#r-code', el); if (code) code.onkeydown = (e) => { if (e.key === 'Enter') $('#r-join', el).click(); };
    on('r-share', () => post({ t: 'share', text: `Join my Wavelength room: ${pretty}\nGet Wavelength: https://orionvw42.github.io/wavelength/`, title: 'Share room code' }));
    on('r-leave', () => s.leave());
    on('r-sync', () => s.setSync(!s.sync));
    on('r-gc', () => s.setGuestsControl(!s.guestsControl));
    const name = $('#r-name', el);
    name.onchange = () => { me.name = name.value.trim().slice(0, 24) || me.name; save('wl.me', me); if (s.role !== 'solo') toast('Your new name shows next time you join a room.'); };
  }
  function ensureName() {
    if (me.name) return true;
    toast('Add your name first (bottom of this page).', { error: true });
    const n = $('#r-name'); if (n) n.focus();
    return false;
  }

  // ---- settings
  function pageSettings() {
    return {
      settings: true,
      refresh(el) { this.render(el); },
      render(el) {
        const acc = account && signedIn
          ? `<div class="setting">${account.photo ? `<img src="${esc(account.photo)}" style="width:44px;height:44px;border-radius:50%" alt="">` : `<div class="member" style="padding:0"><div class="av" style="background:#555">${esc((account.name || '?')[0])}</div></div>`}<div class="txt"><div class="t1">${esc(account.name)}</div><div class="t2">${esc(account.handle || 'Signed in to YouTube Music')}</div></div><button class="pillbtn" data-s="signout">Sign out</button></div>`
          : `<div class="setting"><div class="txt"><div class="t1">${signedIn ? 'Signed in to YouTube Music' : 'Not signed in'}</div><div class="t2">Your playlists, likes and recommendations.</div></div><button class="pillbtn ${signedIn ? '' : 'white'}" data-s="${signedIn ? 'signout' : 'signin'}">${signedIn ? 'Sign out' : 'Sign in'}</button></div>`;
        el.innerHTML = pageHead('Settings') + `<div class="section-title">Account</div>${acc}
          <div class="section-title">Playback</div>
          <div class="setting"><div class="txt"><div class="t1">Data saver</div><div class="t2">Album art instead of video and the lowest video quality, so music uses much less data. Switch to Video in the player any time.</div></div><button class="switch${settings.dataSaver ? ' on' : ''}" data-s="saver"></button></div>
          <div class="setting"><div class="txt"><div class="t1">Lock screen player</div><div class="t2">A big player with art and controls over the lock screen while music plays.${sys.fullScreen ? '' : ' <b>Needs one permission:</b> tap Allow.'}</div></div>${sys.fullScreen ? '' : '<button class="pillbtn white" data-s="fixlock">Allow</button>'}<button class="switch${info.lockPlayer !== false ? ' on' : ''}" data-s="lock"></button></div>
          <div class="setting"><div class="txt"><div class="t1">Lock screen preview</div><div class="t2">See what it looks like.</div></div><button class="pillbtn" data-s="lockdemo">Show</button></div>
          <div class="setting"><div class="txt"><div class="t1">Background playback</div><div class="t2">${sys.battery ? 'Unrestricted — Android won’t stop music in the background.' : 'Android may pause music in the background to save battery. Tap Fix and choose <b>Allow</b>.'}</div></div>${sys.battery ? '<span class="ok-dot">✓</span>' : '<button class="pillbtn white" data-s="battery">Fix</button>'}</div>
          <div class="setting"><div class="txt"><div class="t1">Block ads</div><div class="t2">Always on. YouTube Music's ads are removed, and any that slip through are muted and skipped.</div></div><span class="switch on" style="opacity:.5"></span></div>
          <div class="section-title">Listen together</div>
          <div class="setting"><div class="txt"><div class="t1">Room connection</div><div class="t2">Auto tries a direct link and the encrypted relay at once.</div></div><div class="seg-pick">${['auto', 'relay', 'direct'].map((m) => `<button data-tr="${m}" class="${settings.transport === m ? 'on' : ''}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div></div>
          <div class="section-title">About</div>
          <div class="setting"><div class="txt"><div class="t1">Wavelength ${esc(info.version || '')}</div><div class="t2" id="upd-line">Android ${esc(info.android || '')} · ${esc(info.model || '')}</div></div><button class="pillbtn" data-s="update">Check for updates</button></div>
          <div class="setting"><div class="txt"><div class="t1">Playback log</div><div class="t2">Song changes and anything that went wrong. Useful when something acts up.</div></div><button class="pillbtn" data-s="log">View</button></div>
          <div class="setting"><div class="txt"><div class="t1">Website</div><div class="t2">orionvw42.github.io/wavelength</div></div><button class="icon-btn" data-s="site">${I.link}</button></div>`;
        el.onclick = (e) => {
          const tr = e.target.closest('[data-tr]');
          if (tr) { settings.transport = tr.dataset.tr; saveSettings(); session.opts.transport = settings.transport; this.render(el); return; }
          const b = e.target.closest('[data-s]'); if (!b) return;
          const a = b.dataset.s;
          if (a === 'signin') post({ t: 'signin' });
          else if (a === 'signout') menu('<div class="sheet-title">Sign out of YouTube Music?</div>', [[I.logout, 'Sign out', () => post({ t: 'signout' })]]);
          else if (a === 'saver') { settings.dataSaver = !settings.dataSaver; saveSettings(); post({ t: 'setting', dataSaver: settings.dataSaver }); applyVideoMode(); b.classList.toggle('on', settings.dataSaver); }
          else if (a === 'update') checkUpdate(true);
          else if (a === 'lock') { info.lockPlayer = info.lockPlayer === false; post({ t: 'setting', lockPlayer: info.lockPlayer }); b.classList.toggle('on', info.lockPlayer); }
          else if (a === 'lockdemo') post({ t: 'lockDemo' });
          else if (a === 'fixlock') post({ t: 'fixLock' });
          else if (a === 'battery') post({ t: 'fixBattery' });
          else if (a === 'log') showLog();
          else if (a === 'site') post({ t: 'open', url: 'https://orionvw42.github.io/wavelength/' });
        };
      },
    };
  }
  async function showLog() {
    let rows = [];
    try { rows = await call('cmd', 'trackLog'); } catch { /* engine busy */ }
    const why = { prog: 'you / Up Next', auto: 'song ended', user: 'picked in YouTube Music', glitch: 'YouTube Music skipped by itself — recovered' };
    const html = (rows || []).slice().reverse().map((r) => `<div class="log-row"><b>${new Date(r.at).toLocaleTimeString()}</b> · ${esc(why[r.cause] || r.cause)}<br><span>${esc(r.from || '—')} at ${fmt(r.pos)}/${fmt(r.dur)} → ${esc(r.to)}${r.err ? ` · error ${esc(String(r.err.code))}` : ''}</span></div>`).join('')
      || '<div class="log-row">Nothing yet.</div>';
    menu(`<div class="sheet-title">Playback log</div><div class="log">${html}<div class="log-row">Recovered skips this session: ${session.glitches || 0}</div></div>`, []);
  }
  $('#top-account').onclick = () => { if (tab !== 'home' && tab !== 'library') switchTab('library'); push(pageSettings()); };
  $('#top-search').innerHTML = I.search;
  $('#top-search').onclick = () => switchTab('search', true);
  $('#logo').innerHTML = LOGO;
  function renderAccount() {
    $('#top-account').innerHTML = account && account.photo && signedIn ? `<img src="${esc(account.photo)}" alt="">` : `<span class="ph">${I.person}</span>`;
  }

  // ---------------------------------------------------------------- mini player + Now Playing
  const np = $('#np');
  $('#np-close').innerHTML = I.down;
  $('#np-more').innerHTML = I.more;
  $('#np-prev').innerHTML = I.prev;
  $('#np-next').innerHTML = I.next;
  $('#np-shuffle').innerHTML = I.shuffle;
  $('#np-room').innerHTML = I.group;
  $('#mini-next').innerHTML = I.next;
  $('#np-save').innerHTML = `${I.plAdd}<span>Save</span>`;
  $('#np-share').innerHTML = `${I.share}<span>Share</span>`;
  $('#np-radio').innerHTML = `${I.radio}<span>Radio</span>`;

  const curItem = () => {
    const c = session && session.current;
    const p = player;
    if (c && (!p.videoId || c.videoId === p.videoId)) return { ...c, type: 'song', title: c.title || p.title, artist: c.artist || p.artist, art: c.art || p.art };
    return p.videoId ? { videoId: p.videoId, title: p.title, artist: p.artist, art: p.art, type: 'song' } : null;
  };
  const posNow = () => (player.playing ? (player.position || 0) + (Date.now() - (player.t || Date.now())) / 1000 : player.position || 0);
  let videoMode = false;

  // Nothing loaded yet (app just opened): offer the last song again.
  const resumeItem = () => (!player.videoId && session && !session.current ? load('wl.last', null) : null);
  function renderPlayer() {
    let c = curItem();
    if (!c) { const r = resumeItem(); if (r && r.videoId) c = { ...r, title: r.title || 'Pick up where you left off', artist: r.artist || '', type: 'song' }; }
    $('#mini').hidden = !c;
    if (!c) return;
    const art = sized(c.art, 120), big = sized(c.art, 900);
    const mini = $('#mini');
    if ($('.mini-art', mini).getAttribute('src') !== art) $('.mini-art', mini).src = art;
    $('.mini-title', mini).textContent = player.ad ? 'Ad · skipping' : c.title;
    $('.mini-sub', mini).textContent = c.artist + (c.addedBy && c.addedBy.name && session.role !== 'solo' ? ` · added by ${c.addedBy.name}` : '');
    $('#mini-play').innerHTML = player.playing ? I.pause : I.play;
    $('#np-play').innerHTML = player.playing ? I.pause : I.play;
    if ($('#np-art').getAttribute('src') !== big) { $('#np-art').src = big; $('.np-bg').style.backgroundImage = `url("${big}")`; }
    $('#np-title').textContent = c.title;
    $('#np-artist').textContent = c.artist + (c.addedBy && c.addedBy.name && session.role !== 'solo' ? ` · added by ${c.addedBy.name}` : '');
    $('#np-like').innerHTML = `${player.liked ? I.liked : I.like}<span>${player.liked ? 'Liked' : 'Like'}</span>`;
    $('#np-like').classList.toggle('on', !!player.liked);
    $('#np-ad').hidden = !player.ad;
    $('#np-room').classList.toggle('on', session.role !== 'solo');
  }
  function tickProgress() {
    const d = player.duration || 0, p = Math.min(d, posNow());
    const pct = d ? (p / d) * 100 : 0;
    $('.mini-progress i').style.width = pct + '%';
    if (np.classList.contains('open') && !seeking) {
      const r = $('#np-range');
      r.value = d ? Math.round((p / d) * 1000) : 0;
      r.style.setProperty('--p', pct + '%');
      $('#np-pos').textContent = fmt(p);
      $('#np-dur').textContent = fmt(d);
    }
  }
  setInterval(tickProgress, 500);
  let seeking = false;
  $('#np-range').addEventListener('input', (e) => {
    seeking = true;
    const d = player.duration || 0;
    $('#np-pos').textContent = fmt((e.target.value / 1000) * d);
    e.target.style.setProperty('--p', (e.target.value / 10) + '%');
  });
  $('#np-range').addEventListener('change', (e) => {
    const d = player.duration || 0;
    if (d) { const position = (e.target.value / 1000) * d; session.do('seek', { position }); player.position = position; player.t = Date.now(); }
    seeking = false;
  });

  function openNp() {
    if (!curItem() && !session.queue.length && !session.current) return;
    np.classList.add('open');
    np.setAttribute('aria-hidden', 'false');
    document.body.classList.add('np-open');
    renderPlayer(); tickProgress();
    setTimeout(applyVideoMode, 300);
  }
  function closeNp() {
    np.classList.remove('open');
    np.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('np-open');
    closeDrawer();
    post({ t: 'video', rect: null });
  }
  $('#mini').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (resumeItem()) doAction({ name: 'resume' });
    openNp();
  });
  $('#mini-play').onclick = () => { if (resumeItem()) doAction({ name: 'resume' }); else session.do('toggle'); };
  $('#mini-next').onclick = () => session.do('next');
  $('#np-close').onclick = closeNp;
  $('#np-play').onclick = () => session.do('toggle');
  $('#np-prev').onclick = () => session.do('prev');
  $('#np-next').onclick = () => session.do('next');
  $('#np-shuffle').onclick = () => { if (!session.queue.length) { toast('Up Next is empty.'); return; } session.do('shuffle'); toast('Up Next shuffled'); };
  $('#np-room').onclick = () => { closeNp(); switchTab('together'); };
  $('#np-like').onclick = () => { if (!signedIn) { toast('Sign in to like songs.', { button: { label: 'Sign in', run: () => post({ t: 'signin' }) } }); return; } cmd('like'); player.liked = !player.liked; renderPlayer(); };
  $('#np-save').onclick = () => { const c = curItem(); if (!c) return; if (!signedIn) { toast('Sign in to save to playlists.', { button: { label: 'Sign in', run: () => post({ t: 'signin' }) } }); return; } saveToPlaylist([c.videoId], c.title); };
  $('#np-share').onclick = () => { const c = curItem(); if (c) share(c); };
  $('#np-radio').onclick = () => { const c = curItem(); if (c) startRadio(c); };
  $('#np-more').onclick = () => {
    const c = curItem(); if (!c) return;
    const items = [[I.radio, 'Start radio', () => startRadio(c)], [I.share, 'Share', () => share(c)]];
    if (signedIn) items.unshift([I.plAdd, 'Save to playlist', () => saveToPlaylist([c.videoId], c.title)]);
    if (session.queue.length || c) items.push([I.save, 'Save Up Next as a playlist', saveQueue]);
    menu(sheetHead(c), items);
  };
  // Song / Video switch (data saver shows the art; Video shows YouTube's video).
  $('#np-seg').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    videoMode = b.dataset.v === 'video';
    $$('#np-seg button').forEach((x) => x.classList.toggle('on', x === b));
    applyVideoMode();
  };
  function applyVideoMode() {
    const showing = videoMode && np.classList.contains('open') && !$('#np-drawer').classList.contains('open');
    np.classList.toggle('video', showing);
    cmd('setCfg', { dataSaver: videoMode ? false : !!settings.dataSaver });
    if (showing) {
      const r = $('#np-video-hole').getBoundingClientRect();
      post({ t: 'video', rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
    } else post({ t: 'video', rect: null });
  }
  window.addEventListener('resize', () => { if (np.classList.contains('open')) applyVideoMode(); });

  // Swipe the player down to close, the mini player up to open.
  (() => {
    let y0 = null, dy = 0;
    const start = (e) => { y0 = e.touches[0].clientY; dy = 0; };
    np.addEventListener('touchstart', (e) => { if (e.target.closest('#np-drawer, input, .np-actions')) { y0 = null; return; } start(e); }, { passive: true });
    np.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (dy > 0) { np.classList.add('drag'); np.style.transform = `translateY(${dy}px)`; }
    }, { passive: true });
    np.addEventListener('touchend', () => {
      if (y0 == null) return;
      np.classList.remove('drag'); np.style.transform = '';
      if (dy > 110) closeNp();
      else if (dy < -80) openDrawer('queue');
      y0 = null;
    });
    const mini = $('#mini');
    mini.addEventListener('touchstart', start, { passive: true });
    mini.addEventListener('touchmove', (e) => { if (y0 != null) dy = e.touches[0].clientY - y0; }, { passive: true });
    mini.addEventListener('touchend', () => { if (dy < -40) openNp(); y0 = null; });
  })();

  // ---- Up next / lyrics / related drawer
  let drawerTab = 'queue';
  $$('#np-tabs button').forEach((b) => { b.onclick = () => openDrawer(b.dataset.t); });
  $$('#np-drawer .np-tabs button').forEach((b) => { b.onclick = () => openDrawer(b.dataset.t); });
  $('.drawer-head').addEventListener('click', (e) => { if (!e.target.closest('button')) closeDrawer(); });
  function openDrawer(t) {
    drawerTab = t;
    $('#np-drawer').classList.add('open');
    $$('#np-drawer .np-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    applyVideoMode();
    renderDrawer();
  }
  function closeDrawer() { $('#np-drawer').classList.remove('open'); if (np.classList.contains('open')) applyVideoMode(); }
  let lyricsFor = null, relatedFor = null;
  async function renderDrawer() {
    const body = $('#np-drawer-body');
    const c = curItem();
    if (drawerTab === 'queue') {
      const q = session.queue;
      const room = session.role !== 'solo';
      body.innerHTML = `${c ? `<div class="section-title">Now playing${room && session.code ? ` · room ${esc(Session.prettyCode(session.code))}` : ''}</div>${rowHtml(c, { who: room ? c.addedBy : null, noMenu: true, act: 'none' })}` : ''}
        <div class="q-head"><div class="t1">Up next · ${plural(q.length, 'song')}</div>
          <button class="icon-btn" id="q-shuffle" aria-label="Shuffle">${I.shuffle}</button><button class="icon-btn" id="q-save" aria-label="Save">${I.save}</button><button class="icon-btn" id="q-clear" aria-label="Clear">${I.trash}</button></div>
        ${q.length ? q.map((t) => rowHtml({ ...t, type: 'song' }, { act: 'qplay', menuAct: 'qmenu', who: room || (t.addedBy && t.addedBy.id !== me.id) ? t.addedBy : null })).join('')
    : '<div class="empty" style="padding:24px">Up Next is empty. YouTube Music keeps playing similar songs until you add some.<br><br>Tip: long-press any song to add it here.</div>'}`;
      $('#q-shuffle').onclick = () => { if (q.length) { session.do('shuffle'); toast('Up Next shuffled'); } };
      $('#q-save').onclick = saveQueue;
      $('#q-clear').onclick = () => { if (!q.length) return; const copy = q.map(({ uid: u, addedBy, ...t }) => t); session.do('clear'); toast('Up Next cleared', { undo: () => session.do('add', { items: copy, where: 'end' }) }); };
    } else if (drawerTab === 'lyrics') {
      if (!c) { body.innerHTML = '<div class="empty">Nothing playing.</div>'; return; }
      if (lyricsFor && lyricsFor.id === c.videoId && lyricsFor.html) { body.innerHTML = lyricsFor.html; return; }
      body.innerHTML = '<div class="spinner"></div>';
      const id = c.videoId;
      try {
        const l = await ytm('lyrics', id);
        const html = l && l.text ? `<div class="lyrics">${esc(l.text)}<div class="src">${esc(l.source || '')}</div></div>` : '<div class="empty">No lyrics for this song.</div>';
        lyricsFor = { id, html };
        if (drawerTab === 'lyrics' && curItem() && curItem().videoId === id) body.innerHTML = html;
      } catch (e) { body.innerHTML = errorBox(e, renderDrawer); }
    } else {
      if (!c) { body.innerHTML = '<div class="empty">Nothing playing.</div>'; return; }
      if (relatedFor && relatedFor.id === c.videoId) { body.innerHTML = relatedFor.html; return; }
      body.innerHTML = '<div class="spinner"></div>';
      const id = c.videoId;
      try {
        const songs = (await ytm('radio', id)).filter((s) => s.videoId !== id).slice(0, 30).map((s) => ({ ...s, type: 'song' }));
        const html = `<div class="section-title">You might also like · long-press to add</div>${songs.map((s) => rowHtml(s)).join('')}`;
        relatedFor = { id, html };
        if (drawerTab === 'related' && curItem() && curItem().videoId === id) body.innerHTML = html;
      } catch (e) { body.innerHTML = errorBox(e, renderDrawer); }
    }
  }
  async function saveQueue() {
    const c = curItem();
    const items = [c, ...session.queue].filter(Boolean).map(clean);
    if (!items.length) { toast('Nothing to save yet.'); return; }
    const name = await prompt('Save Up Next', 'Playlist name', `${session.role !== 'solo' ? 'Room' : 'Wavelength'} mix ${new Date().toLocaleDateString()}`, 'Save');
    if (!name) return;
    if (signedIn) {
      try { await ytm('createPlaylist', name, items.map((t) => t.videoId)); libraryCache = null; toast(`Saved “${name}” to your YouTube Music playlists`); return; } catch (e) { toast(errText(e) + ' Saved on this phone instead.', { error: true }); }
    } else toast(`Saved “${name}” on this phone`);
    const saved = load('wl.saved', []);
    saved.unshift({ id: uid(), name, items, at: Date.now() });
    save('wl.saved', saved.slice(0, 50));
  }

  // ---------------------------------------------------------------- room pill
  function renderRoomPill() {
    const pill = $('#room-pill');
    const s = session;
    if (s.role === 'solo' && s.status === 'idle') { pill.hidden = true; return; }
    pill.hidden = false;
    pill.classList.toggle('warn', s.status !== 'live');
    pill.innerHTML = `${I.group}<span>${s.status === 'live' ? `${esc(Session.prettyCode(s.code))} · ${s.members.length}` : s.status === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>`;
  }
  $('#room-pill').onclick = () => { closeNp(); switchTab('together'); };

  // ---------------------------------------------------------------- updates
  const newer = (a, b) => { const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); } return false; };
  let updateInfo = null;
  async function checkUpdate(manual) {
    const line = $('#upd-line');
    if (manual && line) line.textContent = 'Checking…';
    try {
      const r = await fetch('https://api.github.com/repos/OrionVW42/wavelength/releases?per_page=15', { headers: { accept: 'application/vnd.github+json' } });
      const rels = await r.json();
      let best = null;
      for (const rel of rels) {
        for (const a of rel.assets || []) {
          const m = /^Wavelength-Android-(\d+\.\d+\.\d+)\.apk$/.exec(a.name);
          if (m && (!best || newer(m[1], best.version))) best = { version: m[1], url: a.browser_download_url, notes: rel.body || '' };
        }
      }
      if (best && newer(best.version, info.version)) {
        updateInfo = best;
        showBanner(`<span class="grow"><b>Wavelength ${esc(best.version)}</b> is ready to install.</span><button class="pill" id="upd-go">Update</button>`, (b) => { $('#upd-go', b).onclick = () => post({ t: 'update', url: best.url, version: best.version }); });
        if (line) line.textContent = `Version ${best.version} is available.`;
      } else if (line) line.textContent = `You're on the newest version (${info.version}).`;
    } catch (e) { if (line) line.textContent = 'Couldn\'t check for updates.'; }
  }
  function showBanner(html, bind) { const b = $('#banner'); b.innerHTML = html; b.hidden = false; if (bind) bind(b); }
  const hideBanner = () => { $('#banner').hidden = true; };

  // ---------------------------------------------------------------- messages from Android
  WLApp.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    switch (m.t) {
      case 'init': start(m); break;
      case 'rpc': {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.v); else p.reject(new Error(m.e));
        break;
      }
      case 'state': {
        if (!m.s) return;
        const prevId = player.videoId;
        player = m.s;
        if (session) session.onPlayer(player);
        renderPlayer();
        if (player.videoId && player.title && !player.ad && lastSaved !== player.videoId + player.title + player.art) {
          lastSaved = player.videoId + player.title + player.art;
          save('wl.last', { videoId: player.videoId, title: player.title, artist: player.artist, art: player.art });
        }
        if (prevId !== player.videoId) {
          if ($('#np-drawer').classList.contains('open') && drawerTab !== 'queue') renderDrawer();
          refreshPlayingRows();
        }
        if (player.signedIn !== undefined && player.signedIn !== signedIn && player.ready) setSignedIn(player.signedIn);
        break;
      }
      case 'event':
        if (!session) return;
        session.onPlayerEvent(m.type, m.data);
        if (m.type === 'track' && m.data && m.data.cause === 'glitch' && session.role !== 'guest') toast('YouTube Music hiccupped — picked your song back up.');
        break;
      case 'action': if (session) doAction(m); break;
      case 'openPlayer': if (session) openNp(); break;
      case 'system':
        sys = { battery: !!m.battery, fullScreen: !!m.fullScreen };
        askPermissions();
        if (stacks[tab] && stacks[tab].length && stacks[tab][stacks[tab].length - 1].settings) showTop();
        break;
      case 'signin': setSignedIn(m.signedIn); break;
      case 'engine':
        if (m.status === 'offline') showBanner(`<span class="grow">Can't reach YouTube Music. ${esc(m.reason || '')}</span><button class="pill" id="eng-retry">Retry</button>`, (b) => { $('#eng-retry', b).onclick = () => { hideBanner(); post({ t: 'reloadEngine' }); }; });
        else if (m.status === 'loaded' && $('#eng-retry')) hideBanner();
        break;
      case 'back': back(); break;
      case 'visible': if (m.on) { renderPlayer(); tickProgress(); } break;
      case 'update':
        if (m.phase === 'downloading') showBanner(`<span class="grow">Downloading Wavelength ${esc(m.version || '')}… ${m.pct || 0}%</span>`);
        else if (m.phase === 'installing') showBanner('<span class="grow">Installing… confirm on the next screen.</span>');
        else if (m.phase === 'failed') { showBanner(`<span class="grow">Update failed: ${esc(m.error || 'unknown error')}</span><button class="pill" id="upd-x">OK</button>`, (b) => { $('#upd-x', b).onclick = hideBanner; }); }
        break;
      default:
    }
  };
  // Once each: the two Android switches that make background play and the
  // lock screen player work (both off by default for sideloaded apps).
  function askPermissions() {
    if (updateInfo || !$('#banner').hidden) return;
    if (!sys.battery && !load('wl.askedBattery', false)) {
      showBanner('<span class="grow"><b>Keep music playing in the background?</b> Let Wavelength run unrestricted so Android never pauses it.</span><button class="pill" id="perm-no">Not now</button><button class="pill white" id="perm-go">Allow</button>', (b) => {
        $('#perm-go', b).onclick = () => { save('wl.askedBattery', true); hideBanner(); post({ t: 'fixBattery' }); };
        $('#perm-no', b).onclick = () => { save('wl.askedBattery', true); hideBanner(); };
      });
    } else if (!sys.fullScreen && info.lockPlayer !== false && !load('wl.askedLock', false)) {
      showBanner('<span class="grow"><b>Big player on the lock screen?</b> Turn on “full screen notifications” for Wavelength.</span><button class="pill" id="perm-no">Not now</button><button class="pill white" id="perm-go">Turn on</button>', (b) => {
        $('#perm-go', b).onclick = () => { save('wl.askedLock', true); hideBanner(); post({ t: 'fixLock' }); };
        $('#perm-no', b).onclick = () => { save('wl.askedLock', true); hideBanner(); };
      });
    }
  }
  // From the notification, lock screen, widget, headphones, Bluetooth, car.
  function doAction(m) {
    const n = m.name;
    if (n === 'seek') session.do('seek', { position: m.arg });
    else if (n === 'like') { if (signedIn) { cmd('like'); player.liked = !player.liked; renderPlayer(); } }
    else if (n === 'radio') { const c = curItem(); if (c) startRadio(c); }
    else if (n === 'playNow') session.do('playNow', { uid: m.uid });
    else if (n === 'resume') {
      // Opened from the widget's play button: carry on where we left off.
      const last = resumeItem();
      if (last && last.videoId) session.do('add', { items: [last], where: 'now' });
      else session.do('play');
    } else session.do(n);
  }
  function refreshPlayingRows() {
    $$('.row.playing').forEach((r) => r.classList.remove('playing'));
    if (!player.videoId) return;
    for (const r of $$('.row[data-k]')) { const it = reg.get(r.dataset.k); if (it && it.videoId === player.videoId) r.classList.add('playing'); }
  }
  function setSignedIn(v) {
    if (v === signedIn) return;
    signedIn = v;
    libraryCache = null;
    account = null;
    renderAccount();
    if (v) { ytm('account').then((a) => { account = a; renderAccount(); }).catch(() => {}); toast('Signed in to YouTube Music'); }
    // Refresh pages that depend on it.
    for (const t of ['home', 'library']) for (const p of stacks[t]) p.rendered = false;
    if (tab === 'home' || tab === 'library') showTop();
  }

  // ---------------------------------------------------------------- start
  function start(m) {
    if (session) return;
    info = m;
    signedIn = !!m.signedIn;
    if (!me.name) me.name = '';
    session = new Session(api, me, { peerServer: settings.peerServer, transport: settings.transport });
    window.__session = session;
    session.restore(load('wl.session', null));
    session.on((kind, data) => {
      if (kind === 'toast') toast(data.msg, data);
      if (kind === 'change' || kind === 'members') {
        renderPlayer();
        renderRoomPill();
        if ($('#np-drawer').classList.contains('open') && drawerTab === 'queue') renderDrawer();
        if (tab === 'together' && stacks.together.length === 1) renderTogether(stacks.together[0].el);
      }
    });
    renderAccount();
    if (signedIn) ytm('account').then((a) => { account = a; renderAccount(); }).catch(() => {});
    switchTab('home');
    renderPlayer();
    renderRoomPill();
    if (!m.debug) setTimeout(() => checkUpdate(false), 8000);
  }
  post({ t: 'hello' });
  window.__wlDebug = { get player() { return player; }, get session() { return session; }, ytm, openNp, switchTab, push, pageBrowse };
})();
