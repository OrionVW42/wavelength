// Runs in the MAIN world of music.youtube.com, injected at document start by
// src/preload/ytm.js. Exposes window.__wl:
//   __wl.cmd.*  player commands (called by the main process via executeJavaScript)
//   __wl.api.*  YouTube Music (InnerTube) calls: search, playlists, create playlist
// and pushes state/events to the preload with window.postMessage.
(() => {
  if (window.__wl) return;
  const cfg = Object.assign({ adblock: true, holdAtEnd: false }, window.__wlCfg || {});

  // Strip ad data from player responses so no ad is scheduled. (This only
  // works with Electron's own user agent; see setupYtmSession in main.js.)
  const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];
  const strip = (o) => {
    if (cfg.adblock && o && typeof o === 'object') {
      for (const k of AD_KEYS) if (k in o) delete o[k];
      if (o.playerResponse && typeof o.playerResponse === 'object') strip(o.playerResponse);
    }
    return o;
  };
  const origParse = JSON.parse;
  JSON.parse = function () { return strip(origParse.apply(this, arguments)); };
  const origJson = Response.prototype.json;
  Response.prototype.json = function () { return origJson.apply(this, arguments).then(strip); };

  const wl = window.__wl = { cfg, progUntil: 0, heldVid: null, ctx: null };
  const $ = (s, r = document) => r.querySelector(s);
  const player = () => $('#movie_player');
  const video = () => $('#movie_player video') || $('video');
  const send = (type, data) => { try { window.postMessage({ __wlBridge: 1, type, data }, location.origin); } catch { /* page unloading */ } };
  const mark = (ms = 1500) => { wl.progUntil = Math.max(wl.progUntil, Date.now() + ms); };
  const isProg = () => Date.now() < wl.progUntil;

  // Promo / upsell chrome hidden with CSS (removing Polymer nodes breaks them).
  const css = `
    ytmusic-mealbar-promo-renderer, ytmusic-statement-banner-renderer,
    .ytmusic-popup-container ytmusic-mealbar-promo-renderer { display: none !important; }`;
  const addStyle = () => {
    if (!cfg.adblock || document.getElementById('wl-style')) return;
    const s = document.createElement('style'); s.id = 'wl-style'; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  };

  // --------------------------------------------------------------- state
  const isAd = () => {
    const p = player();
    if (p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'))) return true;
    const m = navigator.mediaSession && navigator.mediaSession.metadata;
    return !!(m && /^YouTube Ads/.test(m.artist || ''));
  };
  const bestArt = (m, id) => {
    const a = (m && m.artwork) ? [...m.artwork] : [];
    if (a.length) {
      a.sort((x, y) => (parseInt(y.sizes) || 0) - (parseInt(x.sizes) || 0));
      return a[0].src;
    }
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  };
  const videoData = () => { try { return player()?.getVideoData?.() || {}; } catch { return {}; } };

  function state() {
    const p = player(), v = video(), vd = videoData();
    const m = navigator.mediaSession && navigator.mediaSession.metadata;
    const like = $('ytmusic-player-bar ytmusic-like-button-renderer')?.getAttribute('like-status');
    let vol = 100, muted = false;
    try { vol = p?.getVolume?.() ?? 100; muted = !!p?.isMuted?.(); } catch { /* player not ready */ }
    const slider = $('ytmusic-player-bar #volume-slider');
    if (slider && slider.value != null && !isNaN(+slider.value)) vol = Math.round(+slider.value);
    // mediaSession can lag a beat behind the actual video on a track switch;
    // prefer the player's own data when they disagree.
    const metaFresh = m && vd.title && m.title === vd.title;
    return {
      ready: !!(p && v),
      videoId: vd.video_id || null,
      title: (metaFresh ? m.title : vd.title) || m?.title || '',
      artist: (metaFresh ? m.artist : vd.author) || m?.artist || '',
      album: (metaFresh && m.album) || '',
      art: bestArt(metaFresh ? m : null, vd.video_id),
      duration: v && isFinite(v.duration) ? v.duration : 0,
      position: v ? v.currentTime : 0,
      playing: !!(v && !v.paused && !v.ended),
      liked: like === 'LIKE',
      volume: vol, muted,
      ad: isAd(),
      adLeft: isAd() && v && isFinite(v.duration) ? Math.max(0, v.duration - v.currentTime) : 0,
      signedIn: !!(window.ytcfg && ytcfg.get('LOGGED_IN')),
      t: Date.now(),
    };
  }

  // ------------------------------------------------- track change detection
  let lastVid = null, lastPos = 0, lastDur = 0, lastTrackAt = 0;
  function checkTrack() {
    const vd = videoData(), v = video();
    const id = vd.video_id || null;
    if (id && id !== lastVid && !isAd()) {
      const nearEnd = lastDur > 0 && lastPos > lastDur - 3;
      const cause = isProg() ? 'prog' : (nearEnd || wl.heldVid === lastVid ? 'auto' : 'user');
      const prev = lastVid;
      lastVid = id; lastTrackAt = Date.now(); wl.heldVid = null;
      if (prev) send('track', { videoId: id, prev, cause });
    }
    if (v && !isAd()) { lastPos = v.currentTime; lastDur = isFinite(v.duration) ? v.duration : 0; }
  }

  // ------------------------------------------------------- media events
  const isVid = (e) => e.target && e.target.tagName === 'VIDEO';
  const settling = () => Date.now() - lastTrackAt < 2500;
  document.addEventListener('timeupdate', (e) => {
    if (!isVid(e)) return;
    checkTrack();
    const v = e.target;
    // Hold at the end of a track so the room/session queue decides what plays
    // next instead of YouTube Music's autoplay.
    if (cfg.holdAtEnd && !isAd() && isFinite(v.duration) && v.duration > 5 &&
        v.duration - v.currentTime < 0.6 && wl.heldVid !== lastVid) {
      wl.heldVid = lastVid; mark();
      try { player().pauseVideo(); } catch { v.pause(); }
      send('ended', { videoId: lastVid, held: true });
    }
  }, true);
  document.addEventListener('ended', (e) => {
    if (isVid(e) && !isAd()) send('ended', { videoId: lastVid, held: false });
  }, true);
  document.addEventListener('play', (e) => {
    if (!isVid(e)) return; checkTrack(); pushSoon();
    if (!isProg() && !isAd() && !settling()) send('user', { kind: 'play', position: e.target.currentTime });
  }, true);
  document.addEventListener('pause', (e) => {
    if (!isVid(e)) return; pushSoon();
    const v = e.target;
    const nearEnd = isFinite(v.duration) && v.duration - v.currentTime < 1.5;
    if (!isProg() && !isAd() && !settling() && !nearEnd) send('user', { kind: 'pause', position: v.currentTime });
  }, true);
  document.addEventListener('seeked', (e) => {
    if (!isVid(e)) return; pushSoon();
    if (!isProg() && !isAd() && !settling()) send('user', { kind: 'seek', position: e.target.currentTime });
  }, true);
  document.addEventListener('loadedmetadata', (e) => { if (isVid(e)) { checkTrack(); pushSoon(); } }, true);

  // ------------------------------------------------------------ ads
  // YouTube's stream server now verifies ads were really played: stripping
  // them, fast-forwarding or seeking past them gets the next song killed
  // ~40s in (ump.spsrejectfailure). So ads play at normal speed but MUTED,
  // and the real Skip button is pressed the moment it appears.
  let mutedByUs = false;
  function handleAds() {
    const v = video(); if (!v) return;
    if (cfg.adblock && isAd()) {
      if (!mutedByUs) wl.adsSkipped = (wl.adsSkipped || 0) + 1;
      if (!v.muted) v.muted = true;
      mutedByUs = true;
      document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-slot button')
        .forEach((b) => { if (b.offsetParent !== null) { try { b.click(); } catch { /* gone */ } } });
    } else if (mutedByUs) {
      v.muted = false; mutedByUs = false;
    }
  }
  function handlePopups() {
    // "Video paused. Continue watching?" — always yes.
    const there = $('ytmusic-you-there-renderer');
    if (there && there.offsetParent !== null) {
      const b = there.querySelector('button, tp-yt-paper-button, yt-button-renderer');
      if (b) { mark(); b.click(); }
    }
    if (cfg.adblock) {
      const promo = $('ytmusic-mealbar-promo-renderer');
      if (promo) promo.querySelector('#dismiss-button button, #dismiss-button')?.click?.();
    }
  }

  // ------------------------------------------------------------- push loop
  let pushTimer = null;
  function push() { pushTimer = null; send('state', state()); }
  function pushSoon() { if (!pushTimer) pushTimer = setTimeout(push, 60); }
  // Seeking into the last seconds of a stream can leave it stalled forever
  // ("playing" but frozen). Treat a freeze right at the end as the end.
  let stallPos = -1, stallTicks = 0;
  function handleEndStall() {
    const v = video();
    if (!v || !cfg.holdAtEnd || isAd() || v.paused || !isFinite(v.duration) || v.duration - v.currentTime > 4) { stallTicks = 0; return; }
    if (Math.abs(v.currentTime - stallPos) < 0.01) {
      if (++stallTicks >= 8 && wl.heldVid !== lastVid) {
        wl.heldVid = lastVid; mark();
        try { player().pauseVideo(); } catch { v.pause(); }
        send('ended', { videoId: lastVid, held: true, stalled: true });
      }
    } else { stallPos = v.currentTime; stallTicks = 0; }
  }
  // Mid-song freeze (stuck buffering on a stream segment): nudge forward to
  // force a fresh request. YouTube's own player sometimes never retries.
  let wdPos = -1, wdTicks = 0, wdTries = 0, wdVid = null;
  function handleMidStall() {
    const v = video();
    if (!v || v.paused || isAd() || !isFinite(v.duration) || v.duration - v.currentTime < 4) { wdTicks = 0; return; }
    if (lastVid !== wdVid) { wdVid = lastVid; wdTries = 0; }
    if (Math.abs(v.currentTime - wdPos) < 0.01) {
      if (++wdTicks >= 16 && wdTries < 3) {
        wdTicks = 0; wdTries++; mark();
        wl.stallsFixed = (wl.stallsFixed || 0) + 1;
        try { player().seekTo(v.currentTime + 0.5 * wdTries, true); } catch { /* not ready */ }
      }
    } else { wdPos = v.currentTime; wdTicks = 0; }
  }
  setInterval(() => { addStyle(); handleAds(); handlePopups(); checkTrack(); handleEndStall(); handleMidStall(); push(); }, 500);

  // ---------------------------------------------------------------- commands
  const click = (sel) => { const b = $(sel); if (b) { b.click(); return true; } return false; };
  let pendingClick = null;
  function clickWhenEnabled(sel, tries = 20) {
    clearTimeout(pendingClick);
    const b = $(sel);
    if (b && !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true') { b.click(); return; }
    if (tries > 0) pendingClick = setTimeout(() => clickWhenEnabled(sel, tries - 1), 300);
  }
  function navigate(endpoint) {
    const app = $('ytmusic-app');
    if (!app) return false;
    app.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint } }));
    return true;
  }
  wl.cmd = {
    toggle() { mark(); const p = player(), v = video(); if (!p || !v) return; if (v.paused) p.playVideo(); else p.pauseVideo(); },
    play() { mark(); player()?.playVideo(); },
    pause() { mark(); player()?.pauseVideo(); },
    // Right after a track starts, YouTube Music is still building its autoplay
    // list and Next is disabled; wait for it instead of silently doing nothing.
    next() { mark(9000); clickWhenEnabled('ytmusic-player-bar .next-button'); },
    prev() { mark(9000); clickWhenEnabled('ytmusic-player-bar .previous-button'); },
    seek(t) { mark(); player()?.seekTo(Math.max(0, +t || 0), true); pushSoon(); },
    load(videoId) {
      if (!/^[\w-]{11}$/.test(videoId)) return false;
      mark(6000); wl.heldVid = null;
      const before = videoData().video_id;
      if (before === videoId) { player()?.seekTo(0, true); player()?.playVideo(); return true; }
      if (!navigate({ watchEndpoint: { videoId } })) { location.href = '/watch?v=' + videoId; return true; }
      // Fallback: if the in-app navigation didn't take, do a real page load.
      setTimeout(() => { if (videoData().video_id !== videoId && !isAd()) location.href = '/watch?v=' + videoId; }, 8000);
      return true;
    },
    volume(n) {
      const vol = Math.max(0, Math.min(100, Math.round(+n)));
      const p = player(); if (!p) return;
      if (vol > 0 && p.isMuted()) p.unMute();
      // Drive YouTube Music's own slider: it applies its loudness curve and remembers the level.
      const s = $('ytmusic-player-bar #volume-slider');
      if (s) { s.value = vol; for (const ev of ['immediate-value-change', 'change']) s.dispatchEvent(new CustomEvent(ev, { bubbles: true, composed: true })); }
      else p.setVolume(vol);
      pushSoon(); return vol;
    },
    like() {
      const r = $('ytmusic-player-bar ytmusic-like-button-renderer');
      const b = r && (r.querySelector('#button-shape-like button') || r.querySelector('#button-shape-like') || r.querySelector('button'));
      if (b) { b.click(); setTimeout(pushSoon, 300); return true; }
      return false;
    },
    back() { history.back(); },
    browse(browseId) { return navigate({ browseEndpoint: { browseId } }); },
    setCfg(c) { Object.assign(cfg, c); pushSoon(); },
    state,
  };

  // ------------------------------------------------------- InnerTube API
  const cookie = (n) => { const m = document.cookie.match('(?:^|; )' + n.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'); return m ? decodeURIComponent(m[1]) : null; };
  async function sha1hex(s) {
    const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  async function it(endpoint, body) {
    if (!window.ytcfg) throw new Error('YouTube Music is still loading');
    const headers = { 'content-type': 'application/json', 'x-origin': location.origin, 'x-goog-authuser': String(ytcfg.get('SESSION_INDEX') || 0) };
    const sap = cookie('SAPISID') || cookie('__Secure-3PAPISID');
    if (sap) {
      const ts = Math.floor(Date.now() / 1000);
      headers.authorization = `SAPISIDHASH ${ts}_${await sha1hex(`${ts} ${sap} ${location.origin}`)}`;
    }
    const vis = ytcfg.get('VISITOR_DATA'); if (vis) headers['x-goog-visitor-id'] = vis;
    const r = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ context: ytcfg.get('INNERTUBE_CONTEXT'), ...body }),
    });
    if (!r.ok) throw new Error(`YouTube Music said ${r.status} for ${endpoint}`);
    return r.json();
  }
  const txt = (t) => (t && t.runs) ? t.runs.map((r) => r.text).join('') : (t && t.simpleText) || '';
  const parseDur = (s) => {
    const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec((s || '').trim());
    if (!m) return 0;
    return m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
  };
  const KINDS = new Set(['Song', 'Video', 'Episode', 'Single', 'EP', 'Album', 'Playlist', 'Artist', 'Podcast', 'Profile']);
  const thumb = (r) => {
    const t = r?.musicThumbnailRenderer?.thumbnail?.thumbnails || r?.thumbnails || [];
    return t.length ? t[t.length - 1].url : null;
  };
  function findKey(o, key, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 12) return undefined;
    if (key in o) return o[key];
    for (const k in o) { const v = findKey(o[k], key, depth + 1); if (v !== undefined) return v; }
    return undefined;
  }
  function songFromRow(x) {
    const flex = x.flexColumns || [];
    const runs0 = flex[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
    const id = x.playlistItemData?.videoId
      || x.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
      || runs0[0]?.navigationEndpoint?.watchEndpoint?.videoId;
    if (!id) return null;
    const cols = flex.map((c) => txt(c.musicResponsiveListItemFlexColumnRenderer?.text));
    const parts = (cols[1] || '').split(' • ').map((s) => s.trim()).filter(Boolean);
    let kind = '';
    if (parts.length && KINDS.has(parts[0])) kind = parts.shift();
    if (kind && kind !== 'Song' && kind !== 'Video' && kind !== 'Episode') return null;
    const mvt = findKey(x, 'musicVideoType');
    if (mvt === 'MUSIC_VIDEO_TYPE_ATV') kind = 'Song';
    else if (mvt === 'MUSIC_VIDEO_TYPE_OMV' || mvt === 'MUSIC_VIDEO_TYPE_UGC' || mvt === 'MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC') kind = 'Video';
    else if (!kind && parts.some((p) => / views?$/i.test(p))) kind = 'Video';
    const fixed = (x.fixedColumns || []).map((c) => txt(c.musicResponsiveListItemFixedColumnRenderer?.text));
    const durStr = fixed.find((s) => parseDur(s)) || parts.find((s) => parseDur(s)) || '';
    return {
      videoId: id,
      title: cols[0] || 'Unknown',
      artist: parts.filter((s) => !parseDur(s) && !/views|plays/i.test(s))[0] || '',
      duration: parseDur(durStr),
      art: thumb(x.thumbnail),
      kind: kind || 'Song',
    };
  }
  function parseSongs(json) {
    const out = [], seen = new Set();
    (function walk(o, cardArtist) {
      if (!o || typeof o !== 'object') return;
      if (o.musicResponsiveListItemRenderer) {
        const s = songFromRow(o.musicResponsiveListItemRenderer);
        if (s && !seen.has(s.videoId) && (s.kind === 'Song' || s.kind === 'Video')) {
          // Rows inside an artist's "top result" card leave the artist out.
          if (!s.artist && cardArtist) s.artist = cardArtist;
          seen.add(s.videoId); out.push(s);
        }
        return;
      }
      if (o.musicCardShelfRenderer) {
        const c = o.musicCardShelfRenderer;
        if (/^Artist\b/.test(txt(c.subtitle))) cardArtist = txt(c.title);
        const id = c.title?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;
        if (id && !seen.has(id)) {
          const parts = txt(c.subtitle).split(' • ').map((s) => s.trim());
          let kind = KINDS.has(parts[0]) ? parts.shift() : 'Song';
          const mvt = findKey(c.title, 'musicVideoType');
          if (mvt === 'MUSIC_VIDEO_TYPE_ATV') kind = 'Song'; else if (mvt) kind = 'Video';
          seen.add(id);
          out.push({ videoId: id, title: txt(c.title), artist: parts[0] || '', duration: parseDur(parts.find((s) => parseDur(s))), art: thumb(c.thumbnail), kind });
        }
      }
      for (const k in o) walk(o[k], cardArtist);
    })(json, '');
    return out;
  }
  function parseQueue(json) {
    const out = [], seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      const v = o.playlistPanelVideoRenderer;
      if (v && v.videoId && !seen.has(v.videoId)) {
        seen.add(v.videoId);
        out.push({ videoId: v.videoId, title: txt(v.title), artist: (txt(v.shortBylineText) || txt(v.longBylineText)).split(' • ')[0],
          duration: parseDur(txt(v.lengthText)), art: thumb(v.thumbnail), kind: 'Song' });
        return;
      }
      for (const k in o) walk(o[k]);
    })(json);
    return out;
  }
  function findContinuation(json) {
    let token = null;
    (function walk(o) {
      if (token || !o || typeof o !== 'object') return;
      if (o.continuationCommand?.token) { token = o.continuationCommand.token; return; }
      if (o.nextContinuationData?.continuation) { token = o.nextContinuationData.continuation; return; }
      for (const k in o) walk(o[k]);
    })(json);
    return token;
  }

  wl.api = {
    signedIn: () => !!(window.ytcfg && ytcfg.get('LOGGED_IN')),
    async search(query) {
      const j = await it('search', { query: String(query).slice(0, 200) });
      return parseSongs(j).slice(0, 25);
    },
    // Metadata for one videoId (used for pasted links / right-click adds).
    async resolve(videoId) {
      const j = await it('player', { videoId });
      const d = j.videoDetails;
      if (!d) throw new Error('That song is unavailable');
      return {
        videoId, title: d.title, artist: (d.author || '').replace(/ - Topic$/, ''),
        duration: +d.lengthSeconds || 0, art: thumb(d.thumbnail), kind: 'Song',
      };
    },
    // Songs in a playlist / album (browse id or list id). Follows continuations.
    async playlist(id, max = 500) {
      let browseId = id;
      if (/^(PL|OLAK|RD|LM|LL|FL|UU)/.test(id)) browseId = 'VL' + id;
      let j = await it('browse', { browseId });
      let songs = parseSongs(j);
      if (!songs.length) {
        // Album playlists (OLAK…) answer with a pointer to the album page.
        const canon = findKey(j, 'urlCanonical') || '';
        const m = /browse\/(MPRE[\w-]+)/.exec(canon) || /list=([\w-]+)/.exec(canon);
        const target = m && (m[1].startsWith('MPRE') ? m[1] : 'VL' + m[1]);
        if (target && target !== browseId) { j = await it('browse', { browseId: target }); songs = parseSongs(j); }
      }
      if (!songs.length && !/^MPRE|^FE/.test(id)) {
        // Mixes / radios aren't browsable: read them as a watch queue instead.
        const n = await it('next', { playlistId: id.replace(/^VL/, ''), isAudioOnly: true });
        return parseQueue(n).slice(0, max);
      }
      let token = findContinuation(j), pages = 0;
      while (token && songs.length < max && pages < 12) {
        j = await it('browse', { continuation: token });
        const more = parseSongs(j).filter((s) => !songs.some((x) => x.videoId === s.videoId));
        if (!more.length) break;
        songs = songs.concat(more);
        token = findContinuation(j); pages++;
      }
      return songs.slice(0, max);
    },
    // The signed-in user's playlists (plus Liked Music).
    async library() {
      if (!wl.api.signedIn()) return [];
      const j = await it('browse', { browseId: 'FEmusic_liked_playlists' });
      const out = [], seen = new Set();
      (function walk(o) {
        if (!o || typeof o !== 'object') return;
        const r = o.musicTwoRowItemRenderer;
        if (r) {
          const b = r.navigationEndpoint?.browseEndpoint?.browseId;
          if (b && /^VL/.test(b) && !seen.has(b)) {
            seen.add(b);
            out.push({ id: b.slice(2), title: txt(r.title), subtitle: txt(r.subtitle), art: thumb(r.thumbnailRenderer) });
          }
          return;
        }
        for (const k in o) walk(o[k]);
      })(j);
      if (!seen.has('VLLM')) out.unshift({ id: 'LM', title: 'Liked Music', subtitle: 'Auto playlist', art: null });
      return out;
    },
    async createPlaylist(title, videoIds) {
      if (!wl.api.signedIn()) throw new Error('Sign in to YouTube Music first');
      const j = await it('playlist/create', {
        title: String(title).slice(0, 150), description: 'Made with Wavelength',
        privacyStatus: 'PRIVATE', videoIds: (videoIds || []).slice(0, 500),
      });
      if (!j.playlistId) throw new Error('YouTube Music did not create the playlist');
      return j.playlistId;
    },
    context() {
      const c = wl.ctx;
      return c && Date.now() - c.t < 15000 ? c.info : null;
    },
  };

  // -------------------------------------------------- right-click targets
  // Remember what song/playlist row was right-clicked so the native context
  // menu can offer "Add to Up Next".
  function extract(el) {
    let videoId = null, listId = null, browseId = null;
    for (const a of el.querySelectorAll('a[href]')) {
      let u; try { u = new URL(a.getAttribute('href'), location.origin); } catch { continue; }
      if (!videoId && u.searchParams.get('v')) videoId = u.searchParams.get('v');
      if (!listId && u.searchParams.get('list')) listId = u.searchParams.get('list');
      const m = u.pathname.match(/^\/browse\/([\w-]+)/);
      if (!browseId && m && !/^UC/.test(m[1])) browseId = m[1];
    }
    if (!videoId) {
      const d = el.data || el.__data?.data || el.polymerController?.data;
      videoId = d?.videoId || d?.playlistPanelVideoRenderer?.videoId || null;
    }
    const title = (el.querySelector('.title, .song-title, yt-formatted-string.title')?.textContent || '').trim();
    if (el.matches('ytmusic-two-row-item-renderer') && !videoId) {
      return (listId || browseId) ? { kind: 'list', listId: listId || browseId, title } : null;
    }
    if (videoId) return { kind: 'song', videoId, title };
    if (listId || browseId) return { kind: 'list', listId: listId || browseId, title };
    return null;
  }
  document.addEventListener('contextmenu', (e) => {
    let info = null;
    for (const el of e.composedPath()) {
      if (!(el instanceof Element)) continue;
      if (el.matches('ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer, ytmusic-player-queue-item, ytmusic-card-shelf-renderer')) {
        info = extract(el); break;
      }
      if (el.matches('ytmusic-player-bar')) { const id = videoData().video_id; if (id) info = { kind: 'song', videoId: id, title: videoData().title }; break; }
    }
    wl.ctx = { info, t: Date.now() };
  }, true);
})();
