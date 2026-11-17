/* global ICONS, LOGO */
(() => {
  const api = window.wl;
  const $ = (s) => document.querySelector(s);
  const fmt = (sec) => { sec = Math.max(0, Math.floor(+sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  $('#b-prev').innerHTML = ICONS.prev;
  $('#b-next').innerHTML = ICONS.next;
  $('#b-play').innerHTML = ICONS.play;
  $('#b-like').innerHTML = ICONS.heart;
  $('#b-search').innerHTML = ICONS.search;
  $('#b-full').innerHTML = ICONS.expand;
  $('#b-close').innerHTML = ICONS.close;
  $('#s-ic').innerHTML = ICONS.search;
  $('#s-close').innerHTML = ICONS.close;
  $('#art-ph').innerHTML = LOGO;

  let s = {}, recvAt = 0, summary = null, lastTitle = null;

  $('#b-play').onclick = () => api.action('toggle');
  $('#b-next').onclick = () => api.action('next');
  $('#b-prev').onclick = () => api.action('prev');
  $('#b-like').onclick = () => { api.action('like'); s.liked = !s.liked; renderLike(); };
  $('#b-full').onclick = () => api.action('openFull');
  $('#b-close').onclick = () => { closeSearch(); api.hideMini(); };
  $('#b-search').onclick = () => (searchOpen ? closeSearch() : openSearch());
  $('#art-wrap').addEventListener('dblclick', () => api.action('openFull'));

  $('#prog').addEventListener('click', (e) => {
    if (!s.duration || s.ad) return;
    const r = e.currentTarget.getBoundingClientRect();
    const pos = ((e.clientX - r.left) / r.width) * s.duration;
    s.position = pos; recvAt = performance.now();
    api.action('seek', pos);
  });

  // -------------------------------------------------------------- move + resize
  // The main process follows the real cursor while the button is held.
  function gesture(el, kind, cls) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      document.body.classList.add(cls);
      api.miniGesture(kind, 'start');
      const end = () => {
        document.body.classList.remove(cls);
        api.miniGesture(kind, 'end');
        el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); el.removeEventListener('lostpointercapture', end);
      };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
    });
  }
  gesture($('#handle'), 'drag', 'dragging');
  gesture($('#art-wrap'), 'drag', 'dragging');
  gesture($('#info'), 'drag', 'dragging');
  gesture($('#grip'), 'resize', 'resizing');

  // Mouse wheel = volume.
  let vol = null, wheelT = null;
  document.addEventListener('wheel', (e) => {
    if (searchOpen && e.target.closest('.search')) return;
    if (vol == null) vol = s.volume ?? 50;
    vol = Math.max(0, Math.min(100, vol + (e.deltaY < 0 ? 4 : -4)));
    flash(`Volume ${vol}%`);
    clearTimeout(wheelT);
    wheelT = setTimeout(() => { vol = null; }, 1200);
    api.action('volume', vol);
  }, { passive: true });

  let flashT = null;
  function flash(text) {
    const f = $('#flash');
    f.textContent = text; f.classList.add('show');
    clearTimeout(flashT); flashT = setTimeout(() => f.classList.remove('show'), 900);
  }

  // A short message in the top line (e.g. "Added to Up Next").
  let notice = null, noticeT = null;
  function showNotice(text) {
    notice = text; renderRoom();
    clearTimeout(noticeT); noticeT = setTimeout(() => { notice = null; renderRoom(); }, 3500);
  }

  // -------------------------------------------------------------- render
  function renderLike() {
    $('#b-like').classList.toggle('on', !!s.liked);
    $('#b-like').innerHTML = s.liked ? ICONS.heartFill : ICONS.heart;
    $('#b-like').title = s.liked ? 'Liked' : 'Like';
  }
  function render() {
    const mini = $('#mini');
    mini.classList.toggle('idle', !s.videoId);
    mini.classList.toggle('ad', !!s.ad);
    $('#b-play').innerHTML = s.playing ? ICONS.pause : ICONS.play;
    renderLike();
    const title = s.ad ? 'Ad playing (muted)' : (s.title || 'Nothing playing');
    if (title !== lastTitle) {
      lastTitle = title;
      const span = $('#title'); span.textContent = title;
      const wrap = $('#title-wrap');
      wrap.classList.remove('marquee');
      requestAnimationFrame(() => {
        const over = span.scrollWidth - wrap.clientWidth;
        if (over > 4) {
          wrap.style.setProperty('--shift', `-${over + 20}px`);
          wrap.style.setProperty('--dur', `${Math.max(8, over / 18)}s`);
          wrap.classList.add('marquee');
        }
      });
    }
    $('#artist').innerHTML = '';
    const a = document.createElement('span');
    a.textContent = s.ad ? (s.adLeft ? `Your music starts in ${fmt(s.adLeft)}` : 'Your music starts right after')
      : s.videoId ? (s.artist || '') : 'Open Wavelength or search to pick something';
    $('#artist').appendChild(a);
    if (s.duration && !s.ad) {
      const t = document.createElement('span'); t.className = 'time'; t.id = 'time';
      $('#artist').appendChild(document.createTextNode(s.artist ? '  ·  ' : ''));
      $('#artist').appendChild(t);
    }
    const art = s.art;
    if (art) {
      if ($('#art').getAttribute('src') !== art) { $('#art').src = art; $('#bg').src = art; }
      $('#art').hidden = false; $('#art-ph').hidden = true; $('#bg').hidden = false;
    } else { $('#art').hidden = true; $('#art-ph').hidden = false; $('#bg').hidden = true; }
    renderRoom();
  }

  function renderRoom() {
    const el = $('#room');
    if (notice) {
      el.hidden = false; el.className = 'room notice';
      el.innerHTML = '<span class="dot"></span><span class="txt"></span>';
      el.lastChild.textContent = notice;
      return;
    }
    if (!summary || summary.role === 'solo') { el.hidden = true; return; }
    el.hidden = false;
    const n = summary.members.length;
    const solo = summary.role === 'guest' && !summary.sync;
    el.className = 'room' + (solo || summary.status !== 'live' ? ' solo' : '');
    const by = summary.current && summary.current.addedBy ? ` · added by ${summary.current.addedBy.name}` : '';
    el.innerHTML = '<span class="dot"></span><span class="txt"></span>';
    el.lastChild.textContent = summary.status !== 'live' ? 'Reconnecting…' : solo ? 'Room · listening solo' : `Together · ${n}${by}`;
  }

  function tick() {
    if (s.duration) {
      const pos = Math.min(s.duration, (s.position || 0) + (s.playing ? (performance.now() - recvAt) / 1000 : 0));
      $('#fill').style.width = `${(pos / s.duration) * 100}%`;
      const t = document.getElementById('time');
      if (t) t.textContent = `${fmt(pos)} / ${fmt(s.duration)}`;
    } else $('#fill').style.width = '0';
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // -------------------------------------------------------------- search
  // Shows the top two songs; clicking one adds it to Up Next, then the search
  // resets and the bar confirms what was added.
  let searchOpen = false, searchT = null, seq = 0, results = [], sel = 0;
  const input = $('#s-q');
  function openSearch() {
    if (searchOpen) { input.focus(); return; }
    searchOpen = true;
    $('#search').hidden = false;
    $('#b-search').classList.add('on');
    api.miniMode('search');
    setTimeout(() => input.focus(), 30);
  }
  function closeSearch() {
    if (!searchOpen) return;
    searchOpen = false;
    clearTimeout(searchT); seq++;
    input.value = ''; results = [];
    $('#s-results').innerHTML = '<div class="s-note">Type a song or artist. Click a result to add it.</div>';
    $('#search').hidden = true;
    $('#b-search').classList.remove('on');
    api.miniMode('bar');
  }
  $('#s-close').onclick = closeSearch;
  input.addEventListener('input', () => {
    clearTimeout(searchT);
    const q = input.value.trim();
    if (!q) { seq++; results = []; $('#s-results').innerHTML = '<div class="s-note">Type a song or artist. Click a result to add it.</div>'; return; }
    searchT = setTimeout(() => runSearch(q), 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (results.length) { sel = (sel + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length; paint(); } }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[sel]) add(results[sel]);
      else { clearTimeout(searchT); if (input.value.trim()) runSearch(input.value.trim()); }
    }
  });
  async function runSearch(q) {
    const my = ++seq;
    $('#s-results').innerHTML = '<div class="s-spin"></div>';
    try {
      const all = await api.ytm('search', q);
      if (my !== seq) return;
      const songs = all.filter((r) => r.kind === 'Song');
      results = (songs.length >= 2 ? songs : all).slice(0, 2);
      sel = 0;
      paint();
    } catch (e) {
      if (my !== seq) return;
      $('#s-results').innerHTML = '<div class="s-note">Search isn\'t available right now. Is YouTube Music loaded?</div>';
    }
  }
  function paint() {
    $('#s-results').innerHTML = results.length ? results.map((r, i) => `
      <button class="s-row ${i === sel ? 'sel' : ''}" data-i="${i}" type="button">
        ${r.art ? `<img src="${esc(r.art)}" alt="">` : '<div class="ph"></div>'}
        <div class="m"><div class="t">${esc(r.title)}</div><div class="a">${esc(r.artist)}${r.duration ? ' · ' + fmt(r.duration) : ''}</div></div>
        <span class="add" title="Add to Up Next">${ICONS.plus}</span>
      </button>`).join('') : '<div class="s-note">No songs found.</div>';
  }
  $('#s-results').addEventListener('click', (e) => {
    const row = e.target.closest('.s-row'); if (!row) return;
    add(results[+row.dataset.i]);
  });
  function add(r) {
    if (!r) return;
    api.addItems([r], 'end');
    closeSearch();
    showNotice(`Added · ${r.title}`);
  }

  // -------------------------------------------------------------- feeds
  api.onPlayerState((st) => { s = st || {}; recvAt = performance.now(); render(); });
  api.onSessionSummary((sum) => { summary = sum; renderRoom(); });
  api.onUi((u) => {
    if (u.volume != null) { s.volume = u.volume; flash(`Volume ${u.volume}%`); }
    if (u.search) openSearch();
    if (u.blur && searchOpen && !input.value.trim()) closeSearch();
  });
  render();
})();
