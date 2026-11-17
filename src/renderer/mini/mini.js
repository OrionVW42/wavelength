/* global ICONS, LOGO */
(() => {
  const api = window.wl;
  const $ = (s) => document.querySelector(s);
  const fmt = (sec) => { sec = Math.max(0, Math.floor(+sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };

  $('#b-prev').innerHTML = ICONS.prev;
  $('#b-next').innerHTML = ICONS.next;
  $('#b-play').innerHTML = ICONS.play;
  $('#b-like').innerHTML = ICONS.heart;
  $('#b-full').innerHTML = ICONS.expand;
  $('#b-close').innerHTML = ICONS.close;
  $('#art-ph').innerHTML = LOGO;

  let s = {}, recvAt = 0, summary = null, lastTitle = null;

  $('#b-play').onclick = () => api.action('toggle');
  $('#b-next').onclick = () => api.action('next');
  $('#b-prev').onclick = () => api.action('prev');
  $('#b-like').onclick = () => { api.action('like'); $('#b-like').classList.toggle('on'); };
  $('#b-full').onclick = () => api.action('openFull');
  $('#b-close').onclick = () => api.hideMini();
  $('#art').ondblclick = () => api.action('openFull');

  $('#prog').addEventListener('click', (e) => {
    if (!s.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const pos = ((e.clientX - r.left) / r.width) * s.duration;
    s.position = pos; recvAt = performance.now();
    api.action('seek', pos);
  });

  // Mouse wheel = volume.
  let vol = null, wheelT = null;
  document.addEventListener('wheel', (e) => {
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

  function render() {
    const mini = $('#mini');
    mini.classList.toggle('idle', !s.videoId);
    mini.classList.toggle('ad', !!s.ad);
    $('#b-play').innerHTML = s.playing ? ICONS.pause : ICONS.play;
    $('#b-like').classList.toggle('on', !!s.liked);
    $('#b-like').innerHTML = s.liked ? ICONS.heartFill : ICONS.heart;
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
      : s.videoId ? (s.artist || '') : 'Open Wavelength to pick something';
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
    if (!summary || summary.role === 'solo') { el.hidden = true; return; }
    el.hidden = false;
    const n = summary.members.length;
    const solo = summary.role === 'guest' && !summary.sync;
    el.className = 'room' + (solo || summary.status !== 'live' ? ' solo' : '');
    const by = summary.current && summary.current.addedBy ? ` · added by ${summary.current.addedBy.name}` : '';
    el.innerHTML = '<span class="dot"></span><span class="txt"></span>';
    el.lastChild.appendChild(document.createTextNode(summary.status !== 'live' ? 'Reconnecting…' : solo ? `Room · listening solo` : `Together · ${n}${by}`));
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

  api.onPlayerState((st) => { s = st || {}; recvAt = performance.now(); render(); });
  api.onSessionSummary((sum) => { summary = sum; renderRoom(); });
  api.onUi((u) => { if (u.volume != null) { s.volume = u.volume; flash(`Volume ${u.volume}%`); } });
  render();
})();
