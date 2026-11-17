// After `electron-builder --win`: make the two small release files the
// auto-updater uses, next to the installer:
//   dist/wavelength-app-<v>.asar   the app itself (what most updates download)
//   dist/wavelength-update.json    { version, shell, app:{name,size,sha256}, setup:{name,size} }
// Upload all three (Setup exe + these two) to the GitHub release.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const dist = path.join(root, 'dist');
const v = pkg.version;
const { shellId } = require(path.join(root, 'src', 'boot', 'shellid.js'));
const SHELL = shellId(electronVersion, path.join(dist, 'win-unpacked', 'resources'));

const original = process.versions.electron ? require('original-fs') : fs;
const buf = original.readFileSync(path.join(dist, 'win-unpacked', 'resources', 'app.asar'));
const appName = `wavelength-app-${v}.asar`;
original.writeFileSync(path.join(dist, appName), buf);
const setupName = `Wavelength-Setup-${v}.exe`;
const setupPath = path.join(dist, setupName);
const manifest = {
  version: v,
  shell: SHELL,
  app: { name: appName, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') },
  setup: fs.existsSync(setupPath) ? { name: setupName, size: fs.statSync(setupPath).size } : null,
  built: new Date().toISOString(),
};
fs.writeFileSync(path.join(dist, 'wavelength-update.json'), JSON.stringify(manifest, null, 2));
console.log(`update files for v${v}: ${appName} (${(buf.length / 1e6).toFixed(1)} MB), wavelength-update.json (shell ${SHELL})`);
