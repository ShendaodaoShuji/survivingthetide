// Vercel serverless route: /get-friends
const run = require('./_lib/adapt.js');
const handler = require('./_lib/get-friends.js');
module.exports = (req, res) => run(handler, req, res);
