// Wavelength's built-in Discord bot.
//
// The bot is this Wavelength: whatever it plays (solo, hosting a room, or as
// a guest in someone's room) is streamed into a Discord voice channel, and
// people in the server control the shared Up Next with slash commands, a live
// player posted in the voice channel's chat, and buttons. Audio comes from
// the player itself (see the "audio tap" in src/inject/bridge.js), so Discord
// hears the same ad-free stream at the same moment as the room. Nothing is
// downloaded separately.
const { PassThrough } = require('stream');

const BLURPLE = 0x8b5cf6;
const fmt = (sec) => { sec = Math.max(0, Math.round(+sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const appIdFromToken = (t) => { try { return Buffer.from(String(t).split('.')[0], 'base64').toString('utf8').replace(/\D/g, '') || null; } catch { return null; } };
const INVITE_PERMS = '36785152'; // View Channels, Send Messages, Embed Links, Read History, Connect, Speak, Voice Activity
const WHERE = { now: 'Plays now', next: 'Plays next', end: 'Added to Up Next' };
const parseTime = (s) => {
  s = String(s || '').trim();
  if (/^\d+$/.test(s)) return +s;
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
};

// ------------------------------------------------------------ audio buffer
// The player page delivers audio in small bursts, and anything that keeps the
// app busy for a moment (a song loading, the window redrawing, the PC doing
// something else) delays a burst. Fed straight to Discord, every delay was a
// skip. This keeps a cushion of audio queued for Discord:
//   * it starts playing only once `target` ms are buffered;
//   * if Discord ever runs dry anyway, it re-fills the cushion once (one short
//     gap instead of a stutter) and makes the cushion bigger, up to 1.5 s;
//   * after a long smooth stretch the cushion shrinks back a little;
//   * if a backlog builds up (e.g. a burst after a long stall), it skips
//     ahead once so Discord doesn't fall further and further behind.
const BYTES_PER_MS = 192; // 48 kHz × 2 channels × 2 bytes
class AudioFeeder {
  constructor() {
    this.min = 300; this.max = 1500;
    this.target = this.min;
    this.stats = { underruns: 0, skips: 0 };
    this.lastTrouble = Date.now();
    this.out = null;
  }
  attach(stream, resource, player) {
    this.out = { stream, resource, player, written: 0 };
    this.hold = []; this.holdBytes = 0; this.state = 'filling'; this.dropBytes = 0;
  }
  // Audio handed to Discord but not played yet.
  aheadMs() {
    const o = this.out; if (!o) return 0;
    return Math.max(0, o.written / BYTES_PER_MS - o.resource.playbackDuration);
  }
  bufferedMs() { return this.aheadMs() + this.holdBytes / BYTES_PER_MS; }
  _write(buf) { const o = this.out; o.stream.write(buf); o.written += buf.length; }
  push(buf) {
    const o = this.out; if (!o) return;
    if (this.dropBytes > 0) { this.dropBytes -= buf.length; return; }
    if (this.state === 'filling') {
      this.hold.push(buf); this.holdBytes += buf.length;
      if (this.bufferedMs() >= this.target) {
        for (const b of this.hold) this._write(b);
        this.hold = []; this.holdBytes = 0; this.state = 'flowing'; this.flowSince = Date.now();
      }
      return;
    }
    // Too far behind: skip ahead once, back to the cushion.
    const ahead = this.aheadMs();
    if (ahead > this.target + 1200) {
      this.dropBytes = Math.round((ahead - this.target) * BYTES_PER_MS) - buf.length;
      this.stats.skips++;
      return;
    }
    this._write(buf);
  }
  // Called every 20 ms: notices Discord running dry.
  tick() {
    const o = this.out; if (!o || this.state !== 'flowing') return;
    if (Date.now() - this.flowSince < 200) return; // let the player pick the refill up first
    const st = o.player.state;
    if (st.status === 'playing' && st.missedFrames > 0) {
      this.stats.underruns++;
      this.target = Math.min(this.max, this.target + 200);
      this.state = 'filling';
      this.lastTrouble = Date.now();
    } else if (Date.now() - this.lastTrouble > 90000 && this.target > this.min) {
      this.target = Math.max(this.min, this.target - 100);
      this.lastTrouble = Date.now();
    }
  }
  info() { return { state: this.state, targetMs: this.target, bufferedMs: Math.round(this.bufferedMs()), ...this.stats }; }
}

class DiscordBot {
  // deps: { player(), summary(), act(action, args, by), search(q, isId), room(op, code), capture(on), volume(), setVolume(v), onStatus(s), log(...) }
  constructor(deps) {
    this.d = deps;
    this.client = null;
    this.status = { state: 'off' };
    this.voice = null;       // { connection, player, resource, stream, channelId, guildId, channelName }
    this.panels = new Map(); // channelId -> Message (live player)
    this.picks = new Map();  // key -> { at, results, q }
    this.songs = new Map();  // videoId -> song, from recent searches (autocomplete picks)
    this.feeder = new AudioFeeder();
    this._sink = (buf) => this._onPcm(buf);
    this._aloneT = null;
    this._lastVideo = null;
  }

  setStatus(patch) { this.status = { ...this.status, ...patch }; this.d.onStatus(this.status); }
  inviteUrl(token) {
    const id = (this.client && this.client.application && this.client.application.id) || appIdFromToken(token);
    return id ? `https://discord.com/oauth2/authorize?client_id=${id}&permissions=${INVITE_PERMS}&scope=bot%20applications.commands` : null;
  }

  // ------------------------------------------------------------ lifecycle
  async start(token, guildId) {
    await this.stop();
    if (!token) { this.setStatus({ state: 'error', error: 'Add the bot token first.' }); return; }
    const { Client, GatewayIntentBits, Events } = require('discord.js');
    this.guildId = String(guildId || '').trim() || null;
    this.setStatus({ state: 'connecting', error: null, tag: null, voice: null });
    // GuildMessages (not the privileged message-content one) only so the bot
    // knows when chat has moved past its player and should re-post it.
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] });
    this.client = client;
    client.once(Events.ClientReady, async (c) => {
      this.setStatus({ state: 'online', tag: c.user.tag, guilds: c.guilds.cache.size, invite: this.inviteUrl(token) });
      this.updatePresence(true);
      try { await this.registerCommands(); } catch (e) { this.d.log('[discord] commands:', e.message); this.setStatus({ warning: 'Couldn\'t register slash commands: ' + e.message }); }
      if (process.env.WL_DISCORD_DIAG) this.diagAutojoin(c);
    });
    client.on(Events.InteractionCreate, (i) => this.onInteraction(i).catch((e) => {
      this.d.log('[discord] interaction:', e.message);
      if (i.isAutocomplete()) return;
      const reply = { content: '⚠️ ' + clip(e.message, 300), ephemeral: true };
      (i.deferred || i.replied ? i.followUp(reply) : i.reply(reply)).catch(() => {});
    }));
    client.on(Events.VoiceStateUpdate, () => this.checkAlone());
    client.on('error', (e) => this.d.log('[discord]', e.message));
    // Progress bar + keep the voice channel's player fresh.
    this._tickT = setInterval(() => { if (this.panels.size && (this.d.player() || {}).playing) this.refreshPanels(); }, 15000);
    try {
      await client.login(token);
    } catch (e) {
      this.client = null;
      const msg = /TOKEN_INVALID|invalid token|401/i.test(e.message) ? 'That token was rejected. Reset it in the Developer Portal and paste the new one.' : e.message;
      this.setStatus({ state: 'error', error: msg });
    }
  }

  async stop() {
    await this.leaveVoice();
    clearInterval(this._tickT);
    if (this.client) { try { await this.client.destroy(); } catch { /* gone */ } }
    this.client = null; this.panels.clear();
    if (this.status.state !== 'off') this.setStatus({ state: 'off', tag: null, voice: null, error: null, warning: null });
  }

  // ------------------------------------------------------------ profile
  // The bot's profile shows what's playing: "Listening to Song — Artist".
  updatePresence(now) {
    clearTimeout(this._presT);
    if (!now) { this._presT = setTimeout(() => this.updatePresence(true), 1500); return; }
    const c = this.client; if (!c || !c.user) return;
    const { ActivityType } = require('discord.js');
    const p = this.d.player() || {};
    let act;
    if (p.videoId && p.playing && !p.ad) act = { type: ActivityType.Listening, name: clip(`${p.title}${p.artist ? ' — ' + p.artist : ''}`, 120) };
    else if (p.videoId && !p.ad) act = { type: ActivityType.Custom, name: 'Custom Status', state: clip(`⏸ Paused · ${p.title}`, 120) };
    else act = { type: ActivityType.Custom, name: 'Custom Status', state: '🎵 /play to add a song' };
    const key = JSON.stringify(act);
    if (key === this._presKey) return;
    this._presKey = key;
    try { c.user.setPresence({ activities: [act], status: 'online' }); } catch (e) { this.d.log('[discord] presence:', e.message); }
  }

  // ------------------------------------------------------------ commands
  commandDefs() {
    const { SlashCommandBuilder } = require('discord.js');
    const whereOpt = (o) => o.setName('where').setDescription('Where it goes (leave empty to choose with buttons)')
      .addChoices({ name: 'Play now', value: 'now' }, { name: 'Play next', value: 'next' }, { name: 'End of Up Next', value: 'end' });
    return [
      new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and play Wavelength there'),
      new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
      new SlashCommandBuilder().setName('play').setDescription('Find a song and play it now, next, or at the end of Up Next')
        .addStringOption((o) => o.setName('song').setDescription('Start typing: song, artist, or a YouTube Music link').setRequired(true).setAutocomplete(true))
        .addStringOption(whereOpt),
      new SlashCommandBuilder().setName('search').setDescription('Search and pick from a list of songs')
        .addStringOption((o) => o.setName('song').setDescription('What to search for').setRequired(true)),
      new SlashCommandBuilder().setName('player').setDescription('Post the live player with controls in this channel'),
      new SlashCommandBuilder().setName('np').setDescription('What\'s playing (live player with controls)'),
      new SlashCommandBuilder().setName('queue').setDescription('Show Up Next'),
      new SlashCommandBuilder().setName('skip').setDescription('Skip to the next song'),
      new SlashCommandBuilder().setName('previous').setDescription('Go back a song'),
      new SlashCommandBuilder().setName('pause').setDescription('Pause'),
      new SlashCommandBuilder().setName('resume').setDescription('Resume'),
      new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle Up Next'),
      new SlashCommandBuilder().setName('remove').setDescription('Remove a song from Up Next')
        .addIntegerOption((o) => o.setName('song').setDescription('Pick the song').setRequired(true).setMinValue(1).setAutocomplete(true)),
      new SlashCommandBuilder().setName('clear').setDescription('Empty Up Next (the current song keeps playing)'),
      new SlashCommandBuilder().setName('seek').setDescription('Jump to a time in the current song')
        .addStringOption((o) => o.setName('time').setDescription('Like 1:30 or 90').setRequired(true)),
      new SlashCommandBuilder().setName('volume').setDescription('Set the bot\'s volume in Discord')
        .addIntegerOption((o) => o.setName('percent').setDescription('0–150').setRequired(true).setMinValue(0).setMaxValue(150)),
      new SlashCommandBuilder().setName('room').setDescription('Wavelength listening rooms')
        .addSubcommand((s) => s.setName('info').setDescription('Show the room code so friends can join in the Wavelength app'))
        .addSubcommand((s) => s.setName('start').setDescription('Host a new room'))
        .addSubcommand((s) => s.setName('join').setDescription('Join a room by code').addStringOption((o) => o.setName('code').setDescription('Like K7Q-M2X').setRequired(true)))
        .addSubcommand((s) => s.setName('leave').setDescription('Leave or end the room')),
      new SlashCommandBuilder().setName('help').setDescription('How to use the Wavelength bot'),
    ].map((c) => c.toJSON());
  }
  async registerCommands() {
    const defs = this.commandDefs();
    const app = this.client.application;
    if (this.guildId) {
      const g = await this.client.guilds.fetch(this.guildId).catch(() => null);
      if (!g) throw new Error('The bot isn\'t in that server yet. Use "Add bot to a server" first.');
      await g.commands.set(defs);
      this.setStatus({ commands: `${defs.length} commands in ${g.name}` });
    } else {
      await app.commands.set(defs); // global: can take a while to appear
      this.setStatus({ commands: `${defs.length} commands (all servers)` });
    }
  }

  // ------------------------------------------------------------ interactions
  who(i) {
    const name = (i.member && (i.member.displayName || i.member.nickname)) || i.user.globalName || i.user.username;
    return { id: i.user.id, name: clip(name, 28) };
  }
  async onInteraction(i) {
    if (i.isAutocomplete()) return this.onAutocomplete(i);
    if (i.isButton() && i.customId.startsWith('wl:')) return this.onButton(i);
    if (i.isStringSelectMenu() && i.customId.startsWith('wl:')) return this.onSelect(i);
    if (i.isModalSubmit() && i.customId === 'wl:addmodal') {
      await i.deferReply({ ephemeral: true });
      return this.showResults(i, i.fields.getTextInputValue('q'));
    }
    if (!i.isChatInputCommand()) return;
    const by = this.who(i);
    switch (i.commandName) {
      case 'join': return this.cmdJoin(i);
      case 'leave': await this.leaveVoice(); return i.reply({ content: '👋 Left the voice channel.' });
      case 'play': return this.cmdPlay(i);
      case 'search': await i.deferReply({ ephemeral: true }); return this.showResults(i, i.options.getString('song'));
      case 'player': case 'np': return this.sendPanel(i);
      case 'queue': return i.reply({ embeds: [this.queueEmbed()], components: this.queueRow() });
      case 'skip': this.d.act('next', {}, by); return this.ack(i, `⏭️ Skipped by ${by.name}`);
      case 'previous': this.d.act('prev', {}, by); return this.ack(i, `⏮️ Back a song (${by.name})`);
      case 'pause': this.d.act('pause', {}, by); return this.ack(i, `⏸️ Paused by ${by.name}`);
      case 'resume': this.d.act('play', {}, by); return this.ack(i, `▶️ Resumed by ${by.name}`);
      case 'shuffle': this.d.act('shuffle', {}, by); return this.ack(i, `🔀 Up Next shuffled by ${by.name}`);
      case 'clear': this.d.act('clear', {}, by); return this.ack(i, `🧹 Up Next cleared by ${by.name}`);
      case 'remove': {
        const n = i.options.getInteger('song');
        const t = ((this.d.summary() || {}).upNext || [])[n - 1];
        if (!t || !t.uid) return i.reply({ content: 'There\'s no song at that spot in Up Next.', ephemeral: true });
        this.d.act('remove', { uid: t.uid }, by);
        return this.ack(i, `🗑️ Removed **${clip(t.title, 80)}** (${by.name})`);
      }
      case 'seek': {
        const sec = parseTime(i.options.getString('time'));
        if (sec == null) return i.reply({ content: 'Use a time like **1:30** or **90**.', ephemeral: true });
        this.d.act('seek', { position: sec }, by);
        return this.ack(i, `⏩ Jumped to ${fmt(sec)} (${by.name})`);
      }
      case 'volume': {
        const v = i.options.getInteger('percent');
        this.setVolume(v);
        return this.ack(i, `🔊 Bot volume ${v}%`);
      }
      case 'room': return this.cmdRoom(i);
      case 'help': return i.reply({ embeds: [this.helpEmbed()], ephemeral: true });
      default:
    }
  }
  async ack(i, text) {
    await i.reply({ content: text });
    this.onPlayerChange();
  }

  // ------------------------------------------------------------ finding songs
  remember(results) {
    for (const r of results || []) if (r && r.videoId) this.songs.set(r.videoId, r);
    if (this.songs.size > 500) for (const k of [...this.songs.keys()].slice(0, 200)) this.songs.delete(k);
    return results;
  }
  async search(q) {
    const link = /(?:v=|youtu\.be\/)([\w-]{11})/.exec(q);
    const results = await this.d.search(link ? link[1] : q, !!link);
    return this.remember((results || []).filter(Boolean));
  }
  // Suggestions while typing /play (and the song list for /remove).
  async onAutocomplete(i) {
    const f = i.options.getFocused(true);
    if (i.commandName === 'remove') {
      const q = ((this.d.summary() || {}).upNext || []);
      const want = String(f.value || '').toLowerCase();
      return i.respond(q.map((t, n) => ({ name: clip(`${n + 1}. ${t.title} — ${t.artist}${t.by ? ` (added by ${t.by})` : ''}`, 100), value: n + 1 }))
        .filter((o) => !want || o.name.toLowerCase().includes(want)).slice(0, 25));
    }
    const q = String(f.value || '').trim();
    if (q.length < 2) return i.respond([]);
    let results = [];
    try {
      results = await Promise.race([this.search(q), new Promise((r) => setTimeout(() => r([]), 2300))]);
    } catch { /* show nothing */ }
    return i.respond(results.slice(0, 10).map((r) => ({
      name: clip(`${r.title} — ${r.artist}${r.duration ? ` (${fmt(r.duration)})` : ''}${r.kind === 'Video' ? ' · video' : ''}`, 100),
      value: `v:${r.videoId}`,
    }))).catch(() => {});
  }
  async cmdPlay(i) {
    const q = i.options.getString('song');
    const where = i.options.getString('where');
    const by = this.who(i);
    const picked = /^v:([\w-]{11})$/.exec(q);
    if (picked) {
      // Chosen from the suggestions.
      let song = this.songs.get(picked[1]);
      if (!song) { await i.deferReply({ ephemeral: !where }); song = (await this.search(`https://youtu.be/${picked[1]}`))[0]; }
      if (!song) return (i.deferred ? i.editReply.bind(i) : i.reply.bind(i))({ content: 'That song isn\'t available any more. Try another.', ephemeral: true });
      if (where) {
        this.d.act('add', { items: [song], where }, by);
        const msg = { embeds: [this.songEmbed(song, `${WHERE[where]} · requested by ${by.name}`)] };
        await (i.deferred ? i.editReply(msg) : i.reply(msg));
        return this.afterAdd(i);
      }
      const key = this.keep([song], q);
      const msg = { embeds: [this.songEmbed(song, 'Where should it go?')], components: this.placeRow(key, 0, false), ephemeral: true };
      return i.deferred ? i.editReply(msg) : i.reply(msg);
    }
    await i.deferReply({ ephemeral: !where });
    if (where) {
      // Typed text with a place: take the best match straight away.
      const results = await this.search(q);
      const song = results.find((r) => r.kind === 'Song') || results[0];
      if (!song) return i.editReply({ content: `Couldn't find anything for “${clip(q, 80)}”.` });
      this.d.act('add', { items: [song], where }, by);
      await i.editReply({ embeds: [this.songEmbed(song, `${WHERE[where]} · requested by ${by.name}`)] });
      return this.afterAdd(i);
    }
    return this.showResults(i, q);
  }
  keep(results, q) {
    const now = Date.now();
    for (const [k, v] of this.picks) if (now - v.at > 30 * 60e3) this.picks.delete(k);
    const key = now.toString(36) + Math.random().toString(36).slice(2, 5);
    this.picks.set(key, { at: now, results, q });
    return key;
  }
  // A list of matches to pick from (an ephemeral message only you see).
  async showResults(i, q) {
    const results = (await this.search(q)).slice(0, 10);
    if (!results.length) return i.editReply({ content: `No songs found for “${clip(q, 80)}”.`, components: [] });
    const key = this.keep(results, q);
    return i.editReply(this.resultsMsg(key));
  }
  resultsMsg(key) {
    const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
    const pick = this.picks.get(key);
    const menu = new StringSelectMenuBuilder().setCustomId(`wl:pick:${key}`).setPlaceholder('Pick the song you want')
      .addOptions(pick.results.map((r, n) => ({
        label: clip(r.title, 95),
        description: clip(`${r.artist}${r.duration ? ' · ' + fmt(r.duration) : ''}${r.kind === 'Video' ? ' · video' : ''}`, 95),
        value: String(n), emoji: n === 0 ? '⭐' : undefined,
      })));
    return { content: `🔎 Results for **${clip(pick.q, 80)}**`, embeds: [], components: [new ActionRowBuilder().addComponents(menu)] };
  }
  placeRow(key, n, withBack = true) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`wl:put:${key}:${n}:now`).setLabel('Play now').setEmoji('▶️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`wl:put:${key}:${n}:next`).setLabel('Play next').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`wl:put:${key}:${n}:end`).setLabel('Add to end').setEmoji('➕').setStyle(ButtonStyle.Secondary),
    );
    if (withBack) row.addComponents(new ButtonBuilder().setCustomId(`wl:back:${key}`).setLabel('Other results').setStyle(ButtonStyle.Secondary));
    return [row];
  }
  async afterAdd(i) {
    if (!this.voice) await i.followUp({ content: 'Tip: type **/join** while you\'re in a voice channel to hear it there.', ephemeral: true }).catch(() => {});
    this.onPlayerChange();
  }

  async onSelect(i) {
    const [, kind, key] = i.customId.split(':');
    if (kind === 'pick') {
      const pick = this.picks.get(key);
      const n = +i.values[0];
      const song = pick && pick.results[n];
      if (!song) return i.update({ content: 'That search expired. Try **/play** again.', embeds: [], components: [] });
      return i.update({ content: '', embeds: [this.songEmbed(song, 'Where should it go?')], components: this.placeRow(key, n, pick.results.length > 1) });
    }
    if (kind === 'q') {
      // A song in Up Next, picked from the player's menu.
      const uid = i.values[0];
      const t = ((this.d.summary() || {}).upNext || []).find((x) => x.uid === uid);
      if (!t) return i.reply({ content: 'That song isn\'t in Up Next any more.', ephemeral: true });
      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wl:qnow:${uid}`).setLabel('Play now').setEmoji('▶️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`wl:qnext:${uid}`).setLabel('Move to next').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`wl:qdel:${uid}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      );
      return i.reply({ content: `**${clip(t.title, 80)}** · ${clip(t.artist, 50)}${t.by ? ` · added by ${t.by}` : ''}`, components: [row], ephemeral: true });
    }
    return i.deferUpdate();
  }

  async cmdRoom(i) {
    const sub = i.options.getSubcommand();
    const sum = () => this.d.summary() || {};
    const pretty = (c) => (c ? c.slice(0, 3) + '-' + c.slice(3) : '');
    if (sub === 'info') {
      const s = sum();
      if (s.role === 'solo' || !s.code) return i.reply({ content: 'Not in a room. Use **/room start** to host one, or **/room join** with a code.' });
      return i.reply({ content: `🎧 Room **${pretty(s.code)}** · ${s.members.length} listening in Wavelength${s.role === 'guest' ? ' (joined as a guest)' : ''}. Friends can join from the Wavelength app with this code.` });
    }
    await i.deferReply();
    if (sub === 'start') this.d.room('host');
    else if (sub === 'join') this.d.room('join', i.options.getString('code'));
    else this.d.room('leave');
    // Wait for the room to settle (up to 20s), then report.
    for (let k = 0; k < 40; k++) {
      await new Promise((r) => setTimeout(r, 500));
      const s = sum();
      if (sub === 'leave' && s.role === 'solo') return i.editReply({ content: '🚪 Left the room. Wavelength is playing on its own again.' });
      if (sub !== 'leave' && s.status === 'live' && s.code) {
        return i.editReply({ content: sub === 'start'
          ? `🎉 Room **${pretty(s.code)}** is live. Friends can join it in the Wavelength app, and everyone here can add songs with **/play**.`
          : `✅ Joined room **${pretty(s.code)}**. Discord now hears that room.` });
      }
      if (sub !== 'leave' && s.role === 'solo' && s.status === 'idle' && k > 6) break;
    }
    return i.editReply({ content: sub === 'join' ? '❌ Couldn\'t join that room. Check the code and that the host is still online.' : '❌ The room didn\'t start. Check the Wavelength window for details.' });
  }

  // ------------------------------------------------------------ buttons + live player
  controls() {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const p = this.d.player() || {};
    const rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wl:prev').setEmoji('⏮️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wl:toggle').setEmoji(p.playing ? '⏸️' : '▶️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('wl:next').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wl:shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wl:add').setLabel('Add song').setEmoji('➕').setStyle(ButtonStyle.Success),
    ), new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wl:voldown').setEmoji('🔉').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wl:volup').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wl:queue').setLabel('Full Up Next').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    )];
    return rows.concat(this.queueRow());
  }
  // "Pick a song in Up Next" menu: play it now, move it next, or remove it.
  queueRow() {
    const q = ((this.d.summary() || {}).upNext || []).filter((t) => t.uid);
    if (!q.length) return [];
    const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
    const menu = new StringSelectMenuBuilder().setCustomId('wl:q').setPlaceholder('Up Next: pick a song to play now, move or remove')
      .addOptions(q.slice(0, 25).map((t, n) => ({
        label: clip(`${n + 1}. ${t.title}`, 95),
        description: clip(`${t.artist}${t.by ? ' · added by ' + t.by : ''}`, 95),
        value: t.uid,
      })));
    return [new ActionRowBuilder().addComponents(menu)];
  }
  async onButton(i) {
    const by = this.who(i);
    const [, a, key, n, where] = i.customId.split(':');
    if (a === 'queue') return i.reply({ embeds: [this.queueEmbed()], ephemeral: true });
    if (a === 'add') {
      const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
      const modal = new ModalBuilder().setCustomId('wl:addmodal').setTitle('Add a song')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q').setLabel('Song, artist, or YouTube Music link')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200).setPlaceholder('e.g. Mr. Brightside')));
      return i.showModal(modal);
    }
    if (a === 'put') {
      const pick = this.picks.get(key);
      const song = pick && pick.results[+n];
      if (!song) return i.update({ content: 'That search expired. Try **/play** again.', embeds: [], components: [] });
      this.d.act('add', { items: [song], where }, by);
      await i.update({ content: `✅ ${WHERE[where]}: **${clip(song.title, 80)}**`, embeds: [], components: [] });
      // Let everyone in the channel see it.
      await i.followUp({ embeds: [this.songEmbed(song, `${WHERE[where]} · requested by ${by.name}`)] }).catch(() => {});
      return this.afterAdd(i);
    }
    if (a === 'back') {
      if (!this.picks.get(key)) return i.update({ content: 'That search expired. Try **/play** again.', embeds: [], components: [] });
      return i.update(this.resultsMsg(key));
    }
    if (a === 'qnow' || a === 'qnext' || a === 'qdel') {
      const t = ((this.d.summary() || {}).upNext || []).find((x) => x.uid === key);
      if (!t) return i.update({ content: 'That song isn\'t in Up Next any more.', components: [] });
      if (a === 'qnow') this.d.act('playNow', { uid: key }, by);
      else if (a === 'qnext') this.d.act('move', { uid: key, to: 0 }, by);
      else this.d.act('remove', { uid: key }, by);
      await i.update({ content: `${a === 'qnow' ? '▶️ Playing' : a === 'qnext' ? '⏭️ Plays next:' : '🗑️ Removed'} **${clip(t.title, 80)}**`, components: [] });
      return this.onPlayerChange();
    }
    if (a === 'volup' || a === 'voldown') {
      const v = Math.max(0, Math.min(150, (this.d.volume() ?? 50) + (a === 'volup' ? 10 : -10)));
      this.setVolume(v);
      await i.deferUpdate();
      return this.onPlayerChange();
    }
    const p = this.d.player() || {};
    if (a === 'toggle') this.d.act(p.playing ? 'pause' : 'play', {}, by);
    else if (a === 'next') this.d.act('next', {}, by);
    else if (a === 'prev') this.d.act('prev', {}, by);
    else if (a === 'shuffle') this.d.act('shuffle', {}, by);
    await i.deferUpdate();
    this.onPlayerChange();
  }
  panelMsg() { return { embeds: [this.nowEmbed(true)], components: this.controls() }; }
  async sendPanel(i) {
    const old = this.panels.get(i.channelId);
    const msg = await i.reply({ ...this.panelMsg(), fetchReply: true });
    this.panels.set(i.channelId, msg);
    if (old && old.id !== msg.id) old.delete().catch(() => {});
  }
  // The live player in the voice channel's own chat.
  async postStation(channel) {
    try {
      if (!channel || !channel.isTextBased || !channel.isTextBased()) return false;
      const old = this.panels.get(channel.id);
      const msg = await channel.send(this.panelMsg());
      this.panels.set(channel.id, msg);
      if (old) old.delete().catch(() => {});
      return true;
    } catch (e) { this.d.log('[discord] couldn\'t post the player:', e.message); return false; }
  }
  // Keeps every posted player up to date. When the song changes and chat has
  // moved past a player, it's re-posted at the bottom so it stays in view.
  async refreshPanels(songChanged = false) {
    if (this._refreshing) { this._refreshAgain = this._refreshAgain || songChanged || 'edit'; return; }
    this._refreshing = true;
    try {
      for (const [ch, msg] of this.panels) {
        try {
          const channel = msg.channel;
          if (songChanged && channel && channel.lastMessageId && channel.lastMessageId !== msg.id) {
            const fresh = await channel.send(this.panelMsg());
            this.panels.set(ch, fresh);
            msg.delete().catch(() => {});
          } else {
            await msg.edit(this.panelMsg());
          }
        } catch { this.panels.delete(ch); }
      }
    } finally {
      this._refreshing = false;
      if (this._refreshAgain) { const again = this._refreshAgain; this._refreshAgain = null; this.refreshPanels(again === true); }
    }
  }

  // ------------------------------------------------------------ embeds
  songEmbed(song, footer) {
    const { EmbedBuilder } = require('discord.js');
    const e = new EmbedBuilder().setColor(BLURPLE).setTitle(clip(song.title, 250))
      .setURL(`https://music.youtube.com/watch?v=${song.videoId}`)
      .setDescription(`${clip(song.artist, 200)}${song.duration ? ' · ' + fmt(song.duration) : ''}`)
      .setFooter({ text: clip(footer, 200) });
    if (song.art) e.setThumbnail(song.art);
    return e;
  }
  nowEmbed(withQueue) {
    const { EmbedBuilder } = require('discord.js');
    const p = this.d.player() || {}, s = this.d.summary() || {};
    const room = s.role && s.role !== 'solo' && s.code ? ` · room ${s.code.slice(0, 3)}-${s.code.slice(3)}` : '';
    const e = new EmbedBuilder().setColor(BLURPLE).setAuthor({ name: `${p.ad ? '⏳ Ad (muted for Discord)' : p.playing ? '🎵 Now playing' : '⏸️ Paused'}${room}` });
    if (!p.videoId) e.setDescription('Nothing is playing. Press **Add song** or use **/play**.');
    else {
      const bar = p.duration ? (() => { const n = 16, k = Math.min(n, Math.round((p.position / p.duration) * n)); return '▬'.repeat(Math.max(0, k)) + '🔘' + '▬'.repeat(Math.max(0, n - k)); })() : '';
      const by = s.current && s.current.addedBy;
      e.setTitle(clip(p.title, 250)).setURL(`https://music.youtube.com/watch?v=${p.videoId}`)
        .setDescription(`${clip(p.artist, 200)}${by ? ` · added by **${clip(by.name, 40)}**` : ''}\n${bar}  \`${fmt(p.position)} / ${fmt(p.duration)}\``);
      if (p.art) e.setThumbnail(p.art);
    }
    if (withQueue) {
      const q = s.upNext || [];
      const total = s.queueLength || q.length;
      const lines = [];
      let len = 0;
      for (let n = 0; n < q.length && n < 10; n++) {
        const t = q[n];
        const line = `\`${n + 1}.\` **${clip(t.title, 50)}** · ${clip(t.artist, 30)}${t.by ? ` — _${clip(t.by, 24)}_` : ''}`;
        if (len + line.length > 950) break;
        lines.push(line); len += line.length + 1;
      }
      if (total > lines.length) lines.push(`…and ${total - lines.length} more`);
      e.addFields({ name: `Up Next${total ? ` (${total})` : ''}`, value: lines.length ? lines.join('\n') : '_Empty. Press **Add song** or use **/play**._' });
    }
    const listeners = this.voice ? this.listenerCount() : null;
    e.setFooter({ text: clip([this.voice ? `🔊 ${this.voice.channelName}${listeners != null ? ` · ${listeners} listening` : ''}` : null, `bot volume ${this.d.volume() ?? 50}%`, '/play to add songs'].filter(Boolean).join(' · '), 200) });
    return e;
  }
  queueEmbed() {
    const { EmbedBuilder } = require('discord.js');
    const p = this.d.player() || {}, s = this.d.summary() || {};
    const q = s.upNext || [];
    const total = s.queueLength || q.length;
    const lines = q.slice(0, 25).map((t, n) => `\`${n + 1}.\` **${clip(t.title, 60)}** · ${clip(t.artist, 40)}${t.by ? ` · _${clip(t.by, 24)}_` : ''}`);
    let desc = [
      p.videoId ? `▶️ **${clip(p.title, 70)}** · ${clip(p.artist, 40)}` : 'Nothing playing right now.',
      '',
      lines.length ? lines.join('\n') : '_Up Next is empty. Add songs with **/play**._',
      total > 25 ? `…and ${total - 25} more` : '',
    ].join('\n');
    if (desc.length > 4000) desc = desc.slice(0, 3990) + '\n…';
    return new EmbedBuilder().setColor(BLURPLE).setTitle(`Up Next${total ? ` (${total})` : ''}`).setDescription(desc);
  }
  helpEmbed() {
    const { EmbedBuilder } = require('discord.js');
    return new EmbedBuilder().setColor(BLURPLE).setTitle('Wavelength bot').setDescription([
      '**Get started:** join a voice channel and type **/join**. The bot plays there and posts a live player in the voice channel\'s chat.',
      '',
      '**/play** — start typing and pick a song from the suggestions, then choose **Play now**, **Play next** or **Add to end**.',
      '**/search** — see a list of matches and pick one.',
      '**/player** — post the live player (controls + Up Next) in this channel.',
      '**/queue** — see Up Next. **/remove**, **/shuffle**, **/clear** to tidy it.',
      '**/skip** · **/previous** · **/pause** · **/resume** · **/seek 1:30**',
      '**/volume** — the bot\'s volume in Discord (you can also right-click the bot to change it just for you).',
      '**/room start** / **/room join** — share the same music with friends in the Wavelength app.',
      '**/leave** — the bot leaves voice.',
    ].join('\n'));
  }
  listenerCount() {
    try {
      const ch = this.client.channels.cache.get(this.voice.channelId);
      return ch && ch.members ? ch.members.filter((m) => !m.user.bot).size : null;
    } catch { return null; }
  }

  // ------------------------------------------------------------ voice
  async cmdJoin(i) {
    const channel = i.member && i.member.voice && i.member.voice.channel;
    if (!channel) return i.reply({ content: 'Join a voice channel first, then use **/join**.', ephemeral: true });
    if (!channel.joinable || !channel.speakable) {
      return i.reply({ content: `I'm not allowed to ${!channel.joinable ? 'join' : 'speak in'} **${channel.name}**. Give the Wavelength role **Connect** and **Speak** there (channel settings → Permissions), or use another channel.`, ephemeral: true });
    }
    await i.deferReply();
    await this.joinVoice(channel);
    const posted = i.channelId === channel.id ? false : await this.postStation(channel);
    const p = this.d.player() || {};
    const where = posted ? `\nThe live player with Up Next is in <#${channel.id}>'s chat.` : '';
    if (i.channelId === channel.id) {
      // /join typed in the voice channel's own chat: the reply is the player.
      const msg = await i.editReply({ content: `🔊 Playing Wavelength in **${channel.name}**`, ...this.panelMsg() });
      this.panels.set(channel.id, msg);
      return msg;
    }
    return i.editReply({ content: `🔊 Playing Wavelength in **${channel.name}**${p.title ? ` · now: **${clip(p.title, 80)}**` : '. Add songs with **/play**.'}${where}` });
  }
  async joinVoice(channel) {
    const v = require('@discordjs/voice');
    await this.leaveVoice(true);
    const connection = v.joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true, debug: !!process.env.WL_VOICE_DEBUG, ...(process.env.WL_NO_DAVE ? { daveEncryption: false } : {}) });
    if (process.env.WL_VOICE_DEBUG) {
      connection.on('debug', (m) => this.d.log('[voice]', String(m).slice(0, 200)));
      connection.on('stateChange', (a, b) => this.d.log('[voice] state', a.status, '->', b.status));
    }
    try {
      await v.entersState(connection, v.VoiceConnectionStatus.Ready, 20000);
    } catch (e) {
      connection.destroy();
      throw new Error('Couldn\'t connect to that voice channel. Check the bot has Connect and Speak there.');
    }
    // Never give up on missing audio (the default stops after 0.1 s of it):
    // the feeder above re-fills the cushion instead. If the player ever does
    // go idle, start a fresh stream.
    const player = v.createAudioPlayer({ behaviors: { noSubscriber: v.NoSubscriberBehavior.Play, maxMissedFrames: Infinity } });
    const fresh = () => {
      const stream = new PassThrough({ highWaterMark: 48000 * 4 * 3 });
      const resource = v.createAudioResource(stream, { inputType: v.StreamType.Raw, inlineVolume: true });
      resource.volume.setVolume((this.d.volume() ?? 100) / 100);
      player.play(resource);
      this.feeder.attach(stream, resource, player);
      return { stream, resource };
    };
    let { stream, resource } = fresh();
    connection.subscribe(player);
    player.on('error', (e) => this.d.log('[discord] player:', e.message));
    player.on(v.AudioPlayerStatus.Idle, () => {
      if (!this.voice || this.voice.player !== player) return;
      this.d.log('[discord] player went idle, restarting the stream');
      try { this.voice.stream.end(); } catch { /* ended */ }
      ({ stream, resource } = fresh());
      this.voice.stream = stream; this.voice.resource = resource;
    });
    connection.on(v.VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          v.entersState(connection, v.VoiceConnectionStatus.Signalling, 5000),
          v.entersState(connection, v.VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch { this.leaveVoice(); }
    });
    clearInterval(this._feedT);
    this._feedT = setInterval(() => this.feeder.tick(), 20);
    this.voice = { connection, player, resource, stream, channelId: channel.id, guildId: channel.guild.id, channelName: channel.name };
    this.d.capture(true);
    this.setStatus({ voice: channel.name });
  }
  async leaveVoice(rejoining) {
    clearTimeout(this._aloneT);
    clearInterval(this._feedT);
    if (!this.voice) return;
    const { connection, player, stream, channelId } = this.voice;
    this.voice = null;
    this.feeder.out = null;
    try { player.stop(true); } catch { /* stopped */ }
    try { stream.end(); } catch { /* ended */ }
    try { connection.destroy(); } catch { /* gone */ }
    // Take down the player from the voice channel's chat.
    const station = this.panels.get(channelId);
    if (station) { this.panels.delete(channelId); await station.delete().catch(() => {}); }
    if (!rejoining) this.d.capture(false);
    this.setStatus({ voice: null });
    this.onPlayerChange();
  }
  _onPcm(buf) {
    if (process.env.WL_DISCORD_DIAG) {
      this._diag = this._diag || { bytes: 0, sq: 0, n: 0 };
      this._diag.bytes += buf.length;
      for (let i = 0; i + 1 < buf.length; i += 16) { const s = buf.readInt16LE(i); this._diag.sq += s * s; this._diag.n++; }
    }
    if (!this.voice) return;
    this.feeder.push(buf);
  }
  get pcmSink() { return this._sink; }
  setVolume(pct) { if (this.voice) this.voice.resource.volume.setVolume(Math.max(0, Math.min(150, pct)) / 100); this.d.setVolume && this.d.setVolume(pct); }

  // Leave after 2 minutes with nobody else in the channel.
  checkAlone() {
    if (!this.voice || !this.client) return;
    const others = this.listenerCount();
    clearTimeout(this._aloneT);
    if (others === 0) this._aloneT = setTimeout(() => this.leaveVoice(), 120000);
    this.onPlayerChange();
  }

  // Diagnostics (env WL_DISCORD_DIAG): one line every 3s on where audio goes.
  async diagAutojoin(c) {
    this.startDiag();
    // Join the joinable voice channel with the most people in it.
    try {
      const g = await c.guilds.fetch(this.guildId);
      const chans = [...(await g.channels.fetch()).values()].filter((x) => x && x.type === 2 && x.joinable && x.speakable)
        .sort((a, b) => b.members.filter((m) => !m.user.bot).size - a.members.filter((m) => !m.user.bot).size);
      this.d.log('[diag] channels', chans.map((x) => `${x.name}(${x.members.filter((m) => !m.user.bot).size})`).join(', '));
      if (chans[0] && chans[0].members.filter((m) => !m.user.bot).size) {
        await this.joinVoice(chans[0]); this.d.log('[diag] joined', chans[0].name);
        setTimeout(async () => {
          if ((this.d.player() || {}).playing) return;
          const song = (await this.search('middle class rut aunt betty').catch(() => []))[0];
          if (song) { this.d.act('add', { items: [song], where: 'next' }, { id: 'diag', name: 'Diagnostics' }); this.d.log('[diag] started', song.title); }
        }, 12000);
      }
    } catch (e) { this.d.log('[diag] autojoin failed:', e.message); }
  }
  startDiag() {
    if (this._diagT) return;
    this._diagT = setInterval(() => {
      const d = this._diag || { bytes: 0, sq: 0, n: 0 };
      this._diag = { bytes: 0, sq: 0, n: 0 };
      const p = this.d.player() || {};
      const vc = this.voice;
      let net = null, dave = null, clients = null;
      try {
        net = vc && vc.connection.state.networking && vc.connection.state.networking.state;
        dave = net && net.dave;
        clients = net && net.connectionData && net.connectionData.connectedClients ? net.connectionData.connectedClients.size : null;
      } catch { /* not connected */ }
      this.d.log('[diag]', JSON.stringify({
        wl: { playing: !!p.playing, ad: !!p.ad, title: (p.title || '').slice(0, 30), vol: p.volume, tap: p.tap },
        pcm: { kb3s: Math.round(d.bytes / 1024), rms: d.n ? Math.round(Math.sqrt(d.sq / d.n)) : 0 },
        feed: this.feeder.info(),
        voice: vc ? {
          conn: vc.connection.state.status, net: net && net.code, player: vc.player.state.status,
          sentSec: Math.round(vc.resource.playbackDuration / 1000),
          dave: dave ? { v: dave.protocolVersion, ready: !!(dave.session && dave.session.ready), status: dave.session && dave.session.status, downgraded: !!dave.downgraded } : null,
          clients, humans: this.listenerCount(), channel: vc.channelName,
        } : null,
      }));
    }, 3000);
  }

  // Track / play state / Up Next changed in Wavelength.
  onPlayerChange() {
    this.updatePresence();
    if (!this.panels.size) return;
    const p = this.d.player() || {};
    const songChanged = !!p.videoId && p.videoId !== this._lastVideo;
    if (p.videoId) this._lastVideo = p.videoId;
    if (songChanged) this._songChanged = true;
    clearTimeout(this._panelT);
    this._panelT = setTimeout(() => { const sc = this._songChanged; this._songChanged = false; this.refreshPanels(sc); }, 800);
  }
}

module.exports = { DiscordBot, appIdFromToken, AudioFeeder };
