// Vercel serverless route: /add-friend
const run = require('./_lib/adapt.js');
const handler = require('./_lib/add-friend.js');
module.exports = (req, res) => run(handler, req, res);
