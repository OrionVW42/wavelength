// Session engine: the Up Next queue, play history and listen-together rooms.
//
// One machine is the AUTHORITY for a queue: when you're alone (solo) that's
// you; in a room it's the host. Guests send commands to the host, the host
// applies them and broadcasts the room. Playback sync: the host broadcasts
// {videoId, playing, position, at} and each guest that's "in sync" steers its
// own YouTube Music player to match (load / play / pause / seek).
/* global Peer */
(() => {
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const PEER_PREFIX = 'wavelength-room-v1-';
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const now = () => Date.now();
  const ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const cleanItem = (t) => ({
    videoId: String(t.videoId || ''), title: String(t.title || 'Unknown').slice(0, 200),
    artist: String(t.artist || '').slice(0, 200), art: t.art || null, duration: +t.duration || 0,
  });

  class Session {
    constructor(api, me, opts = {}) {
      this.api = api;
      this.me = me;                 // {id, name, color}
      this.opts = opts;             // {peerServer}
      this.role = 'solo';           // solo | host | guest
      this.status = 'idle';         // idle | connecting | live | reconnecting
      this.code = null;
      this.queue = [];
      this.history = [];
      this.current = null;
      this.members = [];
      this.guestsControl = true;
      this.sync = true;
      this.player = {};
      this.hostPb = null;
      this.offset = 0;              // hostClock - localClock (ms)
      this.pendingLoad = null;
      this.heldEnd = false;
      this.listeners = new Set();
      this.conns = new Map();       // host: peerId -> {conn, member}
      this.peer = null;
      this.hostConn = null;
      this._hold = null;
      this._lastPb = null;
      this._timers = [];
      this._soloBackup = null;
      this._lastStatus = '';
      this._lastSeek = 0;
      this._loading = null;
      this._clock = [];
      setInterval(() => this._tick(), 1000);
    }

    // ------------------------------------------------------------ basics
    get isAuthority() { return this.role !== 'guest'; }
    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(kind, data) { for (const fn of this.listeners) { try { fn(kind, data); } catch (e) { console.error(e); } } }
    changed() {
      this.emit('change');
      this._updateHold();
      if (this.role === 'host') this._scheduleRoomBroadcast();
      if (this.role !== 'guest') this._persistSoon();
      this.api.sessionSummary(this.summary());
    }
    toast(msg, opts) { this.emit('toast', { msg, ...opts }); }
    summary() {
      return {
        role: this.role, code: this.code, status: this.status, sync: this.sync,
        members: this.members.map((m) => ({ name: m.name, color: m.color })),
        next: this.queue[0] ? { title: this.queue[0].title, artist: this.queue[0].artist } : null,
        current: this.current ? { addedBy: this.current.addedBy, title: this.current.title, artist: this.current.artist } : null,
        upNext: this.queue.slice(0, 25).map((t) => ({ uid: t.uid, videoId: t.videoId, title: t.title, artist: t.artist, duration: t.duration, by: t.addedBy ? t.addedBy.name : null })),
        queueLength: this.queue.length,
      };
    }
    restore(state) {
      if (!state) return;
      this.queue = (state.queue || []).filter((t) => t && t.videoId);
      this.history = (state.history || []).slice(-50);
      this.changed();
    }
    _persistSoon() {
      clearTimeout(this._persistT);
      this._persistT = setTimeout(() => this.api.sessionState({ queue: this.queue, history: this.history.slice(-50) }), 800);
    }

    // ------------------------------------------------------------ player feed
    onPlayer(s) {
      this.player = s;
      if (this.isAuthority) this._trackAuthority(s);
      else this._reportStatus();
      if (this.role === 'host') this._maybeBroadcastPb();
      if (this.role === 'guest') this._syncCheck();
      // Host's own presence line follows its player.
      const self = this.members.find((m) => m.id === this.me.id);
      if (self) {
        const np = this._np();
        if (JSON.stringify(np) !== JSON.stringify(self.np)) { self.np = np; this.emit('members'); if (this.role === 'host') this._scheduleRoomBroadcast(); }
      }
    }
    _np() {
      const s = this.player;
      return s.videoId ? { videoId: s.videoId, title: s.title, artist: s.artist, art: s.art, playing: !!s.playing } : null;
    }
    _trackAuthority(s) {
      if (!s.videoId || s.ad) return;
      if (this.pendingLoad) {
        if (s.videoId === this.pendingLoad.item.videoId) {
          this.pendingLoad = null; this.heldEnd = false;
        } else if (now() - this.pendingLoad.at < 12000) {
          return; // still switching; ignore the outgoing track
        } else {
          this.pendingLoad = null;
        }
      }
      if (!this.current || s.videoId !== this.current.videoId) {
        // Something else started playing (picked in YouTube Music, or its autoplay).
        if (this.current) this._pushHistory(this.current);
        this.current = { uid: uid(), ...cleanItem(s), addedBy: null, source: 'ytm' };
        this.heldEnd = false;
        this.changed();
        return;
      }
      // Fill in metadata that arrives a beat after the switch.
      const c = this.current;
      let dirty = false;
      if (s.duration && !c.duration) { c.duration = s.duration; dirty = true; }
      if (c.source === 'ytm' && s.title && (c.title !== s.title || c.artist !== s.artist)) { c.title = s.title; c.artist = s.artist; c.art = s.art; dirty = true; }
      if (!c.art && s.art) { c.art = s.art; dirty = true; }
      if (!c.artist && s.artist) { c.artist = s.artist; dirty = true; }
      if (dirty) this.changed();
    }
    _pushHistory(item) {
      this.history.push(item);
      if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
    }
    _updateHold() {
      const hold = this.role === 'guest' ? this.sync : this.queue.length > 0;
      if (hold !== this._hold) { this._hold = hold; this.api.player('setCfg', { holdAtEnd: hold }); }
    }

    onPlayerEvent(type, data) {
      if (type === 'ended') {
        if (this.isAuthority) {
          this.heldEnd = true;
          if (this.queue.length) this.advance(0);
        }
        return;
      }
      if (type === 'track' && data && data.cause === 'auto' && this.isAuthority && this.queue.length && !this.pendingLoad) {
        // YouTube Music's autoplay slipped in before we could hold; take over.
        this.advance(0);
        return;
      }
      if (this.role === 'guest' && this.sync && (type === 'user' || (type === 'track' && data.cause === 'user'))) {
        this._guestUserAction(type, data);
      }
    }

    // A guest touched YouTube Music's own controls while in sync.
    _guestUserAction(type, data) {
      if (!this.guestsControl) {
        this.setSync(false);
        this.toast('You took over your own player — you\'re listening solo now.', { action: 'resync' });
        return;
      }
      if (type === 'track') {
        const s = this.player;
        this.send({ type: 'cmd', action: 'playItem', item: cleanItem({ ...s, videoId: data.videoId }) });
      } else if (data.kind === 'pause') this.send({ type: 'cmd', action: 'pause' });
      else if (data.kind === 'play') this.send({ type: 'cmd', action: 'play' });
      else if (data.kind === 'seek') this.send({ type: 'cmd', action: 'seek', position: data.position });
    }

    // ------------------------------------------------------------ actions
    // Every UI / hotkey / mini-player action lands here.
    do(action, args = {}, by = null) {
      if (this.role === 'guest') {
        const playback = ['toggle', 'play', 'pause', 'next', 'prev', 'seek'].includes(action);
        if (playback && !this.sync) return this._local(action, args);
        if (playback && !this.guestsControl) {
          this.toast('The host has playback controls locked. Leave sync to control your own player.', { action: 'unsync' });
          return;
        }
        if (action === 'toggle') action = this._hostPlaying() ? 'pause' : 'play';
        if (action === 'add') args = { ...args, items: (args.items || []).map(cleanItem) };
        this.send({ type: 'cmd', action, ...args, ...(by ? { by } : {}) });
        return;
      }
      this.apply(action, args, by || this.memberSelf());
    }
    memberSelf() { return { id: this.me.id, name: this.me.name, color: this.me.color }; }
    _hostPlaying() { return !!(this.hostPb && this.hostPb.playing); }
    _local(action, args) {
      const p = this.api.player;
      if (action === 'toggle') p('toggle');
      else if (action === 'play') p('play');
      else if (action === 'pause') p('pause');
      else if (action === 'next') p('next');
      else if (action === 'prev') p('prev');
      else if (action === 'seek') p('seek', args.position);
    }

    // Authority applies an action on behalf of `by` (a member).
    apply(action, a, by) {
      const p = this.api.player;
      switch (action) {
        case 'add': {
          const items = (a.items || []).filter((t) => t && /^[\w-]{11}$/.test(t.videoId))
            .map((t) => ({ uid: uid(), ...cleanItem(t), addedBy: by }));
          if (!items.length) return;
          if (a.where === 'next' || a.where === 'now') this.queue.unshift(...items); else this.queue.push(...items);
          const idle = !this.player.videoId || this.heldEnd || (!this.player.playing && !this.current);
          if (idle || a.where === 'now') this.advance(0); else this.changed();
          if (by.id !== this.me.id && this.role === 'host') this.emit('toast', { msg: `${by.name} added ${items.length === 1 ? items[0].title : items.length + ' songs'}` });
          return;
        }
        case 'remove': {
          const i = this.queue.findIndex((t) => t.uid === a.uid);
          if (i >= 0) { this.queue.splice(i, 1); this.changed(); }
          return;
        }
        case 'move': {
          const i = this.queue.findIndex((t) => t.uid === a.uid);
          if (i < 0) return;
          const [t] = this.queue.splice(i, 1);
          this.queue.splice(Math.max(0, Math.min(this.queue.length, a.to)), 0, t);
          this.changed();
          return;
        }
        case 'shuffle':
          for (let i = this.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]]; }
          this.changed(); return;
        case 'clear': this.queue = []; this.changed(); return;
        case 'replace': {
          this.queue = (a.items || []).map((t) => ({ uid: uid(), ...cleanItem(t), addedBy: by }));
          if (this.queue.length) this.advance(0); else this.changed();
          return;
        }
        case 'playNow': {
          const i = this.queue.findIndex((t) => t.uid === a.uid);
          if (i >= 0) this.advance(i);
          return;
        }
        case 'playItem': {
          // A guest picked a song inside YouTube Music while in sync.
          this.queue.unshift({ uid: uid(), ...cleanItem(a.item), addedBy: by });
          this.advance(0);
          return;
        }
        case 'toggle':
          if ((this.heldEnd || !this.player.videoId) && this.queue.length) { this.advance(0); return; }
          p('toggle'); return;
        case 'play':
          if ((this.heldEnd || !this.player.videoId) && this.queue.length) { this.advance(0); return; }
          p('play'); return;
        case 'pause': p('pause'); return;
        case 'next':
          if (this.queue.length) this.advance(0); else p('next');
          return;
        case 'prev': {
          if ((this.player.position || 0) > 4 || !this.history.length) {
            if (this.history.length || this.current?.source !== 'ytm') p('seek', 0); else p('prev');
            return;
          }
          const back = this.history.pop();
          if (this.current) this.queue.unshift({ ...this.current, uid: uid() });
          this._load(back);
          return;
        }
        case 'seek': p('seek', a.position); return;
        case 'seeked': this._broadcastPb(true); return;
        default:
      }
    }

    advance(index = 0) {
      const [item] = this.queue.splice(index, 1);
      if (!item) return;
      if (this.current) this._pushHistory(this.current);
      this._load(item);
    }
    _load(item) {
      this.current = item;
      this.pendingLoad = { item, at: now() };
      this.heldEnd = false;
      this.api.player('load', item.videoId);
      this.changed();
      if (this.role === 'host') {
        // Tell guests right away so they start loading in parallel.
        this._sendAll({ type: 'pb', pb: { videoId: item.videoId, playing: true, position: 0, at: now() } });
      }
    }

    // ------------------------------------------------------------ rooms
    _peerOptions() {
      const o = { debug: 1, config: { iceServers: ICE } };
      const srv = (this.opts.peerServer || '').trim();
      if (srv) {
        const u = new URL(/^https?:\/\//.test(srv) ? srv : 'https://' + srv);
        o.host = u.hostname; o.port = +u.port || (u.protocol === 'https:' ? 443 : 80);
        o.secure = u.protocol === 'https:'; o.path = u.pathname || '/';
      }
      return o;
    }
    static newCode() {
      let c = '';
      const r = crypto.getRandomValues(new Uint32Array(6));
      for (const n of r) c += CODE_CHARS[n % CODE_CHARS.length];
      return c;
    }
    static normalizeCode(s) {
      const m = String(s || '').toUpperCase().replace(/^.*WAVELENGTH[:/]+/, '').replace(/[^A-Z0-9]/g, '');
      return m.length === 6 ? m : null;
    }
    static prettyCode(c) { return c ? c.slice(0, 3) + '-' + c.slice(3) : ''; }

    // Hosting listens two ways at once: direct (PeerJS / WebRTC) and through
    // the encrypted relay. The room is live as soon as either is ready.
    host(attempt = 0) {
      if (this.role !== 'solo' || (this.status === 'connecting' && attempt === 0)) return;
      this.status = 'connecting'; this.emit('change');
      const code = Session.newCode();
      const token = ++this._hostToken || (this._hostToken = 1);
      let live = false, directDown = false, relayDown = false, relayUp = false;
      const stale = () => token !== this._hostToken;
      const goLive = () => {
        if (live || stale()) return;
        live = true;
        this.role = 'host'; this.code = code; this.status = 'live';
        this.members = [{ ...this.memberSelf(), isHost: true, sync: true, np: this._np() }];
        this.changed();
        this.toast('Room is live. Share the code with friends.');
      };
      const giveUp = () => {
        if (live || stale()) return;
        this._teardown();
        this.toast('Can\'t reach the room servers. Check your internet connection and try again.', { error: true });
      };

      if (this.opts.transport !== 'direct' && typeof Relay !== 'undefined') {
        const relay = new Relay(code);
        this.relay = relay;
        relay.start().then(() => {
          if (stale() || this.relay !== relay) { relay.close(); return; }
          relay.listenHost((conn) => this._acceptGuest(conn));
          relayUp = true;
          if (directDown || this.opts.transport === 'relay') goLive();
        }, () => { relayDown = true; if (directDown) giveUp(); });
      } else relayDown = true;

      if (this.opts.transport === 'relay') { directDown = true; return; }
      const peer = new Peer(PEER_PREFIX + code, this._peerOptions());
      this.peer = peer;
      const directFailed = () => { directDown = true; if (relayUp) goLive(); else if (relayDown) giveUp(); };
      const slowT = setTimeout(() => { if (!live) directFailed(); }, 10000);
      peer.on('open', () => { clearTimeout(slowT); if (stale()) return; goLive(); });
      peer.on('connection', (conn) => this._acceptGuest(conn));
      peer.on('disconnected', () => { if (this.role === 'host' && !peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch { /* destroyed */ } }, 1000); });
      peer.on('error', (err) => {
        if (stale()) return;
        if (err.type === 'unavailable-id' && !live && attempt < 3) {
          // Code already taken on the server: start over with a new one.
          clearTimeout(slowT); this._hostToken++;
          try { peer.destroy(); } catch { /* gone */ }
          if (this.relay) { this.relay.close(); this.relay = null; }
          this.peer = null; this.status = 'idle';
          return this.host(attempt + 1);
        }
        if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          if (!live) { clearTimeout(slowT); directFailed(); }
          return; // once live, reconnects on its own and the relay keeps the room up
        }
        console.warn('[room] host error', err.type, err.message);
      });
    }

    _acceptGuest(conn) {
      conn.on('open', () => {
        this.conns.set(conn.peer, { conn, member: null });
      });
      conn.on('data', (msg) => this._onHostData(conn, msg));
      conn.on('close', () => this._dropGuest(conn.peer));
      conn.on('error', () => this._dropGuest(conn.peer));
    }
    _dropGuest(peerId) {
      const c = this.conns.get(peerId);
      if (!c) return;
      this.conns.delete(peerId);
      if (c.member) {
        this.members = this.members.filter((m) => m.peerId !== peerId);
        this.toast(`${c.member.name} left`);
        this.changed();
      }
    }
    _onHostData(conn, msg) {
      if (!msg || typeof msg !== 'object') return;
      const entry = this.conns.get(conn.peer) || { conn, member: null };
      this.conns.set(conn.peer, entry);
      switch (msg.type) {
        case 'hello': {
          const m = msg.member || {};
          const member = {
            id: String(m.id || conn.peer).slice(0, 64), peerId: conn.peer,
            name: String(m.name || 'Guest').slice(0, 32), color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#7c6cff',
            isHost: false, sync: msg.sync !== false, np: null, via: conn.via === 'relay' ? 'relay' : 'direct',
          };
          this.members = this.members.filter((x) => x.peerId !== conn.peer && x.id !== member.id);
          // A rejoining member with the same id replaces their old connection.
          for (const [pid, c] of this.conns) if (pid !== conn.peer && c.member && c.member.id === member.id) { try { c.conn.close(); } catch { /* closed */ } this.conns.delete(pid); }
          entry.member = member;
          this.members.push(member);
          conn.send({ type: 'welcome', you: member.id });
          conn.send(this._roomMsg());
          conn.send({ type: 'pb', pb: this._pb() });
          this.toast(`${member.name} joined`);
          this.changed();
          return;
        }
        case 'ping': conn.send({ type: 'pong', t: msg.t, h: now() }); return;
        case 'status': {
          const m = entry.member; if (!m) return;
          m.np = msg.np || null; m.sync = msg.sync !== false;
          this.emit('members'); this._scheduleRoomBroadcast();
          return;
        }
        case 'cmd': {
          const m = entry.member; if (!m) return;
          // Songs added through someone's Discord bot carry that Discord user's name.
          const by = msg.by && typeof msg.by.name === 'string'
            ? { id: String(msg.by.id || m.id).slice(0, 64), name: String(msg.by.name).slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(msg.by.color) ? msg.by.color : '#5865f2' }
            : { id: m.id, name: m.name, color: m.color };
          const own = (uidv) => this.queue.find((t) => t.uid === uidv)?.addedBy?.id === m.id;
          const allowed = this.guestsControl || msg.action === 'add' || (msg.action === 'remove' && own(msg.uid));
          if (!allowed) { conn.send({ type: 'toast', msg: 'The host has controls locked.' }); return; }
          const args = { ...msg };
          if (args.action === 'add') args.items = (args.items || []).slice(0, 500).map(cleanItem);
          this.apply(msg.action, args, by);
          return;
        }
        default:
      }
    }
    _roomMsg() {
      return {
        type: 'room', code: this.code, guestsControl: this.guestsControl,
        members: this.members.map(({ peerId, ...m }) => m), via: undefined,
        queue: this.queue, history: this.history.slice(-30), current: this.current,
      };
    }
    _scheduleRoomBroadcast() {
      if (this._roomT) return;
      this._roomT = setTimeout(() => { this._roomT = null; this._sendAll(this._roomMsg()); }, 120);
    }
    _sendAll(msg) {
      for (const { conn, member } of this.conns.values()) if (member && conn.open) { try { conn.send(msg); } catch { /* dropped */ } }
    }
    _pb() {
      const s = this.player;
      const pos = (s.position || 0) + (s.playing && s.t ? (now() - s.t) / 1000 : 0);
      return { videoId: s.ad ? (this._lastPb?.videoId || null) : s.videoId || null, playing: !!s.playing && !s.ad, position: pos, at: now() };
    }
    _maybeBroadcastPb() {
      if (this.player.ad) return;
      const pb = this._pb(), last = this._lastPb;
      if (!last || last.videoId !== pb.videoId || last.playing !== pb.playing) return this._broadcastPb(true);
      const expected = last.position + (last.playing ? (pb.at - last.at) / 1000 : 0);
      if (Math.abs(expected - pb.position) > 1.5) this._broadcastPb(true);
    }
    _broadcastPb(force) {
      if (this.role !== 'host') return;
      const pb = this._pb();
      if (!force && this._lastPb && now() - this._lastPb.at < 2500) return;
      this._lastPb = pb;
      this._sendAll({ type: 'pb', pb });
    }

    setGuestsControl(v) { this.guestsControl = !!v; this.changed(); }

    join(rawCode, attempt = 0) {
      const code = Session.normalizeCode(rawCode);
      if (!code) { this.toast('That code doesn\'t look right — it\'s 6 letters/numbers like K7Q-M2X.', { error: true }); return; }
      if (this.role === 'host') { this.toast('End your own room before joining another.', { error: true }); return; }
      if (this.role === 'guest' && attempt === 0) this.leave(true);
      this.status = attempt ? 'reconnecting' : 'connecting'; this.code = code; this.emit('change');
      if (!this._soloBackup) this._soloBackup = { queue: this.queue, history: this.history, current: this.current };
      // Try a direct connection first; if it isn't up within a few seconds
      // (or fails outright), go through the encrypted relay. First one wins.
      const token = ++this._joinToken || (this._joinToken = 1);
      const transport = this.opts.transport || 'auto';
      let done = false, relayStarted = false, failures = 0, why = 'unreachable';
      const attempts = (transport === 'auto' ? 2 : 1);
      const stale = () => token !== this._joinToken;
      const finish = (conn, via) => {
        if (done || stale()) { try { conn.close(); } catch { /* */ } return; }
        done = true; clearTimeout(relayT);
        if (via === 'relay' && this.peer) { try { this.peer.destroy(); } catch { /* */ } this.peer = null; }
        if (via === 'direct' && this.relay) { this.relay.close(); this.relay = null; }
        this.hostConn = conn; this.via = via;
        this.role = 'guest'; this.status = 'live'; this._clock = [];
        conn.on('data', (msg) => this._onGuestData(msg));
        conn.on('close', () => { if (this.hostConn === conn && this.role === 'guest' && !this._leaving) this._lostHost(code); });
        conn.on('error', () => {});
        conn.send({ type: 'hello', member: this.memberSelf(), sync: this.sync });
        for (let i = 0; i < 5; i++) setTimeout(() => this._ping(), i * 400);
        this._lastStatus = '';
        this.changed();
      };
      const fail = (reason) => {
        if (done || stale()) return;
        if (reason === 'gone') why = 'gone';
        failures++;
        if (failures >= attempts) { done = true; clearTimeout(relayT); this._joinFailed(code, attempt, why); return; }
        startRelay();
      };
      const startRelay = () => {
        if (relayStarted || transport === 'direct' || typeof Relay === 'undefined') return;
        relayStarted = true;
        if (this.relay) this.relay.close();
        const relay = new Relay(code);
        this.relay = relay;
        relay.start()
          .then(() => (stale() ? Promise.reject(new Error('stale')) : relay.connectToHost(14000)))
          .then((conn) => finish(conn, 'relay'), (e) => { if (this.relay === relay && !done) { relay.close(); this.relay = null; } fail(e.message === 'no-host' ? 'gone' : 'unreachable'); });
      };
      const relayT = setTimeout(startRelay, transport === 'relay' ? 0 : 4000);

      if (transport !== 'relay') {
        const peer = this.peer && !this.peer.destroyed ? this.peer : new Peer(this._peerOptions());
        if (peer !== this.peer) {
          this.peer = peer;
          peer.on('disconnected', () => { if (this.peer === peer && !peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch { /* */ } }, 1000); });
        }
        peer.on('error', (err) => {
          if (this.peer !== peer || done || stale()) return;
          if (err.type === 'peer-unavailable') { fail('gone'); return; }
          if (['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(err.type)) fail('unreachable');
        });
        const go = () => {
          if (done || stale()) return;
          const conn = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
          conn.on('open', () => finish(conn, 'direct'));
          setTimeout(() => { if (!conn.open && !done && !stale()) { try { conn.close(); } catch { /* */ } fail('unreachable'); } }, 15000);
        };
        if (peer.open) go(); else peer.once('open', go);
      }
    }
    _joinFailed(code, attempt, why) {
      if (this.role === 'guest' && attempt < 5) {
        setTimeout(() => this.join(code, attempt + 1), 1500 * (attempt + 1));
        return;
      }
      this._teardown();
      this.toast(why === 'gone'
        ? 'No room with that code. Check it, or ask the host if their room is still open.'
        : 'Couldn\'t reach that room. Check your internet connection, or ask the host if Wavelength is still open.', { error: true });
    }
    _lostHost(code) {
      this.status = 'reconnecting'; this.emit('change');
      this.toast('Lost the host — reconnecting…');
      setTimeout(() => this.join(code, 1), 1000);
    }
    _onGuestData(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'room': {
          this.queue = msg.queue || []; this.history = msg.history || []; this.current = msg.current || null;
          this.members = msg.members || []; this.guestsControl = msg.guestsControl !== false;
          this.changed();
          return;
        }
        case 'pb': {
          const pb = msg.pb; if (!pb) return;
          this.hostPb = { ...pb, at: pb.at };
          this._syncCheck(true);
          return;
        }
        case 'pong': {
          const t1 = now(), rtt = t1 - msg.t;
          this._clock.push({ rtt, off: msg.h + rtt / 2 - t1 });
          this._clock = this._clock.slice(-8);
          const best = [...this._clock].sort((a, b) => a.rtt - b.rtt)[0];
          this.offset = best.off;
          return;
        }
        case 'toast': this.toast(msg.msg); return;
        case 'end': {
          this._leaving = true;
          this._teardown();
          this.toast('The host ended the room. Your old Up Next is back.');
          return;
        }
        default:
      }
    }
    _ping() { if (this.hostConn && this.hostConn.open) this.hostConn.send({ type: 'ping', t: now() }); }
    _reportStatus() {
      if (this.role !== 'guest' || !this.hostConn || !this.hostConn.open) return;
      const np = this._np();
      const key = JSON.stringify([np && np.videoId, np && np.title, np && np.playing, this.sync]);
      if (key === this._lastStatus) return;
      this._lastStatus = key;
      this.hostConn.send({ type: 'status', np, sync: this.sync });
    }

    setSync(v) {
      this.sync = !!v; this._loading = null;
      this._lastStatus = ''; this._reportStatus();
      this.changed();
      if (this.sync) { this._lastSeek = 0; this._syncCheck(true); }
    }

    // Steer the local player toward the host's playback.
    _syncCheck(fromHost) {
      if (this.role !== 'guest' || !this.sync || !this.hostPb) return;
      const s = this.player, pb = this.hostPb, t = now();
      if (!s.ready || s.ad || !pb.videoId) return;
      if (s.videoId !== pb.videoId) {
        if (this._loading && this._loading.id === pb.videoId && t - this._loading.at < 9000) return;
        this._loading = { id: pb.videoId, at: t };
        this.api.player('load', pb.videoId);
        return;
      }
      this._loading = null;
      const hostPos = pb.position + (pb.playing ? (t + this.offset - pb.at) / 1000 : 0);
      const myPos = (s.position || 0) + (s.playing && s.t ? (t - s.t) / 1000 : 0);
      const dur = s.duration || 0;
      if (pb.playing && !s.playing && (!dur || hostPos < dur - 1)) this.api.player('play');
      else if (!pb.playing && s.playing) this.api.player('pause');
      if (Math.abs(myPos - hostPos) > 1.1 && t - this._lastSeek > 3000 && (!dur || hostPos < dur - 1.5)) {
        this._lastSeek = t;
        this.api.player('seek', hostPos + (pb.playing ? 0.35 : 0));
      }
      if (fromHost) this.emit('sync');
    }

    _tick() {
      if (this.role === 'guest') {
        this._syncCheck();
        if (Date.now() % 10000 < 1000) this._ping();
      }
      if (this.role === 'host') this._broadcastPb(false);
    }

    send(msg) {
      if (this.hostConn && this.hostConn.open) { this.hostConn.send(msg); return true; }
      this.toast('Not connected to the room right now.', { error: true });
      return false;
    }

    leave(silent) {
      if (this.role === 'host') {
        this._sendAll({ type: 'end' });
        setTimeout(() => this._teardown(), 300);
        if (!silent) this.toast('Room ended.');
        this.role = 'solo'; this.status = 'idle'; this.code = null; this.members = [];
        this.changed();
        return;
      }
      if (this.role === 'guest' || this.status !== 'idle') {
        this._leaving = true;
        this._teardown();
        if (!silent) this.toast('You left the room.');
      }
    }
    _teardown() {
      const wasGuest = this.role === 'guest' || this._soloBackup;
      try { this.hostConn && this.hostConn.close(); } catch { /* */ }
      for (const { conn } of this.conns.values()) { try { conn.close(); } catch { /* */ } }
      this.conns.clear();
      try { this.peer && this.peer.destroy(); } catch { /* */ }
      if (this.relay) { this.relay.close(); this.relay = null; }
      this._joinToken = (this._joinToken || 0) + 1; this._hostToken = (this._hostToken || 0) + 1;
      this.via = null;
      this.peer = null; this.hostConn = null; this.hostPb = null; this._lastPb = null;
      this.role = 'solo'; this.status = 'idle'; this.code = null; this.members = [];
      if (wasGuest && this._soloBackup) {
        this.queue = this._soloBackup.queue; this.history = this._soloBackup.history; this.current = null;
      }
      this._soloBackup = null;
      setTimeout(() => { this._leaving = false; }, 500);
      this.changed();
    }
    _errText(err) {
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) return 'Can\'t reach the room server. Check your internet connection and try again.';
      if (err.type === 'browser-incompatible') return 'Peer connections are unavailable on this machine.';
      return 'Room error: ' + (err.message || err.type);
    }
  }

  window.Session = Session;
})();
