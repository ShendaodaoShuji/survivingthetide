/**
 * Netlify Function · GET /api/get-friends?minerId=MINER-202610-123456
 *
 * 返回当前玩家的好友列表（含对方的云端档案与库存快照），
 * 以及待处理的申请（requests）和自己发出去的申请（outgoing）。
 *
 * 返回：
 *   {
 *     ok, minerId,
 *     friends:  [{ minerId, nickname, avatarUrl, lastActiveAt, inventory, since }],
 *     requests: [{ minerId, nickname, avatarUrl, requestedAt }],
 *     outgoing: [{ minerId, nickname, avatarUrl, requestedAt }]
 *   }
 */

const MINER_RE = /^MINER-[0-9]{6}-[0-9]{6}$/;
const MAX_FRIENDS = 100;

export const config = { path: '/api/get-friends' };

function json(status, payload, cors, extra) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: Object.assign(
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'origin' },
      cors || {},
      extra || {}
    )
  });
}

function env(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

function sbEnv() {
  return {
    url: env('SUPABASE_URL', '').replace(/\/+$/, ''),
    key: env('SUPABASE_SERVICE_ROLE_KEY', ''),
    dryRun: env('DRY_RUN', '') === '1'
  };
}

function sbHeaders(cfg, extra) {
  return Object.assign({ apikey: cfg.key, authorization: 'Bearer ' + cfg.key }, extra || {});
}

function normalizeMiner(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim().toUpperCase();
  return MINER_RE.test(v) ? v : '';
}

function playerMap(rows) {
  const map = {};
  (Array.isArray(rows) ? rows : []).forEach((p) => { map[p.miner_id] = p; });
  return map;
}

async function fetchPlayers(cfg, ids) {
  if (!ids.length) return {};
  const res = await fetch(
    cfg.url + '/rest/v1/players?miner_id=in.(' + ids.join(',') + ')&select=miner_id,nickname,avatar_url,last_active_at,inventory',
    { headers: sbHeaders(cfg) }
  );
  if (!res.ok) throw new Error('players_fetch_failed:' + res.status);
  return playerMap(await res.json());
}

export default async function handler(request) {
  const allowedOrigin = env('ALLOWED_ORIGIN', '*');
  const cors = {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') {
    return json(405, { ok: false, error: 'method_not_allowed' }, cors, { allow: 'GET, OPTIONS' });
  }

  const url = new URL(request.url);
  const minerId = normalizeMiner(url.searchParams.get('minerId') || '');
  if (!minerId) return json(400, { ok: false, error: 'invalid_miner_id' }, cors);

  const cfg = sbEnv();
  if (!cfg.dryRun && (!cfg.url || !cfg.key)) {
    console.error('get-friends: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return json(500, { ok: false, error: 'server_misconfigured' }, cors);
  }
  if (cfg.dryRun) return json(200, { ok: true, dryRun: true, minerId, friends: [], requests: [], outgoing: [] }, cors);

  try {
    const meRes = await fetch(
      cfg.url + '/rest/v1/players?miner_id=eq.' + encodeURIComponent(minerId) + '&select=miner_id',
      { headers: sbHeaders(cfg) }
    );
    if (!meRes.ok) return json(502, { ok: false, error: 'upstream_error' }, cors);
    const meRows = await meRes.json();
    if (!Array.isArray(meRows) || !meRows.length) {
      return json(404, { ok: false, error: 'player_not_found' }, cors);
    }

    const relRes = await fetch(
      cfg.url + '/rest/v1/friendships?or=(requester_miner.eq.' + minerId + ',addressee_miner.eq.' + minerId + ')' +
        '&select=id,requester_miner,addressee_miner,status,created_at,responded_at&limit=200',
      { headers: sbHeaders(cfg) }
    );
    if (!relRes.ok) {
      const detail = await relRes.text().catch(() => '');
      console.error('get-friends: relations failed', relRes.status, detail.slice(0, 200));
      return json(502, { ok: false, error: 'upstream_error' }, cors);
    }
    const relations = await relRes.json();

    const friendIds = [];
    const requests = [];
    const outgoing = [];

    (Array.isArray(relations) ? relations : []).forEach((r) => {
      const other = r.requester_miner === minerId ? r.addressee_miner : r.requester_miner;
      if (r.status === 'accepted') {
        if (friendIds.length < MAX_FRIENDS) friendIds.push(other);
      } else if (r.status === 'pending') {
        if (r.addressee_miner === minerId) requests.push({ minerId: other, at: r.created_at });
        else outgoing.push({ minerId: other, at: r.created_at });
      }
    });

    const ids = Array.from(new Set(friendIds.concat(requests.map((x) => x.minerId), outgoing.map((x) => x.minerId))));
    const players = await fetchPlayers(cfg, ids);

    const friends = friendIds
      .filter((id) => players[id])
      .map((id) => ({
        minerId: id,
        nickname: players[id].nickname,
        avatarUrl: players[id].avatar_url || null,
        lastActiveAt: players[id].last_active_at || null,
        inventory: players[id].inventory || {},
        since: (relations.find((r) => (r.requester_miner === id || r.addressee_miner === id) && r.status === 'accepted') || {}).responded_at || null
      }))
      .sort((a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')));

    const shape = (list) =>
      list
        .filter((x) => players[x.minerId])
        .map((x) => ({
          minerId: x.minerId,
          nickname: players[x.minerId].nickname,
          avatarUrl: players[x.minerId].avatar_url || null,
          requestedAt: x.at || null
        }))
        .sort((a, b) => String(a.requestedAt || '').localeCompare(String(b.requestedAt || '')));

    return json(200, {
      ok: true,
      minerId,
      friends,
      requests: shape(requests),
      outgoing: shape(outgoing)
    }, cors);
  } catch (e) {
    console.error('get-friends: upstream error', e && e.stack ? e.stack : e);
    return json(502, { ok: false, error: 'upstream_error' }, cors);
  }
}
