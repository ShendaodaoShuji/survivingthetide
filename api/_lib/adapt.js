// 把 Vercel 的 Node (req,res) 适配成统一的 Web Request/Response，
// 这样原有的处理逻辑可以原样复用。
module.exports = async function run(handler, req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const url = new URL(req.url || '/', proto + '://' + host);

  const headers = new Headers();
  for (const key of Object.keys(req.headers || {})) {
    const value = req.headers[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach(function (v) { headers.append(key, v); });
    else headers.set(key, String(value));
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (typeof req.body === 'string') body = req.body;
    else if (Buffer.isBuffer(req.body)) body = req.body.toString('utf8');
    else if (req.body !== undefined && req.body !== null) body = JSON.stringify(req.body);
    else body = await readStream(req);
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();

  let response;
  try {
    response = await handler(new Request(url.toString(), {
      method: req.method,
      headers: headers,
      body: body
    }), { ip: ip });
  } catch (err) {
    console.error('adapter error', err && err.stack ? err.stack : err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'adapter_error' }));
    return;
  }

  res.statusCode = response.status;
  response.headers.forEach(function (value, key) { res.setHeader(key, value); });
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
};

function readStream(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', function () { resolve(''); });
  });
}
