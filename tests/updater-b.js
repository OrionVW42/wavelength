// Runs 2+ of tests/updater.js: which version did the launcher start?
const { sleep } = require('./util');
module.exports = async (ctx) => {
  console.log(`UPD version ${ctx.version} fromUpdate ${!!(ctx.boot && ctx.boot.fromUpdate)}`);
  try {
    const davey = require(require('path').join(ctx.boot.root, 'node_modules', '@snazzah', 'davey'));
    console.log('UPD natives ok ' + typeof davey.DAVESession);
  } catch (e) { console.log('UPD natives FAIL ' + e.message.slice(0, 120)); }
  await sleep(4500); // let it confirm itself (3s in test mode)
  return true;
};
