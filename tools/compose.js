// Builds the website images from raw screenshots.
//   npx electron tools/compose.js <rawDir> <outDir>
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const raw = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });
const url = (f) => pathToFileURL(path.join(raw, f)).href;

const frame = (inner, w, h) => `<!doctype html><html><head><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:"Segoe UI Variable Display","Segoe UI",sans-serif}
  body{background:radial-gradient(ellipse at 15% 0%,rgba(255,77,109,.35),transparent 55%),radial-gradient(ellipse at 90% 100%,rgba(139,92,246,.4),transparent 55%),#09090e;position:relative}
  .win{position:absolute;border-radius:14px;overflow:hidden;box-shadow:0 40px 90px -20px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.08)}
  .win img{display:block;width:100%}
  .mini{position:absolute;filter:drop-shadow(0 22px 40px rgba(0,0,0,.75))}
  .mini img{display:block;width:100%}
  .title{position:absolute;color:#fff;font-weight:700;letter-spacing:-.5px}
  .sub{position:absolute;color:#b9b9cc}
  </style></head><body>${inner}</body></html>`;

const jobs = [
  { name: 'hero.jpg', w: 1600, h: 1000, html: frame(`
      <div class="win" style="left:100px;top:110px;width:1400px"><img src="${url('player.png')}"></div>
      <div class="mini" style="left:566px;top:40px;width:468px;transform:scale(1.45);transform-origin:top center"><img src="${url('mini.png')}"></div>`, 1600, 1000) },
  { name: 'og.jpg', w: 1200, h: 630, html: frame(`
      <div class="title" style="left:64px;top:70px;font-size:64px">Wavelength</div>
      <div class="sub" style="left:66px;top:156px;font-size:26px;width:520px;line-height:1.35">YouTube Music on your desktop. A mini player on top of everything, and rooms where friends listen to the same song at the same moment.</div>
      <div class="win" style="left:620px;top:200px;width:760px"><img src="${url('player.png')}"></div>
      <div class="mini" style="left:70px;top:430px;width:468px;transform:scale(1.1);transform-origin:top left"><img src="${url('mini.png')}"></div>`, 1200, 630) },
  { name: 'mini.jpg', w: 1200, h: 520, html: frame(`
      <div class="win" style="left:60px;top:150px;width:1080px;opacity:.55;filter:blur(1.5px)"><img src="${url('together.png')}"></div>
      <div class="mini" style="left:600px;top:40px;width:468px;transform:translateX(-50%) scale(1.6);transform-origin:top center"><img src="${url('mini.png')}"></div>`, 1200, 520) },
];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1600, height: 1000, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true, webSecurity: false } });
  for (const j of jobs) {
    win.setContentSize(j.w, j.h);
    const file = path.join(out, '_tmp-' + j.name + '.html');
    fs.writeFileSync(file, j.html);
    await win.loadFile(file);
    await new Promise((r) => setTimeout(r, 700));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: j.w, height: j.h });
    fs.writeFileSync(path.join(out, j.name), img.resize({ width: j.w, height: j.h }).toJPEG(90));
    console.log('composed', j.name);
    fs.rmSync(file);
  }
  for (const f of ['player', 'together', 'search', 'saved', 'settings']) {
    const img = nativeImage.createFromPath(path.join(raw, f + '.png'));
    fs.writeFileSync(path.join(out, f + '.jpg'), img.toJPEG(88));
    console.log('converted', f);
  }
  fs.copyFileSync(path.join(raw, 'mini.png'), path.join(out, 'mini-bar.png'));
  app.exit(0);
});
