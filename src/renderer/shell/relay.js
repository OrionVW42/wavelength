// Relay transport for listening rooms.
//
// When two computers can't connect directly (strict routers, hotspots,
// Starlink, school/work networks), room messages travel through free public
// MQTT servers instead. Several servers are used at once, so one being down
// doesn't matter. Every message is encrypted (AES-GCM) with a key derived from
// the room code: the servers only ever see an unreadable blob on a topic
// named after a hash of the code.
//
// RelayConn mimics the parts of a PeerJS DataConnection the session uses:
// .open, .peer, .send(), .close(), .on('open'|'data'|'close'|'error').
/* global mqtt */
(() => {
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const KEEPALIVE_MS = 4000;
  const DEAD_MS = 20000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');

  async function deriveKey(code) {
    const base = await crypto.subtle.importKey('raw', enc.encode('wavelength-room:' + code), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('wavelength-relay-v1'), iterations: 120000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  class Emitter {
    constructor() { this._l = {}; }
    on(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); return this; }
    once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
    off(ev, fn) { this._l[ev] = (this._l[ev] || []).filter((f) => f !== fn); return this; }
    emit(ev, ...a) { for (const f of (this._l[ev] || []).slice()) { try { f(...a); } catch (e) { console.error(e); } } }
  }

  class RelayConn extends Emitter {
    constructor(relay, sendTopic, peer, selfId) {
      super();
      this.relay = relay; this.sendTopic = sendTopic; this.peer = peer; this.selfId = selfId;
      this.open = false; this.closed = false; this.lastHeard = Date.now();
      this.via = 'relay';
    }
    _start() {
      this.open = true; this.lastHeard = Date.now();
      this._ka = setInterval(() => {
        if (Date.now() - this.lastHeard > DEAD_MS) { this._end(); return; }
        this._post({ k: 'ka' });
      }, KEEPALIVE_MS);
      this.emit('open');
    }
    _post(m) { return this.relay.publish(this.sendTopic, { ...m, f: this.selfId }); }
    _heard() { this.lastHeard = Date.now(); }
    send(msg) { if (this.open) this._post({ k: 'd', d: msg }); }
    close() { if (this.closed) return; this._post({ k: 'close' }); this._end(); }
    _end() {
      if (this.closed) return;
      this.closed = true; this.open = false;
      clearInterval(this._ka);
      this.emit('close');
    }
  }

  class Relay {
    constructor(code) {
      this.code = code;
      this.id = rid();               // this relay endpoint's id
      this.clients = [];
      this.subs = new Map();         // topic -> handler(msg)
      this.seen = new Map();         // message id -> time (dedupe across brokers)
      this.closed = false;
    }

    async start(timeoutMs = 9000) {
      if (typeof mqtt === 'undefined') throw new Error('relay library missing');
      this.key = await deriveKey(this.code);
      this.base = 'wavelength/v1/' + hex(await crypto.subtle.digest('SHA-256', enc.encode('wl-topic:' + this.code))).slice(0, 32);
      return new Promise((resolve, reject) => {
        let ok = false;
        const fail = setTimeout(() => { if (!ok) reject(new Error('relay-unreachable')); }, timeoutMs);
        for (const url of BROKERS) {
          let c;
          try {
            c = mqtt.connect(url, { clientId: 'wl_' + rid(), clean: true, keepalive: 30, connectTimeout: 8000, reconnectPeriod: 4000, protocolVersion: 4 });
          } catch { continue; }
          c.on('connect', () => {
            for (const t of this.subs.keys()) c.subscribe(t, { qos: 0 });
            if (!ok) { ok = true; clearTimeout(fail); resolve(this); }
          });
          c.on('message', (topic, payload) => this._onMessage(topic, payload));
          c.on('error', () => { /* reconnects on its own */ });
          this.clients.push(c);
        }
      });
    }
    get connected() { return this.clients.some((c) => c.connected); }

    subscribe(topic, handler) {
      this.subs.set(topic, handler);
      for (const c of this.clients) if (c.connected) c.subscribe(topic, { qos: 0 });
    }
    async publish(topic, obj) {
      if (this.closed) return;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = enc.encode(JSON.stringify({ ...obj, i: rid() }));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, body));
      const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
      const payload = b64(out);
      for (const c of this.clients) if (c.connected) { try { c.publish(topic, payload, { qos: 0 }); } catch { /* broker dropped */ } }
    }
    async _onMessage(topic, payload) {
      const h = this.subs.get(topic);
      if (!h) return;
      let msg;
      try {
        const raw = unb64(typeof payload === 'string' ? payload : dec.decode(payload));
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, this.key, raw.subarray(12));
        msg = JSON.parse(dec.decode(pt));
      } catch { return; } // not ours / wrong code / garbage
      if (!msg || !msg.i || this.seen.has(msg.i)) return;
      this.seen.set(msg.i, Date.now());
      if (this.seen.size > 2000) { const cut = Date.now() - 60000; for (const [k, t] of this.seen) if (t < cut) this.seen.delete(k); }
      h(msg);
    }

    // ---------------------------------------------------- host side
    // Accept guests: calls onConn(conn) with a RelayConn per guest.
    listenHost(onConn) {
      this.guests = new Map();
      this.subscribe(this.base + '/h', (m) => {
        if (!m.f || typeof m.f !== 'string') return;
        let conn = this.guests.get(m.f);
        if (m.k === 'open') {
          if (!conn || conn.closed) {
            conn = new RelayConn(this, `${this.base}/g/${m.f}`, 'relay:' + m.f, this.id);
            this.guests.set(m.f, conn);
            conn.on('close', () => { if (this.guests.get(m.f) === conn) this.guests.delete(m.f); });
            onConn(conn);
            conn._start();
          }
          conn._heard();
          conn._post({ k: 'ack' });
          return;
        }
        if (!conn || conn.closed) { if (m.k !== 'close') this.publish(`${this.base}/g/${m.f}`, { k: 'reset', f: this.id }); return; }
        conn._heard();
        if (m.k === 'd') conn.emit('data', m.d);
        else if (m.k === 'close') conn._end();
      });
    }

    // ---------------------------------------------------- guest side
    // Resolves with an open RelayConn once the host answers, or rejects
    // with 'no-host' if nobody answers in time.
    connectToHost(timeoutMs = 12000) {
      return new Promise((resolve, reject) => {
        const conn = new RelayConn(this, this.base + '/h', 'relay:host', this.id);
        let answered = false;
        this.subscribe(`${this.base}/g/${this.id}`, (m) => {
          if (m.k === 'ack') {
            conn._heard();
            if (!answered) { answered = true; clearInterval(knock); clearTimeout(fail); conn._start(); resolve(conn); }
            return;
          }
          if (!answered) return;
          conn._heard();
          if (m.k === 'd') conn.emit('data', m.d);
          else if (m.k === 'close' || m.k === 'reset') conn._end();
        });
        const sendOpen = () => this.publish(this.base + '/h', { k: 'open', f: this.id });
        const knock = setInterval(sendOpen, 1500);
        setTimeout(sendOpen, 300);
        const fail = setTimeout(() => { if (!answered) { clearInterval(knock); reject(new Error('no-host')); } }, timeoutMs);
      });
    }

    close() {
      if (this.closed) return;
      if (this.guests) for (const c of this.guests.values()) { try { c.close(); } catch { /* gone */ } }
      // Let the goodbye messages go out before disconnecting.
      setTimeout(() => {
        this.closed = true;
        for (const c of this.clients) { try { c.end(true); } catch { /* gone */ } }
        this.clients = [];
      }, 400);
    }
  }

  window.Relay = Relay;
})();
