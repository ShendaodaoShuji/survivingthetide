/**
 * Netlify Function · POST /api/add-friend
 *
 * 通过对方工号添加好友：
 *   - 对方也发过申请 → 直接互相通过（accepted）
 *   - 否则创建 pending 申请，等对方在游戏里同意
 *   - action: "decline" 用于拒绝对方发来的申请
 *
 * 请求体：
 *   {
 *     "minerId": "MINER-202610-123456",        // 自己
 *     "friendMinerId": "MINER-202610-654321",  // 对方
 *     "action": "request" | "accept" | "decline"  // 可选，默认 request（若对方已申请则自动通过）
 *   }
 *
 * 返回：
 *   { ok, status: "pending"|"accepted"|"already_friends"|"declined", friend: {...} }
 */

const MINER_RE = /^MINER-[0-9]{6}-[0-9]{6}$/;
const MAX_PENDING_OUTGOING = 20;

export const config = { path: '/api/add-friend' };

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

async function getPlayer(cfg, minerId) {
  const res = await fetch(
    cfg.url + '/rest/v1/players?miner_id=eq.' + encodeURIComponent(minerId) +
      '&select=miner_id,nickname,avatar_url,last_active_at',
    { headers: sbHeaders(cfg) }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function getPair(cfg, a, b) {
  const filter =
    'or=(and(requester_miner.eq.' + a + ',addressee_miner.eq.' + b + '),' +
    'and(requester_miner.eq.' + b + ',addressee_miner.eq.' + a + '))';
  const res = await fetch(
    cfg.url + '/rest/v1/friendships?' + filter + '&select=id,requester_miner,addressee_miner,status,created_at',
    { headers: sbHeaders(cfg) }
  );
  if (!res.ok) throw new Error('pair_lookup_failed:' + res.status);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function countPendingOutgoing(cfg, minerId) {
  const res = await fetch(
    cfg.url + '/rest/v1/friendships?requester_miner=eq.' + encodeURIComponent(minerId) +
      '&status=eq.pending&select=id',
    { headers: sbHeaders(cfg, { prefer: 'count=exact', range: '0-0' }) }
  );
  if (!res.ok) return 0;
  const total = Number((res.headers.get('content-range') || '').split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

async function insertRequest(cfg, requester, addressee) {
  const res = await fetch(cfg.url + '/rest/v1/friendships', {
    method: 'POST',
    headers: sbHeaders(cfg, { 'content-type': 'application/json', prefer: 'return=representation' }),
    body: JSON.stringify({ requester_miner: requester, addressee_miner: addressee })
  });
  if (!res.ok) {
    // 唯一索引冲突：并发下另一方刚插入，重新读取即可
    if (res.status === 409) return null;
    const detail = await res.text().catch(() => '');
    throw new Error('insert_failed:' + res.status + ':' + detail.slice(0, 200));
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function acceptRequest(cfg, id) {
  const res = await fetch(cfg.url + '/rest/v1/friendships?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: sbHeaders(cfg, { 'content-type': 'application/json', prefer: 'return=representation' }),
    body: JSON.stringify({ status: 'accepted', responded_at: new Date().toISOString() })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('accept_failed:' + res.status + ':' + detail.slice(0, 200));
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function deleteRequest(cfg, id) {
  const res = await fetch(
    cfg.url + '/rest/v1/friendships?id=eq.' + encodeURIComponent(id) + '&status=eq.pending',
    { method: 'DELETE', headers: sbHeaders(cfg, { prefer: 'return=representation' }) }
  );
  return res.ok;
}

function friendSummary(player) {
  if (!player) return null;
  return {
    minerId: player.miner_id,
    nickname: player.nickname,
    avatarUrl: player.avatar_url || null,
    lastActiveAt: player.last_active_at || null
  };
}

export default async function handler(request) {
  const allowedOrigin = env('ALLOWED_ORIGIN', '*');
  const cors = {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' }, cors, { allow: 'POST, OPTIONS' });
  }

  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { ok: false, error: 'invalid_json' }, cors);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, { ok: false, error: 'invalid_json' }, cors);
  }

  const minerId = normalizeMiner(body.minerId);
  const friendMinerId = normalizeMiner(body.friendMinerId);
  const action = typeof body.action === 'string' ? body.action : 'request';

  if (!minerId) return json(400, { ok: false, error: 'invalid_miner_id' }, cors);
  if (!friendMinerId) return json(400, { ok: false, error: 'invalid_friend_miner_id' }, cors);
  if (minerId === friendMinerId) return json(400, { ok: false, error: 'cannot_add_self' }, cors);
  if (['request', 'accept', 'decline'].indexOf(action) < 0) {
    return json(400, { ok: false, error: 'invalid_action' }, cors);
  }

  const cfg = sbEnv();
  if (!cfg.dryRun && (!cfg.url || !cfg.key)) {
    console.error('add-friend: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return json(500, { ok: false, error: 'server_misconfigured' }, cors);
  }
  if (cfg.dryRun) {
    return json(201, { ok: true, dryRun: true, status: 'pending', received: { minerId, friendMinerId, action } }, cors);
  }

  try {
    const me = await getPlayer(cfg, minerId);
    if (!me) return json(404, { ok: false, error: 'player_not_found' }, cors);
    const target = await getPlayer(cfg, friendMinerId);
    if (!target) return json(404, { ok: false, error: 'target_not_found' }, cors);

    const pair = await getPair(cfg, minerId, friendMinerId);

    /* ---------- 拒绝 ---------- */
    if (action === 'decline') {
      if (!pair || pair.status !== 'pending' || pair.requester_miner !== friendMinerId) {
        return json(404, { ok: false, error: 'no_pending_request' }, cors);
      }
      const ok = await deleteRequest(cfg, pair.id);
      if (!ok) return json(502, { ok: false, error: 'upstream_error' }, cors);
      return json(200, { ok: true, status: 'declined', friend: friendSummary(target) }, cors);
    }

    /* ---------- 已存在关系 ---------- */
    if (pair) {
      if (pair.status === 'accepted') {
        return json(200, { ok: true, status: 'already_friends', friend: friendSummary(target) }, cors);
      }
      if (pair.requester_miner === friendMinerId) {
        // 对方已发来申请 → 直接通过
        const updated = await acceptRequest(cfg, pair.id);
        if (!updated) return json(502, { ok: false, error: 'upstream_error' }, cors);
        return json(200, { ok: true, status: 'accepted', friend: friendSummary(target) }, cors);
      }
      // 我已发过申请
      return json(200, { ok: true, status: 'pending', friend: friendSummary(target) }, cors);
    }

    if (action === 'accept') {
      return json(404, { ok: false, error: 'no_pending_request' }, cors);
    }

    /* ---------- 申请上限 ---------- */
    const pending = await countPendingOutgoing(cfg, minerId);
    if (pending >= MAX_PENDING_OUTGOING) {
      return json(429, { ok: false, error: 'too_many_pending' }, cors);
    }

    const created = await insertRequest(cfg, minerId, friendMinerId);
    if (!created) {
      // 并发：对方刚好同时发来申请，重读一次
      const again = await getPair(cfg, minerId, friendMinerId);
      if (again && again.status === 'pending' && again.requester_miner === friendMinerId) {
        await acceptRequest(cfg, again.id);
        return json(200, { ok: true, status: 'accepted', friend: friendSummary(target) }, cors);
      }
    }

    return json(201, { ok: true, status: 'pending', friend: friendSummary(target) }, cors);
  } catch (e) {
    console.error('add-friend: upstream error', e && e.stack ? e.stack : e);
    return json(502, { ok: false, error: 'upstream_error' }, cors);
  }
}
