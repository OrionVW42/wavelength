const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, step = 250) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(step);
  }
  return null;
}
function checker(tag) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(!!ok);
    console.log(`${ok ? 'ok  ' : 'FAIL'} [${tag}] ${name}${detail ? ' — ' + detail : ''}`);
    return ok;
  };
  check.all = () => results.every(Boolean);
  return check;
}
const shared = (name) => path.join(process.env.WL_SHARED, name);
const writeJson = (name, v) => fs.writeFileSync(shared(name), JSON.stringify(v));
const readJson = (name) => { try { return JSON.parse(fs.readFileSync(shared(name), 'utf8')); } catch { return null; } };

async function ready(ctx) {
  return waitFor(() => ctx.runInYtm('!!(window.__wl && window.ytcfg)'), 40000, 400);
}
const shell = (ctx, code) => ctx.mainWin.webContents.executeJavaScript(code, true);

module.exports = { sleep, waitFor, checker, writeJson, readJson, ready, shell };
