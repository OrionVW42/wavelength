// The catalog calls behind Wavelength for Android's UI (Home, search,
// album / artist / playlist pages, suggestions, lyrics, radio), live.
const { ready, checker } = require('./util');
module.exports = async (ctx) => {
  const check = checker('catalog');
  await ready(ctx);
  const sum = (shelves) => shelves.map((s) => `${s.title || '(untitled)'}[${s.items.length}${s.items[0] ? ':' + s.items[0].type : ''}]`).join(', ');
  const types = (shelves) => [...new Set(shelves.flatMap((s) => s.items.map((i) => i.type)))].join('/');

  const home = await ctx.ytmCall('home');
  check('home has shelves', home.shelves.length >= 2, sum(home.shelves).slice(0, 300));
  check('home items have titles, art and a target', home.shelves.flatMap((s) => s.items).every((i) => i.title && (i.videoId || i.browseId)), types(home.shelves));
  if (home.more) { const m = await ctx.ytmCall('homeMore', home.more); check('home loads more shelves', m.shelves.length > 0, sum(m.shelves).slice(0, 200)); }

  const sr = await ctx.ytmCall('searchAll', 'daft punk');
  check('search groups results', sr.length >= 3, sum(sr).slice(0, 300));
  const all = sr.flatMap((s) => s.items);
  const album = all.find((i) => i.type === 'album'), artist = all.find((i) => i.type === 'artist'), song = all.find((i) => i.type === 'song' && i.kind === 'Song');
  check('search finds songs, albums and artists', album && artist && song, `${song && song.title} | ${album && album.title} | ${artist && artist.title}`);

  const sg = await ctx.ytmCall('suggest', 'daft p');
  check('search suggestions', sg.words.length > 0, sg.words.slice(0, 4).join(' | '));

  if (album) {
    const a = await ctx.ytmCall('page', album.browseId);
    check('album page: header + tracks', a.header && a.header.title && a.tracks.length > 3, `${a.header && a.header.title} · ${a.header && a.header.subtitle} · ${a.tracks.length} tracks · play ${a.playlistId}`);
    check('album tracks have art', a.tracks.every((t) => t.art));
  }
  if (artist) {
    const p = await ctx.ytmCall('page', artist.browseId);
    check('artist page: header + shelves', p.header && p.header.title && p.shelves.length >= 2, `${p.header && p.header.title} · ${sum(p.shelves).slice(0, 250)} · radio ${p.header && p.header.radioId} play ${p.header && p.header.playlistId}`);
  }
  const pl = home.shelves.flatMap((s) => s.items).find((i) => i.type === 'playlist');
  if (pl) {
    const p = await ctx.ytmCall('page', pl.browseId);
    check('playlist page: header + tracks', p.header && p.tracks.length > 0, `${p.header && p.header.title} · ${p.tracks.length} tracks`);
  }
  if (song) {
    const ly = await ctx.ytmCall('lyrics', song.videoId);
    check('lyrics (when the song has them)', ly === null || (ly.text && ly.text.length > 20), ly ? ly.text.slice(0, 60).replace(/\n/g, ' / ') + ' — ' + ly.source : 'none for this song');
    const r = await ctx.ytmCall('radio', song.videoId);
    check('radio for a song', r.length >= 10, `${r.length} songs, e.g. ${r[1] && r[1].title}`);
  }
  return check.all();
};
