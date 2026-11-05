// Vercel serverless route: /leaderboard/top
const run = require('../_lib/adapt.js');
const handler = require('../_lib/leaderboard-top.js');
module.exports = (req, res) => run(handler, req, res);
