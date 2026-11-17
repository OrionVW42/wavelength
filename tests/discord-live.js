// Live Discord test (needs a real bot token + server; never commit them):
//   WL_DISCORD_TEST=<path to {"token","guild"} json>
// Logs in, registers commands, streams a song into an EMPTY voice channel for
// ~15s (skipped if every voice channel has people in it), checks /play's path.
const fs = require('fs');
const { sleep, waitFor, checker, ready, shell } = require('./util');

module.exports = async (ctx) => {
  const check = checker('discord');
  const cfg = JSON.parse(fs.readFileSync(process.env.WL_DISCORD_TEST, 'utf8'));
  await ready(ctx);
  await ctx.mainWin.webContents.executeJavaScript(`window.wl.setSettings(${JSON.stringify({ discordEnabled: true, discordToken: cfg.token, discordGuildId: cfg.guild })}).then(() => 0)`);
  const bot = await waitFor(() => ctx.getDiscord(), 10000);
  const online = await waitFor(() => bot.status.state === 'online' && bot.status.commands && bot.status, 40000);
  check('bot logs in', !!online, JSON.stringify(bot.status));
  check('slash commands registered in the server', online && /commands in/.test(online.commands), online && online.commands);

  // /play path: search + add with the Discord user's name.
  const song = await bot.findSong('daft punk get lucky');
  check('/play finds a song', !!song, song && `${song.title} · ${song.artist}`);
  bot.d.act('add', { items: [song], where: 'end' }, { id: '42', name: 'TestFriend' });
  const added = await waitFor(() => ctx.getPlayerState().videoId === song.videoId || shell(ctx, `window.__session.queue.some(t => t.videoId === ${JSON.stringify(song.videoId)})`), 20000);
  const by = await shell(ctx, `(() => { const s = window.__session; const t = s.current && s.current.videoId === ${JSON.stringify(song.videoId)} ? s.current : s.queue.find(x => x.videoId === ${JSON.stringify(song.videoId)}); return t && t.addedBy && t.addedBy.name; })()`);
  check('song added and credited to the Discord user', !!added && /TestFriend/.test(by || ''), by);
  await waitFor(() => { const s = ctx.getPlayerState(); return s.playing && !s.ad; }, 150000);
  check('now-playing card builds', !!bot.nowEmbed().data.title, bot.nowEmbed().data.title);
  check('queue card builds', /Up Next/.test(bot.queueEmbed().data.title));

  // Voice: an empty channel only.
  const guild = await bot.client.guilds.fetch(cfg.guild);
  const channels = await guild.channels.fetch();
  const voiceChs = [...channels.values()].filter((c) => c && c.type === 2);
  for (const c of voiceChs) console.log(`ok   [discord] channel "${c.name}": people=${c.members.filter((m) => !m.user.bot).size} joinable=${c.joinable} speakable=${c.speakable} afk=${guild.afkChannelId === c.id}`);
  const empty = voiceChs.find((c) => c.joinable && c.speakable && guild.afkChannelId !== c.id && c.members.filter((m) => !m.user.bot).size === 0);
  if (!empty) { console.log('ok   [discord] (skipped voice: no empty voice channel)'); }
  else {
    await bot.joinVoice(empty);
    check('joins a voice channel', !!bot.voice && bot.voice.connection.state.status === 'ready', empty.name);
    await sleep(15000);
    const played = bot.voice ? bot.voice.resource.playbackDuration : 0;
    check('streams Wavelength\'s audio into voice', played > 10000 && bot.voice.player.state.status === 'playing', `${(played / 1000).toFixed(1)}s sent, player ${bot.voice && bot.voice.player.state.status}`);
    bot.leaveVoice();
    check('leaves the voice channel', !bot.voice);
  }
  await ctx.mainWin.webContents.executeJavaScript('window.wl.setSettings({ discordEnabled: false }).then(() => 0)');
  await waitFor(() => bot.status.state === 'off', 10000);
  check('turning the setting off disconnects the bot', bot.status.state === 'off');
  return check.all();
};
