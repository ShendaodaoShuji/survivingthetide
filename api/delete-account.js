// Vercel serverless route: /delete-account
const run = require('./_lib/adapt.js');
const handler = require('./_lib/delete-account.js');
module.exports = (req, res) => run(handler, req, res);
