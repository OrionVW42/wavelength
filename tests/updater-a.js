// Run 1 of tests/updater.js: check + download.
const { sleep, waitFor } = require('./util');
module.exports = async (ctx) => {
  await ctx.updater.run();
  const s = await waitFor(() => { const x = ctx.updater.status(); return x.ready ? x : null; }, 60000);
  console.log('UPD ' + JSON.stringify(s || ctx.updater.status()));
  const pill = await waitFor(() => ctx.mainWin.webContents.executeJavaScript("!!window.__session && !document.querySelector('#update-pill').hidden"), 15000);
  if (pill) console.log('UPD pill visible');
  else console.log('UPD pill-debug ' + await ctx.mainWin.webContents.executeJavaScript("document.querySelector('#update-pill').outerHTML.slice(0, 200)"));
  return true;
};
