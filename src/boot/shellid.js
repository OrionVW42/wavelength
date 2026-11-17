// "Shell id": what an app-file-only update must match to run on this install.
// It's the Electron version plus a fingerprint of the native modules shipped
// next to the app file (resources/app.asar.unpacked/**/*.node). A release
// whose native modules differ needs the full installer, not just the app file.
const path = require('path');
const fs = process.versions.electron ? require('original-fs') : require('fs');
const crypto = require('crypto');

function nativeList(unpackedDir) {
  const out = [];
  (function walk(dir) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (/\.node$/i.test(d.name)) out.push(`${path.relative(unpackedDir, p).replace(/\\/g, '/')}:${fs.statSync(p).size}`);
    }
  })(unpackedDir);
  return out.sort();
}

function shellId(electronVersion, resourcesDir) {
  const list = nativeList(path.join(resourcesDir, 'app.asar.unpacked'));
  if (!list.length) return electronVersion;
  return `${electronVersion}+${crypto.createHash('sha1').update(list.join('\n')).digest('hex').slice(0, 10)}`;
}

module.exports = { shellId };
