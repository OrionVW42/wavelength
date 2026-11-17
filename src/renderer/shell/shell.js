/* global ICONS, LOGO, Session, renderSettings */
(async () => {
  const api = window.wl;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (sec) => {
    sec = Math.max(0, Math.round(+sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const fmtTotal = (sec) => { const m = Math.round(sec / 60); return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`; };
  const initial = (n) => (String(n || '?').trim()[0] || '?').toUpperCase();

  // ------------------------------------------------------------ static icons
  $('#logo').innerHTML = LOGO;
  $('#loading-logo').innerHTML = LOGO;
  $('#nav-back').innerHTML = ICONS.back;
  $('#nav-home').innerHTML = ICONS.home;
  $('#btn-mini').innerHTML = ICONS.mini;
  $('#btn-settings').innerHTML = ICONS.settings;
  $('#btn-panel .ic').innerHTML = ICONS.queue;
  $('#add-ic').innerHTML = ICONS.search;
  $('#add-clear').innerHTML = ICONS.close;
  $('#btn-add-current').innerHTML = `${ICONS.plus}<span>Add what's playing</span>`;
  $('#btn-library').innerHTML = `${ICONS.library}<span>From your library</span>`;
  $('#btn-shuffle').innerHTML = ICONS.shuffle;
  $('#btn-save').innerHTML = ICONS.save;
  $('#btn-clear').innerHTML = ICONS.trash;
  document.querySelector('#history .ic-chev').innerHTML = ICONS.chevron;

  // ------------------------------------------------------------ state
  let settings = await api.getSettings();
  const me = { id: settings.id, name: settings.name, color: settings.color };
  const session = new Session(api, me, { peerServer: settings.peerServer });
  window.__session = session; // handy for debugging / tests
  let player = {};
  let panelOpen = settings.panelOpen !== false;
  let settingsOpen = false;
  let searchSeq = 0;

  session.restore(await api.sessionState());

  // ------------------------------------------------------------ toasts
  let toastT = null;
  function toast(msg, opts = {}) {
    const el = $('#toast');
    el.className = 'toast show' + (opts.error ? ' error' : '');
    el.innerHTML = `<span>${esc(msg)}</span>`;
    if (opts.action === 'resync') {
      const b = document.createElement('button'); b.textContent = 'Re-sync';
      b.onclick = () => { session.setSync(true); hideToast(); };
      el.appendChild(b);
    } else if (opts.action === 'unsync') {
      const b = document.createElement('button'); b.textContent = 'Leave sync';
      b.onclick = () => { session.setSync(false); hideToast(); };
      el.appendChild(b);
    }
    clearTimeout(toastT);
    toastT = setTimeout(hideToast, opts.error ? 6500 : opts.action ? 7000 : 3200);
  }
  function hideToast() { $('#toast').classList.remove('show'); }
  api.onToast((t) => toast(t.msg, t));

  // ------------------------------------------------------------ layout
  function applyLayout() {
    document.body.classList.toggle('no-panel', !panelOpen || settingsOpen);
    $('#btn-panel').classList.toggle('on', panelOpen && !settingsOpen);
    $('#btn-settings').classList.toggle('on', settingsOpen);
    $('#settings').hidden = !settingsOpen;
    api.layout({ panel: panelOpen && !settingsOpen ? 380 : 0, hideYtm: settingsOpen });
  }
  $('#btn-panel').onclick = () => { panelOpen = !panelOpen; if (settingsOpen) { settingsOpen = false; panelOpen = true; } applyLayout(); };
  $('#btn-settings').onclick = () => { settingsOpen = !settingsOpen; if (settingsOpen) openSettings(); applyLayout(); };
  $('#btn-mini').onclick = () => api.action('toggleMini');
  $('#nav-back').onclick = () => api.player('back');
  $('#nav-home').onclick = () => { if (settingsOpen) { settingsOpen = false; applyLayout(); } api.browse('FEmusic_home'); };
  $('#btn-retry').onclick = () => api.reloadYtm();
  $('#room-pill').onclick = () => { panelOpen = true; settingsOpen = false; switchTab('session'); applyLayout(); };
  applyLayout();

  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $('#tab-session').hidden = name !== 'session';
    $('#tab-saved').hidden = name !== 'saved';
    if (name === 'saved') renderSaved();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal').hidden) { closeModal(); return; }
      if (settingsOpen && !document.querySelector('.kbd-btn.rec')) { settingsOpen = false; applyLayout(); }
      if (document.activeElement === $('#add-input')) { clearSearch(); $('#add-input').blur(); }
    }
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); panelOpen = true; applyLayout(); switchTab('session'); $('#add-input').focus(); }
  });

  // ------------------------------------------------------------ player feed
  api.onPlayerState((s) => {
    player = s;
    session.onPlayer(s);
    if (s.ready) $('#ytm-loading').hidden = true;
    renderNpProgress();
  });
  api.onPlayerEvent((type, data) => session.onPlayerEvent(type, data));
  api.onAction((name, arg) => {
    if (name === 'seek') session.do('seek', { position: arg });
    else session.do(name);
  });
  api.onUi((u) => {
    if ('offline' in u) {
      $('#ytm-offline').hidden = !u.offline;
      $('#ytm-loading').hidden = !!u.offline || !!player.ready;
      if (u.reason) $('#offline-reason').textContent = `Check your internet connection. (${u.reason})`;
    }
  });
  api.onSettings((s) => { settings = s; me.name = s.name; me.color = s.color; session.opts.peerServer = s.peerServer; });
  api.onSessionAdd((req) => handleAddRequest(req));

  session.on((kind, data) => {
    if (kind === 'toast') toast(data.msg, data);
    else if (kind === 'members') renderRoom();
    else if (kind === 'change') renderAll();
  });

  // ------------------------------------------------------------ adding
  const addedToast = (items, where) => {
    if (!items.length) return;
    const what = items.length === 1 ? `“${items[0].title}”` : `${items.length} songs`;
    toast(where === 'next' ? `${what} plays next` : `Added ${what} to Up Next`);
  };
  async function addVideoIds(ids, where) {
    const known = new Map([...(lastResults || [])].map((r) => [r.videoId, r]));
    const items = (await Promise.all(ids.map((id) => known.get(id) || api.ytm('resolve', id).catch(() => null)))).filter(Boolean);
    if (!items.length) { toast('Couldn\'t find that song.', { error: true }); return; }
    session.do('add', { items, where });
    addedToast(items, where);
  }
  async function addList(listId, where = 'end', shuffle = false) {
    toast('Loading songs…');
    try {
      let songs = await api.ytm('playlist', listId);
      if (!songs.length) { toast('That playlist is empty or private.', { error: true }); return; }
      if (shuffle) songs = shuffled(songs);
      session.do('add', { items: songs, where });
      addedToast(songs, where);
    } catch (e) { toast(cleanErr(e), { error: true }); }
  }
  const shuffled = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const cleanErr = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  function handleAddRequest(req) {
    panelOpen = true; applyLayout();
    if (req.videoIds) addVideoIds(req.videoIds, req.where);
    else if (req.listId) addList(req.listId, req.where, req.shuffle);
  }

  $('#btn-add-current').onclick = () => {
    if (!player.videoId) { toast('Nothing is playing yet.'); return; }
    const item = { videoId: player.videoId, title: player.title, artist: player.artist, art: player.art, duration: player.duration };
    session.do('add', { items: [item], where: 'end' });
    addedToast([item], 'end');
  };

  // ------------------------------------------------------------ search
  let lastResults = [];
  let searchT = null;
  const input = $('#add-input');
  function parseLink(text) {
    const t = text.trim();
    if (!/^(https?:\/\/|www\.|music\.|youtu)/i.test(t)) {
      if (/^[\w-]{11}$/.test(t) && /\d/.test(t) && /[A-Z]/.test(t)) return { videoId: t };
      return null;
    }
    try {
      const u = new URL(/^https?:/i.test(t) ? t : 'https://' + t);
      if (/youtu\.be$/.test(u.hostname)) return { videoId: u.pathname.slice(1, 12) };
      const v = u.searchParams.get('v'), list = u.searchParams.get('list');
      if (v) return { videoId: v, listId: list };
      if (list) return { listId: list };
      const b = u.pathname.match(/\/browse\/([\w-]+)/);
      if (b) return { listId: b[1] };
    } catch { /* not a link */ }
    return null;
  }
  function clearSearch() { input.value = ''; $('#results').hidden = true; $('#add-clear').hidden = true; lastResults = []; }
  $('#add-clear').onclick = () => { clearSearch(); input.focus(); };
  input.addEventListener('input', () => {
    $('#add-clear').hidden = !input.value;
    clearTimeout(searchT);
    if (!input.value.trim()) { $('#results').hidden = true; return; }
    searchT = setTimeout(runSearch, 320);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchT);
      if (lastResults.length && lastResults.query === input.value.trim()) { addVideoIds([lastResults[0].videoId], e.shiftKey ? 'next' : 'end'); }
      else runSearch(true);
    }
  });
  async function runSearch(addFirst) {
    const q = input.value.trim();
    if (!q) return;
    const seq = ++searchSeq;
    const box = $('#results');
    box.hidden = false;
    box.innerHTML = '<div class="spinner"></div>';
    const link = parseLink(q);
    try {
      let results = [];
      let listNote = '';
      if (link && link.videoId) results = [await api.ytm('resolve', link.videoId)];
      if (link && link.listId) listNote = link.listId;
      if (!link) results = await api.ytm('search', q);
      if (seq !== searchSeq) return;
      lastResults = results; lastResults.query = q;
      if (addFirst && results[0]) { addVideoIds([results[0].videoId], 'end'); }
      box.innerHTML = (listNote ? `<div class="track"><div class="ph" style="display:grid;place-items:center">${ICONS.library}</div><div class="meta"><div class="t">Playlist / album link</div><div class="a">Add every song from it</div></div><div class="acts" style="display:flex"><button class="icon-btn small" data-list="${esc(listNote)}" data-where="end" title="Add all to Up Next">${ICONS.plus}</button><button class="icon-btn small" data-list="${esc(listNote)}" data-shuffle="1" title="Shuffle in">${ICONS.shuffle}</button></div></div>` : '')
        + (results.length ? results.map(resultRow).join('') : (listNote ? '' : '<div class="note">No songs found.</div>'));
    } catch (e) {
      if (seq !== searchSeq) return;
      box.innerHTML = `<div class="note">${esc(cleanErr(e))}</div>`;
    }
  }
  function resultRow(r) {
    return `<div class="track" data-vid="${esc(r.videoId)}">
      ${r.art ? `<img src="${esc(r.art)}" loading="lazy" alt="">` : '<div class="ph"></div>'}
      <div class="meta"><div class="t">${esc(r.title)}</div><div class="a">${r.kind && r.kind !== 'Song' ? esc(r.kind) + ' · ' : ''}${esc(r.artist)}</div></div>
      <span class="dur">${r.duration ? fmt(r.duration) : ''}</span>
      <div class="acts">
        <button class="icon-btn small" data-add="next" title="Play next">${ICONS.playNext}</button>
        <button class="icon-btn small" data-add="end" title="Add to Up Next">${ICONS.plus}</button>
      </div></div>`;
  }
  $('#results').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.list) { addList(b.dataset.list, 'end', !!b.dataset.shuffle); return; }
    const row = b.closest('[data-vid]');
    if (row && b.dataset.add) addVideoIds([row.dataset.vid], b.dataset.add);
  });

  // ------------------------------------------------------------ render
  function renderAll() {
    renderRoom();
    renderNp();
    renderQueue();
    renderHistory();
    renderTitlebar();
  }

  function renderTitlebar() {
    const pill = $('#room-pill');
    if (session.role === 'solo' && session.status === 'idle') { pill.hidden = true; }
    else {
      pill.hidden = false;
      const warn = session.status !== 'live';
      pill.classList.toggle('warn', warn);
      const label = session.status === 'connecting' ? 'Connecting…' : session.status === 'reconnecting' ? 'Reconnecting…'
        : `${Session.prettyCode(session.code)} · ${session.members.length} listening`;
      pill.innerHTML = `<span class="dot"></span>${esc(label)}`;
    }
    const n = session.queue.length;
    $('#queue-badge').hidden = !n;
    $('#queue-badge').textContent = n > 99 ? '99+' : n;
  }

  function memberRow(m) {
    const you = m.id === me.id;
    const np = m.np;
    const npLine = np
      ? `${np.playing ? '<span class="eq"><i></i><i></i><i></i></span>' : ''}${esc(np.title)}${np.artist ? ' — ' + esc(np.artist) : ''}`
      : 'Not playing';
    return `<div class="member">
      <div class="avatar" style="background:${esc(m.color)}">${esc(initial(m.name))}${m.isHost ? `<span class="crown" title="Host">${ICONS.crown}</span>` : ''}</div>
      <div class="m-meta">
        <div class="m-name">${esc(m.name)}${you ? '<span class="tag">you</span>' : ''}${!m.isHost && m.sync === false ? '<span class="tag">solo</span>' : ''}</div>
        <div class="m-np">${npLine}</div>
      </div></div>`;
  }

  function renderRoom() {
    const card = $('#room-card');
    const s = session;
    card.classList.toggle('solo', s.role === 'solo');
    if (s.role === 'solo' && s.status === 'idle') {
      const prevCode = $('#join-code')?.value || '';
      card.innerHTML = `
        <div class="room-title">${ICONS.users}Listen together</div>
        <div class="room-sub">Start a room and send friends the code. Everyone hears the same songs at the same moment, and anyone can add to Up Next.</div>
        <button class="btn primary" id="room-host" style="width:100%">Start a room</button>
        <div class="join-row"><input class="input" id="join-code" placeholder="Have a code? e.g. K7Q-M2X" maxlength="16" spellcheck="false" value="${esc(prevCode)}"><button class="btn" id="room-join">Join</button></div>`;
      $('#room-host').onclick = () => session.host();
      const join = () => session.join($('#join-code').value);
      $('#room-join').onclick = join;
      $('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
      return;
    }
    if (s.status === 'connecting') {
      card.innerHTML = `<div class="room-title">${ICONS.users}${s.code ? `Joining ${esc(Session.prettyCode(s.code))}…` : 'Opening your room…'}</div>
        <div class="spinner"></div><div class="room-actions"><button class="btn small" id="room-cancel">Cancel</button></div>`;
      $('#room-cancel').onclick = () => session.leave(true);
      return;
    }
    const host = s.members.find((m) => m.isHost);
    const warn = s.status !== 'live';
    const stateText = warn ? 'Reconnecting to the room…' : s.role === 'host' ? 'Live · you\'re the host' : `Live · hosted by ${esc(host ? host.name : 'host')}`;
    card.innerHTML = `
      <div class="room-state ${warn ? 'warn' : ''}"><span class="dot"></span>${stateText}</div>
      <div class="code-row"><span class="code">${esc(Session.prettyCode(s.code))}</span>
        <button class="btn small" id="copy-code">${ICONS.copy}Copy invite</button></div>
      <div class="members">${s.members.map(memberRow).join('')}</div>
      <div class="room-opts">
        ${s.role === 'host'
          ? `<label class="opt"><span>Guests can control playback</span><span class="switch"><input type="checkbox" id="opt-guests" ${s.guestsControl ? 'checked' : ''}><span></span></span></label>`
          : `<label class="opt"><span>Listen in sync with the room</span><span class="switch"><input type="checkbox" id="opt-sync" ${s.sync ? 'checked' : ''}><span></span></span></label>
             ${!s.guestsControl ? '<div class="muted" style="font-size:12px">The host has locked playback controls. You can still add songs.</div>' : ''}`}
      </div>
      <div class="room-actions">
        ${s.role === 'guest' && s.sync ? `<button class="btn small" id="room-resync">${ICONS.sync}Re-sync</button>` : ''}
        <button class="btn small danger" id="room-leave">${ICONS.door}${s.role === 'host' ? 'End room' : 'Leave'}</button>
      </div>`;
    $('#copy-code').onclick = () => {
      api.copy(`Join my Wavelength room! Code: ${Session.prettyCode(s.code)}`);
      toast('Invite copied. Paste it to your friends.');
    };
    $('#room-leave').onclick = () => session.leave();
    const g = $('#opt-guests'); if (g) g.onchange = () => session.setGuestsControl(g.checked);
    const y = $('#opt-sync'); if (y) y.onchange = () => session.setSync(y.checked);
    const r = $('#room-resync'); if (r) r.onclick = () => { session._lastSeek = 0; session._loading = null; session._syncCheck(true); toast('Re-synced with the room.'); };
  }

  function byChip(by) {
    if (!by) return '';
    const mine = by.id === me.id;
    return `<span class="by ${mine ? 'me' : ''}"><i style="background:${esc(by.color)}"></i>${mine ? 'You' : esc(by.name)}</span>`;
  }

  function renderNp() {
    const c = session.current;
    const np = $('#np');
    if (!c && !player.videoId) { np.hidden = true; return; }
    np.hidden = false;
    const title = c ? c.title : player.title, artist = c ? c.artist : player.artist, art = (c && c.art) || player.art;
    $('#np-title').textContent = title || '—';
    $('#np-artist').textContent = artist || '';
    if (art && $('#np-art').getAttribute('src') !== art) $('#np-art').src = art;
    $('#np-label').innerHTML = `Now playing ${c && c.addedBy ? byChip(c.addedBy) : ''}`;
    renderNpProgress();
  }
  function renderNpProgress() {
    const d = player.duration || 0;
    $('#np-fill').style.width = d ? `${Math.min(100, (player.position / d) * 100)}%` : '0';
    if (session.current && player.videoId === session.current.videoId && $('#np').hidden) renderNp();
  }

  function trackRow(t, i, { draggable = true, history = false } = {}) {
    const canRemove = session.role !== 'guest' || session.guestsControl || (t.addedBy && t.addedBy.id === me.id);
    return `<li class="track" data-uid="${esc(t.uid)}" data-i="${i}" ${draggable ? 'draggable="true"' : ''}>
      ${draggable ? `<span class="grip">${ICONS.grip}</span>` : ''}
      ${t.art ? `<img src="${esc(t.art)}" loading="lazy" alt="">` : '<div class="ph"></div>'}
      <div class="meta"><div class="t">${esc(t.title)}</div><div class="a">${byChip(t.addedBy)}<span>${esc(t.artist)}</span></div></div>
      <span class="dur">${t.duration ? fmt(t.duration) : ''}</span>
      <div class="acts">
        ${history
          ? `<button class="icon-btn small" data-act="requeue" title="Add to Up Next again">${ICONS.plus}</button>`
          : `<button class="icon-btn small" data-act="play" title="Play now">${ICONS.play}</button>
             ${canRemove ? `<button class="icon-btn small" data-act="remove" title="Remove">${ICONS.close}</button>` : ''}`}
      </div></li>`;
  }

  function renderQueue() {
    const q = session.queue;
    $('#queue').innerHTML = q.map((t, i) => trackRow(t, i, { draggable: session.role !== 'guest' || session.guestsControl })).join('');
    $('#queue-empty').hidden = q.length > 0;
    const total = q.reduce((n, t) => n + (t.duration || 0), 0);
    $('#queue-meta').textContent = q.length ? `${q.length} song${q.length === 1 ? '' : 's'}${total ? ' · ' + fmtTotal(total) : ''}` : '';
    const lockedForMe = session.role === 'guest' && !session.guestsControl;
    $('#btn-shuffle').disabled = !q.length || lockedForMe;
    $('#btn-clear').disabled = !q.length || lockedForMe;
  }
  function renderHistory() {
    const h = session.history.slice().reverse();
    $('#history').hidden = !h.length;
    $('#history-meta').textContent = h.length ? `· ${h.length}` : '';
    $('#history-list').innerHTML = h.map((t, i) => trackRow(t, i, { draggable: false, history: true })).join('');
  }

  $('#queue').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const uidv = b.closest('.track').dataset.uid;
    if (b.dataset.act === 'play') session.do('playNow', { uid: uidv });
    if (b.dataset.act === 'remove') session.do('remove', { uid: uidv });
  });
  $('#queue').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.track'); if (row && !e.target.closest('button')) session.do('playNow', { uid: row.dataset.uid });
  });
  $('#history-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act="requeue"]'); if (!b) return;
    const t = session.history.find((x) => x.uid === b.closest('.track').dataset.uid);
    if (t) { session.do('add', { items: [t], where: 'end' }); addedToast([t], 'end'); }
  });

  // Drag to reorder Up Next.
  let dragUid = null;
  const qEl = $('#queue');
  qEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.track'); if (!row) return;
    dragUid = row.dataset.uid; row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragUid);
  });
  const clearDrop = () => qEl.querySelectorAll('.drop-before,.drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  qEl.addEventListener('dragover', (e) => {
    if (!dragUid) return;
    e.preventDefault();
    const row = e.target.closest('.track'); clearDrop();
    if (!row || row.dataset.uid === dragUid) return;
    const r = row.getBoundingClientRect();
    row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  qEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const row = qEl.querySelector('.drop-before, .drop-after');
    if (row && dragUid) {
      const from = session.queue.findIndex((t) => t.uid === dragUid);
      let to = +row.dataset.i + (row.classList.contains('drop-after') ? 1 : 0);
      if (from < to) to -= 1;
      if (from !== to) session.do('move', { uid: dragUid, to });
    }
    clearDrop();
  });
  qEl.addEventListener('dragend', () => { dragUid = null; clearDrop(); qEl.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging')); });

  $('#btn-shuffle').onclick = () => { session.do('shuffle'); toast('Shuffled Up Next.'); };
  let clearArmed = false;
  $('#btn-clear').onclick = () => {
    if (!clearArmed) { clearArmed = true; toast('Click the bin again to clear Up Next.'); setTimeout(() => { clearArmed = false; }, 3000); return; }
    clearArmed = false; session.do('clear'); toast('Up Next cleared.');
  };

  // ------------------------------------------------------------ modals
  function openModal(html) { $('#modal-card').innerHTML = html; $('#modal').hidden = false; }
  function closeModal() { $('#modal').hidden = true; $('#modal-card').innerHTML = ''; }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });

  function sessionTracks(includePlayed) {
    const list = [];
    if (includePlayed) list.push(...session.history);
    if (session.current) list.push(session.current);
    list.push(...session.queue);
    return list.map((t) => ({ videoId: t.videoId, title: t.title, artist: t.artist, art: t.art, duration: t.duration }));
  }

  function openSave() {
    const hasHistory = session.history.length > 0;
    const count = sessionTracks(true).length;
    if (!count) { toast('Nothing to save yet. Play or queue some songs first.'); return; }
    const d = new Date();
    const def = `${session.role === 'solo' ? 'Session' : 'Room ' + Session.prettyCode(session.code)} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    openModal(`<h3>Save as playlist</h3>
      <div class="muted">Saves what's playing and everything in Up Next${hasHistory ? ', plus what you already played if you like' : ''}.</div>
      <input class="input" id="save-name" style="margin-top:12px" value="${esc(def)}" maxlength="100">
      ${hasHistory ? '<label class="check"><input type="checkbox" id="save-played" checked> Include songs already played</label>' : ''}
      <label class="check"><input type="checkbox" id="save-ytm" ${player.signedIn ? '' : 'disabled'}> Also create it in my YouTube Music library${player.signedIn ? '' : ' (sign in first)'}</label>
      <div class="muted" id="save-count" style="margin-top:8px"></div>
      <div class="row"><button class="btn" id="save-cancel">Cancel</button><button class="btn primary" id="save-go">Save</button></div>`);
    const countEl = $('#save-count');
    const upd = () => { countEl.textContent = `${sessionTracks($('#save-played') ? $('#save-played').checked : false).length} songs`; };
    upd(); if ($('#save-played')) $('#save-played').onchange = upd;
    const name = $('#save-name'); name.focus(); name.select();
    $('#save-cancel').onclick = closeModal;
    const go = async () => {
      const tracks = sessionTracks($('#save-played') ? $('#save-played').checked : false);
      const nm = name.value.trim() || def;
      await api.saved('save', { name: nm, tracks });
      const toYtm = $('#save-ytm').checked;
      closeModal();
      toast(`Saved “${nm}”`);
      renderSaved();
      if (toYtm) exportToYtm(nm, tracks);
    };
    $('#save-go').onclick = go;
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
  $('#btn-save').onclick = openSave;
  $('#btn-save-2').onclick = openSave;

  async function exportToYtm(name, tracks) {
    toast('Creating the playlist in YouTube Music…');
    try {
      const id = await api.ytm('createPlaylist', name, tracks.map((t) => t.videoId));
      toast(`“${name}” is now in your YouTube Music library.`);
      return id;
    } catch (e) { toast(cleanErr(e), { error: true }); return null; }
  }

  $('#btn-library').onclick = async () => {
    openModal(`<h3>Your YouTube Music library</h3><div class="muted">Add a whole playlist to Up Next.</div><div class="lib-list" id="lib-list"><div class="spinner"></div></div>
      <div class="row"><button class="btn" id="lib-close">Close</button></div>`);
    $('#lib-close').onclick = closeModal;
    try {
      const pls = await api.ytm('library');
      const list = $('#lib-list'); if (!list) return;
      if (!player.signedIn || !pls.length) {
        list.innerHTML = `<div class="empty"><div class="empty-title">${player.signedIn ? 'No playlists yet' : 'You\'re not signed in'}</div>
          <div class="muted">${player.signedIn ? 'Make some in YouTube Music and they\'ll show up here.' : 'Use the Sign in button at the top right of YouTube Music to see your playlists and liked songs.'}</div></div>`;
        return;
      }
      list.innerHTML = pls.map((p) => `<div class="lib-item" data-id="${esc(p.id)}">
        ${p.art ? `<img src="${esc(p.art)}" alt="">` : `<div class="ph">${ICONS.heartFill}</div>`}
        <div class="meta" style="flex:1;min-width:0"><div class="t" style="font-weight:600">${esc(p.title)}</div><div class="a muted" style="font-size:12px">${esc(p.subtitle)}</div></div>
        <button class="icon-btn small" data-op="add" title="Add all to Up Next">${ICONS.plus}</button>
        <button class="icon-btn small" data-op="shuffle" title="Shuffle into Up Next">${ICONS.shuffle}</button>
        <button class="icon-btn small" data-op="open" title="Open in YouTube Music">${ICONS.expand}</button></div>`).join('');
      list.onclick = (e) => {
        const b = e.target.closest('button[data-op]'); if (!b) return;
        const id = b.closest('.lib-item').dataset.id;
        if (b.dataset.op === 'open') { closeModal(); api.browse('VL' + id); return; }
        closeModal();
        addList(id, 'end', b.dataset.op === 'shuffle');
      };
    } catch (e) {
      const list = $('#lib-list'); if (list) list.innerHTML = `<div class="empty muted">${esc(cleanErr(e))}</div>`;
    }
  };

  // ------------------------------------------------------------ saved playlists
  const expanded = new Set();
  const armedDelete = new Set();
  async function renderSaved() {
    const list = await api.saved('list');
    $('#saved-empty').hidden = list.length > 0;
    const guest = session.role === 'guest';
    $('#saved-list').innerHTML = list.map((p) => {
      const arts = p.tracks.map((t) => t.art).filter(Boolean).slice(0, 4);
      const cover = arts.length >= 4 ? `<div class="pl-cover">${arts.map((a) => `<img src="${esc(a)}" alt="">`).join('')}</div>`
        : `<div class="pl-cover one">${arts[0] ? `<img src="${esc(arts[0])}" alt="">` : ''}</div>`;
      const dur = p.tracks.reduce((n, t) => n + (t.duration || 0), 0);
      const open = expanded.has(p.id);
      return `<div class="pl" data-id="${esc(p.id)}">
        <div class="pl-head" data-op="toggle">${cover}<div class="pl-meta"><div class="pl-name">${esc(p.name)}</div>
          <div class="pl-sub">${p.tracks.length} songs${dur ? ' · ' + fmtTotal(dur) : ''} · ${new Date(p.updatedAt).toLocaleDateString()}</div></div></div>
        <div class="pl-actions">
          <button class="btn small primary" data-op="play">${ICONS.play}${guest ? 'Add to room' : 'Play'}</button>
          <button class="btn small" data-op="queue">${ICONS.plus}Up Next</button>
          <button class="btn small" data-op="ytm" title="Create in your YouTube Music library">${ICONS.upload}YouTube Music</button>
          <button class="btn small" data-op="rename" title="Rename">${ICONS.edit}</button>
          <button class="btn small danger" data-op="delete" title="Delete">${armedDelete.has(p.id) ? 'Confirm' : ICONS.trash}</button>
        </div>
        ${open ? `<ol class="tracks pl-tracks">${p.tracks.map((t, i) => trackRow({ ...t, uid: String(i) }, i, { draggable: false, history: true })).join('')}</ol>` : ''}
      </div>`;
    }).join('');
    $('#saved-list').onclick = async (e) => {
      const el = e.target.closest('[data-op]'); if (!el) return;
      const card = el.closest('.pl'); const p = list.find((x) => x.id === card.dataset.id); if (!p) return;
      const op = el.dataset.op;
      if (op === 'toggle') { expanded.has(p.id) ? expanded.delete(p.id) : expanded.add(p.id); renderSaved(); return; }
      if (op === 'requeue') { const t = p.tracks[+el.closest('.track').dataset.i]; session.do('add', { items: [t], where: 'end' }); addedToast([t], 'end'); return; }
      if (op === 'play') {
        if (session.role === 'guest') { session.do('add', { items: p.tracks, where: 'end' }); addedToast(p.tracks, 'end'); }
        else { session.do('replace', { items: p.tracks }); toast(`Playing “${p.name}”`); }
        switchTab('session');
      }
      if (op === 'queue') { session.do('add', { items: p.tracks, where: 'end' }); addedToast(p.tracks, 'end'); }
      if (op === 'ytm') exportToYtm(p.name, p.tracks);
      if (op === 'rename') {
        openModal(`<h3>Rename playlist</h3><input class="input" id="rn" style="margin-top:12px" value="${esc(p.name)}" maxlength="100">
          <div class="row"><button class="btn" id="rn-c">Cancel</button><button class="btn primary" id="rn-go">Save</button></div>`);
        const inp = $('#rn'); inp.focus(); inp.select();
        const go = async () => { await api.saved('save', { ...p, name: inp.value.trim() || p.name }); closeModal(); renderSaved(); };
        $('#rn-go').onclick = go; $('#rn-c').onclick = closeModal;
        inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
      }
      if (op === 'delete') {
        if (!armedDelete.has(p.id)) { armedDelete.add(p.id); renderSaved(); setTimeout(() => { armedDelete.delete(p.id); renderSaved(); }, 3000); return; }
        armedDelete.delete(p.id); await api.saved('delete', p.id); toast(`Deleted “${p.name}”`); renderSaved();
      }
    };
    // Re-queue buttons inside expanded saved lists reuse the history row markup.
    $('#saved-list').querySelectorAll('button[data-act="requeue"]').forEach((b) => { b.dataset.op = 'requeue'; });
  }

  // ------------------------------------------------------------ settings
  async function openSettings() {
    settings = await api.getSettings();
    renderSettings($('#settings'), settings, api, {
      onSaved: (s) => {
        settings = s; me.name = s.name; me.color = s.color; session.opts.peerServer = s.peerServer;
        if (session.role === 'host') {
          const self = session.members.find((m) => m.id === me.id);
          if (self) { self.name = s.name; self.color = s.color; session.changed(); }
        }
      },
      toast,
    });
  }

  renderAll();
  api.sessionSummary(session.summary());
})();
