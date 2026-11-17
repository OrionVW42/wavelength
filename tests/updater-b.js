// Runs 2+ of tests/updater.js: which version did the launcher start?
const { sleep } = require('./util');
module.exports = async (ctx) => {
  console.log(`UPD version ${ctx.version} fromUpdate ${!!(ctx.boot && ctx.boot.fromUpdate)}`);
  await sleep(4500); // let it confirm itself (3s in test mode)
  return true;
};
