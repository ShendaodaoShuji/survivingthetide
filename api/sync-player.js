// Vercel serverless route: /sync-player
const run = require('./_lib/adapt.js');
const handler = require('./_lib/player-sync.js');
module.exports = (req, res) => run(handler, req, res);
