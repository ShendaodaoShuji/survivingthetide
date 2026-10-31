/**
 * Netlify Function · GET /api/leaderboard/top?limit=100&offset=0&month=YYYYMM&me=<playerId>
 *
 * 读取月度排行榜（默认当月，按本月挖矿量降序，同分先达成者在前）。
 * me 可选：传了就在对应行标记 self:true（不返回 player_id）。
 *
 * 需要的环境变量与提交接口相同：
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ALLOWED_ORIGIN（可选）
 *
 * 返回：
 *   { ok, total, limit, offset, entries: [
 *       { rank, nickname, score, avatarUrl, stats, updatedAt, self }
 *   ] }
 */

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const MAX_OFFSET = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 当月键 YYYYMM，固定按 Asia/Shanghai（UTC+8） */
function currentMonth() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 7).replace('-', '');
}

export const config = { path: '/api/leaderboard/top' };

function json(status, payload, cors, extra) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: Object.assign(
      {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        vary: 'origin'
      },
      cors || {},
      extra || {}
    )
  });
}

function env(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

function clampInt(raw, fallback, min, max) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

async function totalFrom(res) {
  if (!res.ok) return null;
  const range = res.headers.get('content-range') || '';
  const n = Number(range.split('/')[1]);
  return Number.isFinite(n) ? n : null;
}

export default async function handler(request) {
  const allowedOrigin = env('ALLOWED_ORIGIN', '*');
  const cors = {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'GET') {
    return json(405, { ok: false, error: 'method_not_allowed' }, cors, { allow: 'GET, OPTIONS' });
  }

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, MAX_OFFSET);
  const monthParam = url.searchParams.get('month') || '';
  const month = /^[0-9]{6}$/.test(monthParam) ? monthParam : currentMonth();
  const meRaw = url.searchParams.get('me') || '';
  const me = UUID_RE.test(meRaw) ? meRaw.toLowerCase() : null;

  const supabaseUrl = env('SUPABASE_URL', '').replace(/\/+$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY', '');
  if (!supabaseUrl || !key) {
    console.error('leaderboard-top: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return json(500, { ok: false, error: 'server_misconfigured' }, cors);
  }

  const query =
    'select=id,player_id,nickname,score,avatar_url,stats,updated_at' +
    '&month=eq.' + encodeURIComponent(month) +
    '&order=score.desc,created_at.asc' +
    '&limit=' + limit +
    '&offset=' + offset;

  try {
    const res = await fetch(supabaseUrl + '/rest/v1/leaderboard?' + query, {
      headers: {
        apikey: key,
        authorization: 'Bearer ' + key,
        prefer: 'count=exact'
      }
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('leaderboard-top: query failed', res.status, detail.slice(0, 200));
      return json(502, { ok: false, error: 'upstream_error' }, cors);
    }

    const rows = await res.json();
    const total = await totalFrom(res);

    const entries = (Array.isArray(rows) ? rows : []).map((row, i) => ({
      rank: offset + i + 1,
      nickname: row.nickname,
      score: row.score,
      avatarUrl: row.avatar_url || null,
      stats: row.stats || {},
      updatedAt: row.updated_at || null,
      // 不下发 player_id，只告诉调用方哪一行是「自己」
      self: !!(me && row.player_id && String(row.player_id).toLowerCase() === me)
    }));

    return json(
      200,
      {
        ok: true,
        month,
        total: total === null ? entries.length : total,
        limit,
        offset,
        entries
      },
      cors
    );
  } catch (e) {
    console.error('leaderboard-top: upstream error', e && e.stack ? e.stack : e);
    return json(502, { ok: false, error: 'upstream_error' }, cors);
  }
}
