// Wavelength's built-in Discord bot.
//
// The bot is this Wavelength: whatever it plays (solo, hosting a room, or as
// a guest in someone's room) is streamed into a Discord voice channel, and
// people in the server control the shared Up Next with slash commands and
// buttons. Audio comes from the player itself (see the "audio tap" in
// src/inject/bridge.js), so Discord hears the same ad-free stream at the same
// moment as the room. Nothing is downloaded separately.
const { PassThrough } = require('stream');

const BLURPLE = 0x8b5cf6;
const fmt = (sec) => { sec = Math.max(0, Math.round(+sec || 0)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + 'â€¦' : s; };
const appIdFromToken = (t) => { try { return Buffer.from(String(t).split('.')[0], 'base64').toString('utf8').replace(/\D/g, '') || null; } catch { return null; } };
const INVITE_PERMS = '36785152'; // View Channels, Send Messages, Embed Links, Read History, Connect, Speak, Voice Activity

class DiscordBot {
  // deps: { player(), summary(), act(action, args, by), search(q), room(op, code), capture(on), volume(), onStatus(s), log(...) }
  constructor(deps) {
    this.d = deps;
    this.client = null;
    this.status = { state: 'off' };
    this.voice = null;      // { connection, player, resource, stream, channelId, guildId, channelName }
    this.panels = new Map(); // channelId -> Message (live now-playing panel)
    this._sink = (buf) => this._onPcm(buf);
    this._aloneT = null;
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
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.client = client;
    client.once(Events.ClientReady, async (c) => {
      this.setStatus({ state: 'online', tag: c.user.tag, guilds: c.guilds.cache.size, invite: this.inviteUrl(token) });
      try { await this.registerCommands(); } catch (e) { this.d.log('[discord] commands:', e.message); this.setStatus({ warning: 'Couldn\'t register slash commands: ' + e.message }); }
      if (process.env.WL_DISCORD_DIAG) {
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
              const song = await this.findSong('middle class rut aunt betty').catch(() => null);
              if (song) { this.d.act('add', { items: [song], where: 'next' }, { id: 'diag', name: 'Diagnostics' }); this.d.log('[diag] started', song.title); }
            }, 12000);
          }
        } catch (e) { this.d.log('[diag] autojoin failed:', e.message); }
      }
    });
    client.on(Events.InteractionCreate, (i) => this.onInteraction(i).catch((e) => {
      this.d.log('[discord] interaction:', e.message);
      const reply = { content: 'âš ï¸ ' + clip(e.message, 300), ephemeral: true };
      (i.deferred || i.replied ? i.followUp(reply) : i.reply(reply)).catch(() => {});
    }));
    client.on(Events.VoiceStateUpdate, () => this.checkAlone());
    client.on('error', (e) => this.d.log('[discord]', e.message));
    try {
      await client.login(token);
    } catch (e) {
      this.client = null;
      const msg = /TOKEN_INVALID|invalid token|401/i.test(e.message) ? 'That token was rejected. Reset it in the Developer Portal and paste the new one.' : e.message;
      this.setStatus({ state: 'error', error: msg });
    }
  }

  async stop() {
    this.leaveVoice();
    if (this.client) { try { await this.client.destroy(); } catch { /* gone */ } }
    this.client = null; this.panels.clear();
    if (this.status.state !== 'off') this.setStatus({ state: 'off', tag: null, voice: null, error: null, warning: null });
  }

  // ------------------------------------------------------------ commands
  commandDefs() {
    const { SlashCommandBuilder } = require('discord.js');
    return [
      new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and play Wavelength'),
      new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
      new SlashCommandBuilder().setName('play').setDescription('Add a song to Up Next (starts playing if nothing is)')
        .addStringOption((o) => o.setName('song').setDescription('Song name, artist, or a YouTube Music link').setRequired(true))
        .addBooleanOption((o) => o.setName('next').setDescription('Play it next instead of at the end')),
      new SlashCommandBuilder().setName('search').setDescription('Search and pick which song to add')
        .addStringOption((o) => o.setName('song').setDescription('What to search for').setRequired(true)),
      new SlashCommandBuilder().setName('np').setDescription('Show the now-playing panel with controls'),
      new SlashCommandBuilder().setName('queue').setDescription('Show Up Next'),
      new SlashCommandBuilder().setName('skip').setDescription('Skip to the next song'),
      new SlashCommandBuilder().setName('previous').setDescription('Go back a song'),
      new SlashCommandBuilder().setName('pause').setDescription('Pause'),
      new SlashCommandBuilder().setName('resume').setDescription('Resume'),
      new SlashCommandBuilder().setName('volume').setDescription('Set the bot\'s volume in Discord')
        .addIntegerOption((o) => o.setName('percent').setDescription('0â€“150').setRequired(true).setMinValue(0).setMaxValue(150)),
      new SlashCommandBuilder().setName('room').setDescription('Wavelength listening rooms')
        .addSubcommand((s) => s.setName('info').setDescription('Show the room code so friends can join in the Wavelength app'))
        .addSubcommand((s) => s.setName('start').setDescription('Host a new room'))
        .addSubcommand((s) => s.setName('join').setDescription('Join a room by code').addStringOption((o) => o.setName('code').setDescription('Like K7Q-M2X').setRequired(true)))
        .addSubcommand((s) => s.setName('leave').setDescription('Leave or end the room')),
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
    if (i.isButton() && i.customId.startsWith('wl:')) return this.onButton(i);
    if (i.isStringSelectMenu() && i.customId === 'wl:pick') return this.onPick(i);
    if (!i.isChatInputCommand()) return;
    const by = this.who(i);
    switch (i.commandName) {
      case 'join': return this.cmdJoin(i);
      case 'leave': this.leaveVoice(); return i.reply({ content: 'ðŸ‘‹ Left the voice channel.' });
      case 'play': return this.cmdPlay(i, by);
      case 'search': return this.cmdSearch(i);
      case 'np': return this.sendPanel(i);
      case 'queue': return i.reply({ embeds: [this.queueEmbed()] });
      case 'skip': this.d.act('next', {}, by); return this.ack(i, `â­ï¸ Skipped by ${by.name}`);
      case 'previous': this.d.act('prev', {}, by); return this.ack(i, `â®ï¸ Back a song (${by.name})`);
      case 'pause': this.d.act('pause', {}, by); return this.ack(i, `â¸ï¸ Paused by ${by.name}`);
      case 'resume': this.d.act('play', {}, by); return this.ack(i, `â–¶ï¸ Resumed by ${by.name}`);
      case 'volume': {
        const v = i.options.getInteger('percent');
        this.setVolume(v);
        return i.reply({ content: `ðŸ”Š Bot volume ${v}%` });
      }
      case 'room': return this.cmdRoom(i);
      default:
    }
  }
  async ack(i, text) {
    await i.reply({ content: text });
    setTimeout(() => this.refreshPanels(), 1500);
  }

  async cmdPlay(i, by) {
    const q = i.options.getString('song');
    const next = !!i.options.getBoolean('next');
    await i.deferReply();
    const song = await this.findSong(q);
    if (!song) return i.editReply({ content: `Couldn't find anything for â€œ${clip(q, 80)}â€.` });
    this.d.act('add', { items: [song], where: next ? 'next' : 'end' }, by);
    await i.editReply({ embeds: [this.songEmbed(song, `${next ? 'Plays next' : 'Added to Up Next'} Â· requested by ${by.name}`)] });
    if (!this.voice) await i.followUp({ content: 'Tip: type **/join** while you\'re in a voice channel to hear it here.', ephemeral: true });
    setTimeout(() => this.refreshPanels(), 2000);
  }
  async findSong(q) {
    const link = /(?:v=|youtu\.be\/)([\w-]{11})/.exec(q);
    const results = await this.d.search(link ? link[1] : q, !!link);
    return (results.find((r) => r.kind === 'Song') || results[0]) || null;
  }
  async cmdSearch(i) {
    const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
    await i.deferReply({ ephemeral: true });
    const results = (await this.d.search(i.options.getString('song'))).slice(0, 10);
    if (!results.length) return i.editReply({ content: 'No songs found.' });
    this._picks = this._picks || new Map();
    const key = Date.now().toString(36);
    this._picks.set(key, results);
    const menu = new StringSelectMenuBuilder().setCustomId('wl:pick').setPlaceholder('Pick a song to add')
      .addOptions(results.map((r, n) => ({ label: clip(r.title, 95), description: clip(`${r.artist}${r.duration ? ' Â· ' + fmt(r.duration) : ''}${r.kind === 'Video' ? ' Â· video' : ''}`, 95), value: `${key}:${n}` })));
    return i.editReply({ content: 'Pick one:', components: [new ActionRowBuilder().addComponents(menu)] });
  }
  async onPick(i) {
    const [key, n] = String(i.values[0]).split(':');
    const song = this._picks && this._picks.get(key) && this._picks.get(key)[+n];
    if (!song) return i.update({ content: 'That search expired. Try again.', components: [] });
    const by = this.who(i);
    this.d.act('add', { items: [song], where: 'end' }, by);
    await i.update({ content: `âœ… Added **${clip(song.title, 80)}**`, components: [] });
    if (i.channel) await i.channel.send({ embeds: [this.songEmbed(song, `Added to Up Next Â· requested by ${by.name}`)] }).catch(() => {});
    setTimeout(() => this.refreshPanels(), 2000);
  }

  async cmdRoom(i) {
    const sub = i.options.getSubcommand();
    const sum = () => this.d.summary() || {};
    const pretty = (c) => (c ? c.slice(0, 3) + '-' + c.slice(3) : '');
    if (sub === 'info') {
      const s = sum();
      if (s.role === 'solo' || !s.code) return i.reply({ content: 'Not in a room. Use **/room start** to host one, or **/room join** with a code.' });
      return i.reply({ content: `ðŸŽ§ Room **${pretty(s.code)}** Â· ${s.members.length} listening in Wavelength${s.role === 'guest' ? ' (joined as a guest)' : ''}. Friends can join from the Wavelength app with this code.` });
    }
    await i.deferReply();
    if (sub === 'start') this.d.room('host');
    else if (sub === 'join') this.d.room('join', i.options.getString('code'));
    else this.d.room('leave');
    // Wait for the room to settle (up to 20s), then report.
    for (let k = 0; k < 40; k++) {
      await new Promise((r) => setTimeout(r, 500));
      const s = sum();
      if (sub === 'leave' && s.role === 'solo') return i.editReply({ content: 'ðŸšª Left the room. Wavelength is playing on its own again.' });
      if (sub !== 'leave' && s.status === 'live' && s.code) {
        return i.editReply({ content: sub === 'start'
          ? `ðŸŽ‰ Room **${pretty(s.code)}** is live. Friends can join it in the Wavelength app, and everyone here can add songs with **/play**.`
          : `âœ… Joined room **${pretty(s.code)}**. Discord now hears that room.` });
      }
      if (sub !== 'leave' && s.role === 'solo' && s.status === 'idle' && k > 6) break;
    }
    return i.editReply({ content: sub === 'join' ? 'âŒ Couldn\'t join that room. Check the code and that the host is still online.' : 'âŒ The room didn\'t start. Check the Wavelength window for details.' });
  }

  // ------------------------------------------------------------ buttons + panels
  controls() {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const p = this.d.player() || {};
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wl:prev').setEmoji('â®ï¸').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wl:toggle').setEmoji(p.playing ? 'â¸ï¸' : 'â–¶ï¸').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('wl:next').setEmoji('â­ï¸').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wl:queue').setLabel('Up Next').setStyle(ButtonStyle.Secondary),
    )];
  }
  async onButton(i) {
    const by = this.who(i);
    const a = i.customId.slice(3);
    if (a === 'queue') return i.reply({ embeds: [this.queueEmbed()], ephemeral: true });
    const p = this.d.player() || {};
    if (a === 'toggle') this.d.act(p.playing ? 'pause' : 'play', {}, by);
    else if (a === 'next') this.d.act('next', {}, by);
    else if (a === 'prev') this.d.act('prev', {}, by);
    await i.deferUpdate();
    setTimeout(() => this.refreshPanels(), 1200);
  }
  async sendPanel(i) {
    const msg = await i.reply({ embeds: [this.nowEmbed()], components: this.controls(), fetchReply: true });
    this.panels.set(i.channelId, msg);
  }
  // Called on track / play-state changes so panels stay live.
  async refreshPanels() {
    for (const [ch, msg] of this.panels) {
      try { await msg.edit({ embeds: [this.nowEmbed()], components: this.controls() }); } catch { this.panels.delete(ch); }
    }
  }

  // ------------------------------------------------------------ embeds
  songEmbed(song, footer) {
    const { EmbedBuilder } = require('discord.js');
    const e = new EmbedBuilder().setColor(BLURPLE).setTitle(clip(song.title, 250))
      .setURL(`https://music.youtube.com/watch?v=${song.videoId}`)
      .setDescription(`${clip(song.artist, 200)}${song.duration ? ' Â· ' + fmt(song.duration) : ''}`)
      .setFooter({ text: clip(footer, 200) });
    if (song.art) e.setThumbnail(song.art);
    return e;
  }
  nowEmbed() {
    const { EmbedBuilder } = require('discord.js');
    const p = this.d.player() || {}, s = this.d.summary() || {};
    const e = new EmbedBuilder().setColor(BLURPLE).setAuthor({ name: p.playing ? 'Now playing' : 'Paused' });
    if (!p.videoId) return e.setDescription('Nothing is playing. Add something with **/play**.');
    const bar = p.duration ? (() => { const n = 18, k = Math.round((p.position / p.duration) * n); return 'â–¬'.repeat(Math.max(0, k)) + 'ðŸ”˜' + 'â–¬'.repeat(Math.max(0, n - k)); })() : '';
    e.setTitle(clip(p.title, 250)).setURL(`https://music.youtube.com/watch?v=${p.videoId}`)
      .setDescription(`${clip(p.artist, 200)}\n${bar}  \`${fmt(p.position)} / ${fmt(p.duration)}\``);
    if (p.art) e.setThumbnail(p.art);
    const by = s.current && s.current.addedBy;
    const next = (s.upNext || [])[0];
    const bits = [];
    if (by) bits.push(`added by ${by.name}`);
    if (next) bits.push(`next: ${next.title}`);
    if (s.role && s.role !== 'solo' && s.code) bits.push(`room ${s.code.slice(0, 3)}-${s.code.slice(3)}`);
    if (bits.length) e.setFooter({ text: clip(bits.join(' Â· '), 200) });
    return e;
  }
  queueEmbed() {
    const { EmbedBuilder } = require('discord.js');
    const p = this.d.player() || {}, s = this.d.summary() || {};
    const q = s.upNext || [];
    const lines = q.slice(0, 10).map((t, n) => `\`${n + 1}.\` **${clip(t.title, 60)}** Â· ${clip(t.artist, 40)}${t.by ? ` Â· _${clip(t.by, 24)}_` : ''}`);
    return new EmbedBuilder().setColor(BLURPLE).setTitle('Up Next')
      .setDescription([
        p.videoId ? `â–¶ï¸ **${clip(p.title, 70)}** Â· ${clip(p.artist, 40)}` : 'Nothing playing right now.',
        '',
        lines.length ? lines.join('\n') : '_Up Next is empty. Add songs with **/play**._',
        q.length > 10 ? `â€¦and ${q.length - 10} more` : '',
      ].join('\n'));
  }

  // ------------------------------------------------------------ voice
  async cmdJoin(i) {
    const channel = i.member && i.member.voice && i.member.voice.channel;
    if (!channel) return i.reply({ content: 'Join a voice channel first, then use **/join**.', ephemeral: true });
    if (!channel.joinable || !channel.speakable) {
      return i.reply({ content: `I'm not allowed to ${!channel.joinable ? 'join' : 'speak in'} **${channel.name}**. Give the Wavelength role **Connect** and **Speak** there (channel settings â†’ Permissions), or use another channel.`, ephemeral: true });
    }
    await i.deferReply();
    await this.joinVoice(channel);
    const p = this.d.player() || {};
    return i.editReply({ content: `ðŸ”Š Playing Wavelength in **${channel.name}**${p.title ? ` Â· now: **${clip(p.title, 80)}**` : '. Add songs with **/play**.'}` });
  }
  async joinVoice(channel) {
    const v = require('@discordjs/voice');
    this.leaveVoice();
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
    // The audio arrives in ~85 ms chunks from the player page and can pause
    // briefly (e.g. while YouTube Music loads the next song). By default the
    // voice player gives up for good after 5 missed frames (0.1 s), so never
    // give up, and if it ever does go idle, start a fresh stream.
    const player = v.createAudioPlayer({ behaviors: { noSubscriber: v.NoSubscriberBehavior.Play, maxMissedFrames: Infinity } });
    const fresh = () => {
      const stream = new PassThrough({ highWaterMark: 48000 * 4 });
      const resource = v.createAudioResource(stream, { inputType: v.StreamType.Raw, inlineVolume: true });
      resource.volume.setVolume((this.d.volume() ?? 100) / 100);
      player.play(resource);
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
    this.voice = { connection, player, resource, stream, channelId: channel.id, guildId: channel.guild.id, channelName: channel.name };
    this.d.capture(true);
    this.setStatus({ voice: channel.name });
  }
  leaveVoice() {
    clearTimeout(this._aloneT);
    if (!this.voice) return;
    const { connection, player, stream } = this.voice;
    this.voice = null;
    try { player.stop(true); } catch { /* stopped */ }
    try { stream.end(); } catch { /* ended */ }
    try { connection.destroy(); } catch { /* gone */ }
    this.d.capture(false);
    this.setStatus({ voice: null });
  }
  _onPcm(buf) {
    const vc = this.voice;
    if (process.env.WL_DISCORD_DIAG) {
      this._diag = this._diag || { bytes: 0, sq: 0, n: 0 };
      this._diag.bytes += buf.length;
      for (let i = 0; i + 1 < buf.length; i += 16) { const s = buf.readInt16LE(i); this._diag.sq += s * s; this._diag.n++; }
    }
    if (!vc) return;
    // Keep latency low: drop audio if Discord isn't keeping up (>1s queued).
    if (vc.stream.writableLength > 48000 * 4) return;
    vc.stream.write(buf);
  }
  get pcmSink() { return this._sink; }
  setVolume(pct) { if (this.voice) this.voice.resource.volume.setVolume(Math.max(0, Math.min(150, pct)) / 100); this.d.setVolume && this.d.setVolume(pct); }

  // Leave after 2 minutes with nobody else in the channel.
  checkAlone() {
    if (!this.voice || !this.client) return;
    const ch = this.client.channels.cache.get(this.voice.channelId);
    const others = ch && ch.members ? ch.members.filter((m) => !m.user.bot).size : 1;
    clearTimeout(this._aloneT);
    if (others === 0) this._aloneT = setTimeout(() => this.leaveVoice(), 120000);
  }

  // Diagnostics (env WL_DISCORD_DIAG): one line every 3s on where audio goes.
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
      const ch = vc && this.client && this.client.channels.cache.get(vc.channelId);
      this.d.log('[diag]', JSON.stringify({
        wl: { playing: !!p.playing, ad: !!p.ad, title: (p.title || '').slice(0, 30), vol: p.volume, tap: p.tap },
        pcm: { kb3s: Math.round(d.bytes / 1024), rms: d.n ? Math.round(Math.sqrt(d.sq / d.n)) : 0 },
        voice: vc ? {
          conn: vc.connection.state.status, net: net && net.code, player: vc.player.state.status,
          sentSec: Math.round(vc.resource.playbackDuration / 1000), queuedKB: Math.round(vc.stream.writableLength / 1024),
          dave: dave ? { v: dave.protocolVersion, ready: !!(dave.session && dave.session.ready), status: dave.session && dave.session.status, downgraded: !!dave.downgraded } : null,
          clients, humans: ch && ch.members ? ch.members.filter((m) => !m.user.bot).size : null, channel: vc.channelName,
        } : null,
      }));
    }, 3000);
  }

  // Track / play state changed in Wavelength.
  onPlayerChange() { if (this.panels.size) { clearTimeout(this._panelT); this._panelT = setTimeout(() => this.refreshPanels(), 800); } }
}

module.exports = { DiscordBot, appIdFromToken };
