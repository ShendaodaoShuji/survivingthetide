/**
 * Netlify Function · POST /api/delete-account
 *
 * 「清空本机存档」时调用：把这个工号在云端的痕迹全部删掉——
 *   1. 好友关系（我发起 + 发给我的）→ 其他玩家的好友列表里自动消失
 *   2. 排行榜记录（该 player_id 的所有月份）→ 榜单不再显示
 *   3. players 档案本身
 *
 * 请求体：{ "minerId": "MINER-202610-123456", "playerId": "uuid（可选）" }
 * 返回：  { ok: true, existed: true, removed: { friends, leaderboard, player } }
 *
 * 幂等：档案已经不存在时同样返回 200 / existed:false。
 */

const MINER_RE = /^MINER-[0-9]{6}-[0-9]{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const config = { path: '/api/delete-account' };

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
    url: env('SUPABASE_URL', '').replace(/\/+$/, '').replace(/\/(rest|storage)\/v1$/i, '').replace(/\/+$/, ''),
    key: env('SUPABASE_SERVICE_ROLE_KEY', ''),
    dryRun: env('DRY_RUN', '') === '1'
  };
}

function sbHeaders(cfg, extra) {
  return Object.assign({ apikey: cfg.key, authorization: 'Bearer ' + cfg.key }, extra || {});
}

async function deleteWhere(cfg, table, filter) {
  const res = await fetch(cfg.url + '/rest/v1/' + table + '?' + filter, {
    method: 'DELETE',
    headers: sbHeaders(cfg, { prefer: 'return=representation' })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('delete_' + table + '_failed:' + res.status + ':' + detail.slice(0, 200));
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
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

  const minerId = typeof body.minerId === 'string' ? body.minerId.trim().toUpperCase() : '';
  if (!MINER_RE.test(minerId)) return json(400, { ok: false, error: 'invalid_miner_id' }, cors);

  const cfg = sbEnv();
  if (!cfg.dryRun && (!cfg.url || !cfg.key)) {
    console.error('delete-account: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return json(500, { ok: false, error: 'server_misconfigured' }, cors);
  }
  if (cfg.dryRun) return json(200, { ok: true, dryRun: true, minerId }, cors);

  try {
    const meRes = await fetch(
      cfg.url + '/rest/v1/players?miner_id=eq.' + encodeURIComponent(minerId) + '&select=miner_id,player_id',
      { headers: sbHeaders(cfg) }
    );
    const meRows = meRes.ok ? await meRes.json() : [];
    const me = Array.isArray(meRows) && meRows.length ? meRows[0] : null;

    const bodyPid =
      typeof body.playerId === 'string' && UUID_RE.test(body.playerId) ? body.playerId.toLowerCase() : null;

    // 破坏性操作：必须同时知道工号 + 从未公开过的 playerId，
    // 否则任何拿到别人工号的人都能删号。
    if (me && me.player_id) {
      if (!bodyPid || bodyPid !== String(me.player_id).toLowerCase()) {
        return json(403, { ok: false, error: 'forbidden' }, cors);
      }
    }

    const playerId = (me && me.player_id) || bodyPid;

    const removed = { friends: 0, leaderboard: 0, player: 0 };

    // 1. 好友关系（两个方向一次删掉）
    removed.friends = await deleteWhere(
      cfg,
      'friendships',
      'or=(requester_miner.eq.' + minerId + ',addressee_miner.eq.' + minerId + ')'
    );

    // 2. 排行榜（该玩家所有月份的记录）
    if (playerId) {
      removed.leaderboard = await deleteWhere(cfg, 'leaderboard', 'player_id=eq.' + encodeURIComponent(playerId));
    }

    // 3. 档案本身
    if (me) {
      removed.player = await deleteWhere(cfg, 'players', 'miner_id=eq.' + encodeURIComponent(minerId));
    }

    return json(200, { ok: true, existed: !!me, minerId, removed }, cors);
  } catch (e) {
    console.error('delete-account: upstream error', e && e.stack ? e.stack : e);
    return json(502, { ok: false, error: 'upstream_error' }, cors);
  }
}
