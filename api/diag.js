// Vercel serverless route: /diag
const run = require('./_lib/adapt.js');
const handler = require('./_lib/diag.js');
module.exports = (req, res) => run(handler, req, res);
