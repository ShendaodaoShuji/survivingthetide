/**
 * Netlify Function · POST /api/sync-player
 *
 * 首次进入游戏 / 手动「同步库存」时调用：
 *   1. 按工号（miner_id）upsert public.players；
 *   2. 昵称、头像、库存快照、最后活跃时间一并更新；
 *   3. 头像只在变化时以 data URL 上传到 Storage，其余时候只带 avatarUrl。
 *
 * 请求体：
 *   {
 *     "minerId": "MINER-202610-483920",   // 必填
 *     "playerId": "uuid",                 // 可选，关联排行榜
 *     "nickname": "夜行者",
 *     "avatar": "data:image/jpeg;base64,...",  // 可选，仅头像变化时上传
 *     "avatarUrl": "https://xxx.supabase.co/storage/v1/object/public/avatars/...",
 *     "inventory": { "ore": 123, "skins": [...], ... }
 *   }
 *
 * 返回：
 *   { ok, player: { minerId, nickname, avatarUrl, lastActiveAt, inventory } }
 */

const MINER_RE = /^MINER-[0-9]{6}-[0-9]{6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_AVATAR_BYTES = 200 * 1024;
const MAX_INVENTORY_BYTES = 16 * 1024;
const DEFAULT_BUCKET = 'avatars';

export const config = { path: '/api/sync-player' };

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

function sbEnv() {
  return {
    url: env('SUPABASE_URL', '').replace(/\/+$/, ''),
    key: env('SUPABASE_SERVICE_ROLE_KEY', ''),
    bucket: env('SUPABASE_AVATAR_BUCKET', DEFAULT_BUCKET),
    dryRun: env('DRY_RUN', '') === '1'
  };
}

function sbHeaders(cfg, extra) {
  return Object.assign({ apikey: cfg.key, authorization: 'Bearer ' + cfg.key }, extra || {});
}

function cleanNickname(value) {
  if (typeof value !== 'string') return null;
  const s = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  if (!chars.length) return null;
  return chars.slice(0, 12).join('');
}

function matchesMagic(buf, mime) {
  if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/png') return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mime === 'image/webp') {
    return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function parseAvatarDataUrl(value) {
  if (value === undefined || value === null || value === '') return { ok: true, avatar: null };
  if (typeof value !== 'string') return { ok: false, code: 'invalid_avatar' };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(value.trim());
  if (!m) return { ok: false, code: 'invalid_avatar' };
  const mime = m[1];
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buf.length) return { ok: false, code: 'invalid_avatar' };
  if (buf.length > MAX_AVATAR_BYTES) return { ok: false, code: 'avatar_too_large' };
  if (!matchesMagic(buf, mime)) return { ok: false, code: 'invalid_avatar' };
  return { ok: true, avatar: { mime, buf } };
}

function extFor(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

async function uploadAvatar(cfg, avatar) {
  const path = 'p/' + Date.now().toString(36) + '-' + crypto.randomUUID() + '.' + extFor(avatar.mime);
  const res = await fetch(cfg.url + '/storage/v1/object/' + encodeURIComponent(cfg.bucket) + '/' + path, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + cfg.key,
      apikey: cfg.key,
      'content-type': avatar.mime,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-upsert': 'false'
    },
    body: avatar.buf
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('avatar_upload_failed:' + res.status + ':' + detail.slice(0, 200));
  }
  return cfg.url + '/storage/v1/object/public/' + cfg.bucket + '/' + path;
}

function cleanInventory(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    return null;
  }
  if (text.length > MAX_INVENTORY_BYTES) return null;
  return value;
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

  let raw = '';
  try {
    raw = await request.text();
  } catch (e) {
    return json(400, { ok: false, error: 'invalid_body' }, cors);
  }
  if (raw.length > MAX_BODY_BYTES) return json(413, { ok: false, error: 'body_too_large' }, cors);

  let body = null;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return json(400, { ok: false, error: 'invalid_json' }, cors);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, { ok: false, error: 'invalid_json' }, cors);
  }

  const minerId = typeof body.minerId === 'string' ? body.minerId.trim().toUpperCase() : '';
  if (!MINER_RE.test(minerId)) return json(400, { ok: false, error: 'invalid_miner_id' }, cors);

  const nickname = cleanNickname(body.nickname);
  if (!nickname) return json(400, { ok: false, error: 'invalid_nickname' }, cors);

  const playerId = typeof body.playerId === 'string' && UUID_RE.test(body.playerId) ? body.playerId.toLowerCase() : null;

  const inventory = cleanInventory(body.inventory);
  if (inventory === null) return json(413, { ok: false, error: 'inventory_too_large' }, cors);

  const avatarResult = parseAvatarDataUrl(body.avatar);
  if (!avatarResult.ok) {
    const status = avatarResult.code === 'avatar_too_large' ? 413 : 415;
    return json(status, { ok: false, error: avatarResult.code }, cors);
  }

  const cfg = sbEnv();
  if (!cfg.dryRun && (!cfg.url || !cfg.key)) {
    console.error('sync-player: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return json(500, { ok: false, error: 'server_misconfigured' }, cors);
  }

  if (cfg.dryRun) {
    return json(201, { ok: true, dryRun: true, received: { minerId, playerId, nickname, inventory, avatarBytes: avatarResult.avatar ? avatarResult.avatar.buf.length : 0 } }, cors);
  }

  try {
    let avatarUrl = null;
    if (typeof body.avatarUrl === 'string' && body.avatarUrl) {
      const prefix = cfg.url + '/storage/v1/object/public/' + cfg.bucket + '/';
      if (body.avatarUrl.indexOf(prefix) === 0 && body.avatarUrl.length < 500) avatarUrl = body.avatarUrl;
    }
    if (avatarResult.avatar) {
      avatarUrl = await uploadAvatar(cfg, avatarResult.avatar);
    }

    const row = {
      miner_id: minerId,
      nickname,
      inventory,
      last_active_at: new Date().toISOString()
    };
    if (playerId) row.player_id = playerId;
    if (avatarUrl) row.avatar_url = avatarUrl;

    const res = await fetch(cfg.url + '/rest/v1/players?on_conflict=miner_id', {
      method: 'POST',
      headers: sbHeaders(cfg, {
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates,return=representation'
      }),
      body: JSON.stringify(row)
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 409) return json(409, { ok: false, error: 'miner_id_taken' }, cors);
      console.error('sync-player: upsert failed', res.status, detail.slice(0, 200));
      return json(502, { ok: false, error: 'upstream_error' }, cors);
    }

    const rows = await res.json();
    const saved = Array.isArray(rows) && rows.length ? rows[0] : null;

    return json(201, {
      ok: true,
      player: {
        minerId,
        nickname: saved ? saved.nickname : nickname,
        avatarUrl: saved ? saved.avatar_url : avatarUrl,
        lastActiveAt: saved ? saved.last_active_at : row.last_active_at,
        inventory: saved ? saved.inventory : inventory
      }
    }, cors);
  } catch (e) {
    console.error('sync-player: upstream error', e && e.stack ? e.stack : e);
    return json(502, { ok: false, error: 'upstream_error' }, cors);
  }
}
