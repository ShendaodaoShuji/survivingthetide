// Vercel serverless route: /leaderboard
const run = require('./_lib/adapt.js');
const handler = require('./_lib/leaderboard-submit.js');
module.exports = (req, res) => run(handler, req, res);
