// Offline test of the Discord bot's screens and flows (no token, no Discord):
// fake interactions go through the real handlers, and every message is built
// with discord.js's own validators, so a layout Discord would reject fails here.
//   node tests/discord-ui.js
const { DiscordBot, AudioFeeder } = require('../src/main/discord');

let ok = true;
const check = (name, cond, detail = '') => { ok = ok && !!cond; console.log(`${cond ? 'ok  ' : 'FAIL'} [discord-ui] ${name}${detail ? ' — ' + detail : ''}`); };

const songs = [
  { videoId: 'aaaaaaaaaaa', title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers) — a very long title that keeps going and going past the limits Discord allows', artist: 'Daft Punk', duration: 369, kind: 'Song', art: 'https://lh3.googleusercontent.com/x' },
  { videoId: 'bbbbbbbbbbb', title: 'Instant Crush', artist: 'Daft Punk', duration: 337, kind: 'Song' },
  { videoId: 'ccccccccccc', title: 'Get Lucky (Official Video)', artist: 'Daft Punk', duration: 248, kind: 'Video' },
];
const acts = [];
let queue = Array.from({ length: 30 }, (_, n) => ({ uid: 'u' + n, videoId: 'q'.repeat(10) + (n % 10), title: `Queued song number ${n + 1} with a fairly long name`, artist: 'Artist ' + n, by: n % 2 ? 'Alex · Discord' : 'Orion' }));
const deps = {
  player: () => ({ videoId: 'aaaaaaaaaaa', title: songs[0].title, artist: 'Daft Punk', playing: true, position: 61, duration: 369, art: songs[0].art }),
  summary: () => ({ role: 'host', code: 'K7QM2X', status: 'live', members: [{}, {}], current: { addedBy: { name: 'Orion' } }, upNext: queue.slice(0, 25), queueLength: queue.length }),
  act: (action, args, by) => acts.push({ action, args, by }),
  room: () => {},
  search: async (q, isId) => (isId ? [songs.find((s) => s.videoId === q) || songs[1]] : songs),
  capture: () => {}, volume: () => 50, setVolume: () => {}, onStatus: () => {}, log: () => {},
};
const bot = new DiscordBot(deps);

// Every message payload must survive discord.js's builders → JSON.
const json = (msg) => JSON.parse(JSON.stringify({ ...msg, embeds: (msg.embeds || []).map((e) => (e.toJSON ? e.toJSON() : e)), components: (msg.components || []).map((c) => c.toJSON()) }));

function fakeI(over = {}) {
  const calls = [];
  const i = {
    calls, user: { id: '1', username: 'friend', globalName: 'Friend' }, member: { displayName: 'Friend' }, channelId: 'c1',
    deferred: false, replied: false,
    isAutocomplete: () => false, isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false, isChatInputCommand: () => false,
    reply: async (m) => { i.replied = true; calls.push(['reply', json(m), m]); return { id: 'm1', delete: async () => {}, edit: async () => {} }; },
    deferReply: async (m) => { i.deferred = true; calls.push(['defer', m]); },
    editReply: async (m) => { calls.push(['edit', json(m), m]); return { id: 'm2' }; },
    followUp: async (m) => { calls.push(['follow', json(m), m]); },
    update: async (m) => { calls.push(['update', json(m), m]); },
    deferUpdate: async () => calls.push(['deferUpdate']),
    showModal: async (m) => calls.push(['modal', m.toJSON()]),
    respond: async (r) => calls.push(['respond', r]),
    ...over,
  };
  return i;
}
const cmd = (name, opts = {}) => fakeI({
  isChatInputCommand: () => true, commandName: name,
  options: { getString: (k) => opts[k] ?? null, getInteger: (k) => opts[k] ?? null, getBoolean: (k) => opts[k] ?? null, getSubcommand: () => opts.sub },
});
const last = (i, kind) => [...i.calls].reverse().find((c) => c[0] === kind);

