/**
 * Netlify Function · GET /api/diag
 *
 * 云端自检：一次看清「环境变量 / 密钥类型 / 表结构 / 存储桶」哪里不对。
 * 不返回任何密钥内容，只返回检查结果与修复提示。
 *
 * 返回：
 *   {
 *     ok: boolean,
 *     env: { url: boolean, key: boolean, keyRole: "service_role"|"anon"|null, bucket: string },
 *     checks: { players, leaderboard, leaderboard_month, friendships, bucket },
 *     hints: string[]
 *   }
 */

const DEFAULT_BUCKET = 'avatars';

export const config = { path: '/api/diag' };

function json(status, payload, extra) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: Object.assign(
      {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
      },
      extra || {}
    )
  });
}

function env(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

/** 只解码不验签：确认配的是 service_role 还是 anon */
function jwtRole(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
    return payload.role || null;
  } catch (e) {
    return null;
  }
}

async function check(cfg, path) {
  try {
    const res = await fetch(cfg.url + path, {
      headers: { apikey: cfg.key, authorization: 'Bearer ' + cfg.key }
    });
    const body = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
    return { ok: res.ok, status: res.status, detail: body || null };
  } catch (e) {
    return { ok: false, status: 0, detail: String((e && e.message) || e) };
  }
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });
  }
  if (request.method !== 'GET') {
    return json(405, { ok: false, error: 'method_not_allowed' }, { allow: 'GET' });
  }

  const rawUrl = env('SUPABASE_URL', '').trim();
  const url = rawUrl.replace(/\/+$/, '').replace(/\/(rest|storage)\/v1$/i, '').replace(/\/+$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY', '');
  const bucket = env('SUPABASE_AVATAR_BUCKET', DEFAULT_BUCKET);

  const keyKind = key.startsWith('sb_secret_')
    ? 'service_role'
    : key.startsWith('sb_publishable_')
      ? 'anon'
      : jwtRole(key);

  const result = {
    ok: false,
    env: {
      url: !!url,
      key: !!key,
      keyRole: keyKind,
      bucket,
      // 只暴露主机与路径，不暴露任何密钥
      base: url ? url.replace(/\/+$/, '') : '',
      urlSuffixIgnored: !!url && rawUrl.replace(/\/+$/, '') !== url
    },
    checks: {},
    hints: []
  };

  if (!url || !key) {
    result.hints.push('Netlify 环境变量缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY；改完需要重新部署才生效。');
    return json(200, result);
  }
  if (result.env.urlSuffixIgnored) {
    result.hints.push('SUPABASE_URL 里带了 /rest/v1 或 /storage/v1 后缀，接口已自动忽略；建议直接填 https://<项目>.supabase.co。');
  }
  if (result.env.keyRole && result.env.keyRole !== 'service_role') {
    result.hints.push('SUPABASE_SERVICE_ROLE_KEY 里放的看起来是 ' + result.env.keyRole + ' key；请换成 Project Settings → API 里的 service_role secret。');
  }

  const cfg = { url, key };

  result.checks.players = await check(cfg, '/rest/v1/players?select=miner_id&limit=1');
  result.checks.leaderboard_month = await check(cfg, '/rest/v1/leaderboard?select=id,month,player_id&limit=1');
  result.checks.friendships = await check(cfg, '/rest/v1/friendships?select=id&limit=1');
  result.checks.bucket = await check(cfg, '/storage/v1/bucket/' + encodeURIComponent(bucket));

  const c = result.checks;

  // PostgREST 的 PGRST125 = 路径不对（最常见是 SUPABASE_URL 带了 /rest/v1）
  const isBadPath = (r) => {
    if (!r || r.ok) return false;
    const detail = String(r.detail || '');
    return detail.indexOf('PGRST125') >= 0 || /Invalid path/i.test(detail);
  };

  if (!c.players.ok) {
    result.hints.push(isBadPath(c.players)
      ? 'Supabase 返回 PGRST125（路径错误）：检查 SUPABASE_URL 是否误填成 .../rest/v1。'
      : c.players.status === 404
        ? 'public.players 表不存在：在 Supabase SQL Editor 重跑 supabase/schema.sql。'
        : 'public.players 读取失败（' + c.players.status + '）：多半是 RLS/密钥权限问题。');
  }
  if (!c.leaderboard_month.ok) {
    const detail = String(c.leaderboard_month.detail || '');
    result.hints.push(isBadPath(c.leaderboard_month)
      ? 'leaderboard 请求路径错误（PGRST125）：检查 SUPABASE_URL。'
      : /month/i.test(detail)
        ? 'leaderboard 缺少 month 列：请重跑 supabase/schema.sql（月度榜迁移）。'
        : 'public.leaderboard 读取失败（' + c.leaderboard_month.status + '）。');
  }
  if (!c.friendships.ok) {
    result.hints.push(isBadPath(c.friendships)
      ? 'friendships 请求路径错误（PGRST125）：检查 SUPABASE_URL。'
      : c.friendships.status === 404
        ? 'public.friendships 表不存在：请重跑 supabase/schema.sql。'
        : 'public.friendships 读取失败（' + c.friendships.status + '）。');
  }
  if (!c.bucket.ok) {
    result.hints.push(isBadPath(c.bucket)
      ? '存储请求路径错误（PGRST125）：检查 SUPABASE_URL。'
      : '存储桶 ' + bucket + ' 不存在或无权限：schema.sql 末尾的 storage.buckets 语句要执行。');
  }

  result.ok = Object.keys(c).every((k) => c[k].ok);
  if (result.ok) result.hints.push('云端自检通过。');

  return json(200, result);
}