(async () => {
  try {
    // Commands
    const defs = bot.commandDefs();
    check('slash commands are valid', defs.length >= 18 && defs.every((d) => d.name && d.description), defs.map((d) => d.name).join(' '));
    check('/play suggests songs as you type', defs.find((d) => d.name === 'play').options[0].autocomplete === true);

    // Live player: embed + controls + Up Next menu
    const panel = json(bot.panelMsg());
    check('live player builds (Discord-valid)', panel.embeds[0].title && panel.components.length === 3, `${panel.components.length} rows`);
    check('player shows Up Next with who added', /Up Next \(30\)/.test(panel.embeds[0].fields[0].name) && /Alex/.test(panel.embeds[0].fields[0].value) && /and 20 more/.test(panel.embeds[0].fields[0].value));
    check('player has prev/play/next/shuffle/add', panel.components[0].components.map((c) => c.custom_id).join(',') === 'wl:prev,wl:toggle,wl:next,wl:shuffle,wl:add');
    check('Up Next menu lists up to 25 songs', panel.components[2].components[0].options.length === 25);
    queue = [];
    check('empty Up Next: no menu (Discord rejects empty menus)', json(bot.panelMsg()).components.length === 2);
    queue = Array.from({ length: 3 }, (_, n) => ({ uid: 'u' + n, videoId: 'x', title: 'Song ' + n, artist: 'A', by: 'Orion' }));

    // /play with typed text → pick list → Play next
    let i = cmd('play', { song: 'get lucky' });
    await bot.onInteraction(i);
    const list = last(i, 'edit');
    check('/play text shows a pick list', list && list[1].components[0].components[0].options.length === 3);
    const key = list[1].components[0].components[0].custom_id.split(':')[2];
    let s = fakeI({ isStringSelectMenu: () => true, customId: `wl:pick:${key}`, values: ['1'] });
    await bot.onInteraction(s);
    const placed = last(s, 'update');
    check('picking shows Play now / Play next / Add to end', placed && placed[1].components[0].components.map((c) => c.label).join('|') === 'Play now|Play next|Add to end|Other results');
    let b = fakeI({ isButton: () => true, customId: placed[1].components[0].components[1].custom_id });
    await bot.onInteraction(b);
    check('Play next adds it next, credited to the Discord user', acts.at(-1).action === 'add' && acts.at(-1).args.where === 'next' && acts.at(-1).args.items[0].videoId === 'bbbbbbbbbbb' && acts.at(-1).by.name === 'Friend');
    check('everyone sees what was added', !!last(b, 'follow'));
    b = fakeI({ isButton: () => true, customId: `wl:back:${key}` });
    await bot.onInteraction(b);
    check('"Other results" goes back to the list', last(b, 'update')[1].components[0].components[0].options.length === 3);

    // Autocomplete → pick → buttons; with `where` → instant
    const ac = fakeI({ isAutocomplete: () => true, commandName: 'play', options: { getFocused: () => ({ name: 'song', value: 'get luc' }) } });
    await bot.onInteraction(ac);
    const sug = last(ac, 'respond')[1];
    check('suggestions while typing', sug.length === 3 && sug.every((o) => o.name.length <= 100 && /^v:/.test(o.value)), sug.map((o) => o.name).join(' | ').slice(0, 120));
    i = cmd('play', { song: sug[0].value });
    await bot.onInteraction(i);
    check('picked suggestion asks where it goes', last(i, 'reply') && last(i, 'reply')[1].components[0].components.length === 3);
    i = cmd('play', { song: sug[2].value, where: 'now' });
    await bot.onInteraction(i);
    check('/play with "Play now" plays it straight away', acts.at(-1).args.where === 'now' && acts.at(-1).args.items[0].videoId === 'ccccccccccc');

    // Up Next menu → play now / move / remove
    s = fakeI({ isStringSelectMenu: () => true, customId: 'wl:q', values: ['u2'] });
    await bot.onInteraction(s);
    const qb = last(s, 'reply')[1].components[0].components.map((c) => c.custom_id);
    check('Up Next pick offers play now / move to next / remove', qb.join(',') === 'wl:qnow:u2,wl:qnext:u2,wl:qdel:u2');
    for (const [id, action] of [['wl:qnow:u2', 'playNow'], ['wl:qnext:u1', 'move'], ['wl:qdel:u0', 'remove']]) {
      b = fakeI({ isButton: () => true, customId: id });
      await bot.onInteraction(b);
      check(`${id.split(':')[1]} works`, acts.at(-1).action === action && acts.at(-1).args.uid === id.split(':')[2]);
    }

    // Add song button → modal → results
    b = fakeI({ isButton: () => true, customId: 'wl:add' });
    await bot.onInteraction(b);
    check('Add song opens a search box', last(b, 'modal') && last(b, 'modal')[1].custom_id === 'wl:addmodal');
    const m = fakeI({ isModalSubmit: () => true, customId: 'wl:addmodal', fields: { getTextInputValue: () => 'daft punk' } });
    await bot.onInteraction(m);
    check('search box shows results', last(m, 'edit')[1].components[0].components[0].options.length === 3);

    // Other commands
    for (const [name, opts, action] of [['shuffle', {}, 'shuffle'], ['clear', {}, 'clear'], ['seek', { time: '1:30' }, 'seek'], ['remove', { song: 2 }, 'remove'], ['skip', {}, 'next']]) {
      i = cmd(name, opts);
      await bot.onInteraction(i);
      check(`/${name}`, acts.at(-1).action === action && !!last(i, 'reply'), JSON.stringify(acts.at(-1).args));
    }
    check('/seek 1:30 = 90 s', acts.find((a) => a.action === 'seek').args.position === 90);
    const rac = fakeI({ isAutocomplete: () => true, commandName: 'remove', options: { getFocused: () => ({ name: 'song', value: '' }) } });
    await bot.onInteraction(rac);
    check('/remove suggests songs from Up Next', last(rac, 'respond')[1].length === 3);
    i = cmd('help'); await bot.onInteraction(i);
    check('/help', /join/.test(last(i, 'reply')[1].embeds[0].description));
    i = cmd('queue'); await bot.onInteraction(i);
    check('/queue', /Up Next/.test(last(i, 'reply')[1].embeds[0].title));

    // Audio buffer: waits for the cushion, refills once on a dry spell.
    const f = new AudioFeeder();
    const written = [];
    const res = { playbackDuration: 0 }, pl = { state: { status: 'playing', missedFrames: 0 } };
    f.attach({ write: (x) => written.push(x.length) }, res, pl);
    const chunk = Buffer.alloc(8192); // ~43 ms
    for (let k = 0; k < 6; k++) f.push(chunk);
    check('holds audio until the cushion is full', written.length === 0 && f.state === 'filling');
    f.push(chunk); f.push(chunk);
    check('then plays it all', written.length === 8 && f.state === 'flowing');
    res.playbackDuration = 340; f.flowSince = 0; pl.state.missedFrames = 2; f.tick();
    check('a dry spell refills once and grows the cushion', f.state === 'filling' && f.target === 500 && f.stats.underruns === 1);
  } catch (e) { check('no crash', false, e.stack); }
  console.log(ok ? 'DISCORD-UI PASS' : 'DISCORD-UI FAIL');
  process.exit(ok ? 0 : 1);
})();
