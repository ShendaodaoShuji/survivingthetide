/**
 * Netlify Function · POST /api/leaderboard
 *
 * 接收玩家提交的昵称、累计分数、头像（可选）和统计信息：
 *   1. 头像（data URL）→ 上传到 Supabase Storage，拿到公开 URL；
 *   2. 记录 → upsert 到 public.leaderboard（按 playerId，一名玩家一行）；
 *   3. 返回该条记录与当前名次。
 *
 * 需要的环境变量（Netlify 站点设置 → Environment variables）：
 *   SUPABASE_URL                https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   service_role key，只放服务端，绝不能进前端
 *   SUPABASE_AVATAR_BUCKET      可选，默认 avatars
 *   ALLOWED_ORIGIN              可选，默认 *；上线建议填站点域名
 *   RATE_SALT                   可选，同一 IP 限流用的盐
 *   DRY_RUN                     可选，=1 时只校验、不写 Supabase（本地联调用）
 *
 * 请求体：
 *   {
 *     "playerId": "0f6b…",           // 可选但建议：客户端生成并持久化的 UUID
 *     "nickname": "夜行者",          // 必填，清洗后 1–12 个字符
 *     "score": 1234,                // 必填，非负整数；本作里是「累计总开采量」
 *     "avatar": "data:image/jpeg;base64,...", // 可选，<=200KB，jpeg/png/webp
 *     "stats": { "runs": 12, "wins": 7, "best": 31 } // 可选，白名单数值
 *   }
 *
 * 带 playerId 时为 upsert：昵称/头像/统计会更新，分数只增不减（数据库触发器）。
 */

const MAX_BODY_BYTES = 512 * 1024;
const MAX_AVATAR_BYTES = 200 * 1024;
const MAX_SCORE = 1_000_000_000;
const MAX_NICKNAME_CHARS = 12;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_PER_WINDOW = 5;
const DEFAULT_BUCKET = 'avatars';
const STAT_KEYS = ['runs', 'wins', 'mined', 'best', 'kills', 'survived', 'ore'];

export const config = { path: '/api/leaderboard' };

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

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
  return Object.assign(
    { apikey: cfg.key, authorization: 'Bearer ' + cfg.key },
    extra || {}
  );
}

/** 清洗昵称：NFKC、去掉控制字符/零宽字符、压缩空白、按码点截断 */
function cleanNickname(value) {
  if (typeof value !== 'string') return null;
  const s = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  if (!chars.length) return null;
  return chars.slice(0, MAX_NICKNAME_CHARS).join('');
}

function cleanScore(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (!Number.isInteger(n) || n < 0 || n > MAX_SCORE) return null;
  return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 玩家标识：可选；给了就必须是合法 UUID */
function parsePlayerId(value) {
  if (value === undefined || value === null || value === '') return { ok: true, id: null };
  if (typeof value !== 'string' || !UUID_RE.test(value)) return { ok: false, id: null };
  return { ok: true, id: value.toLowerCase() };
}

/** 只保留白名单里的非负数值，其余丢弃 */
function cleanStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (let i = 0; i < STAT_KEYS.length; i++) {
    const k = STAT_KEYS[i];
    const n = value[k];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
      out[k] = Math.min(Math.floor(n), MAX_SCORE);
    }
  }
  return out;
}

/** 校验 data URL 的 MIME、base64 与文件头，返回 Buffer */
function parseAvatarDataUrl(value) {
  if (value === undefined || value === null || value === '') return { ok: true, avatar: null };
  if (typeof value !== 'string') return { ok: false, code: 'invalid_avatar' };

  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(value.trim());
  if (!m) return { ok: false, code: 'invalid_avatar' };

  const mime = m[1];
  const b64 = m[2].replace(/\s+/g, '');
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch (e) {
    return { ok: false, code: 'invalid_avatar' };
  }
  if (!buf.length) return { ok: false, code: 'invalid_avatar' };
  if (buf.length > MAX_AVATAR_BYTES) return { ok: false, code: 'avatar_too_large' };
  if (!matchesMagic(buf, mime)) return { ok: false, code: 'invalid_avatar' };

  return { ok: true, avatar: { mime, buf } };
}

function matchesMagic(buf, mime) {
  if (mime === 'image/jpeg') {
    return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mime === 'image/png') {
    return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  }
  if (mime === 'image/webp') {
    return (
      buf.length > 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  return false;
}

function extFor(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

async function hashIp(ip, salt) {
  if (!ip) return null;
  const data = new TextEncoder().encode(salt + ':' + ip);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/** 读取 count=exact 响应里的总数 */
async function totalFrom(res) {
  if (!res.ok) return null;
  const range = res.headers.get('content-range') || '';
  const total = range.split('/')[1];
  const n = Number(total);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* Supabase 调用                                                       */
/* ------------------------------------------------------------------ */

async function countRecentByIp(cfg, ipHash) {
  if (!ipHash) return 0;
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const url =
    cfg.url +
    '/rest/v1/leaderboard?select=id&ip_hash=eq.' +
    encodeURIComponent(ipHash) +
    '&created_at=gte.' +
    encodeURIComponent(since);
  const res = await fetch(url, {
    headers: sbHeaders(cfg, { prefer: 'count=exact', range: '0-0' })
  });
  const n = await totalFrom(res);
  return n === null ? 0 : n;
}

async function uploadAvatar(cfg, avatar) {
  const path = 'u/' + Date.now().toString(36) + '-' + crypto.randomUUID() + '.' + extFor(avatar.mime);
  const res = await fetch(
    cfg.url + '/storage/v1/object/' + encodeURIComponent(cfg.bucket) + '/' + path,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + cfg.key,
        apikey: cfg.key,
        'content-type': avatar.mime,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-upsert': 'false'
      },
      body: avatar.buf
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('avatar_upload_failed:' + res.status + ':' + detail.slice(0, 200));
  }
  return cfg.url + '/storage/v1/object/public/' + cfg.bucket + '/' + path;
}

async function upsertEntry(cfg, row, playerId) {
  // 有 player_id 时按 player_id upsert：一名玩家在榜上只保留一行，
  // score 由数据库触发器保证只增不减。
  const url =
    cfg.url +
    '/rest/v1/leaderboard' +
    (playerId ? '?on_conflict=player_id' : '');
  const prefer = playerId
    ? 'resolution=merge-duplicates,return=representation'
    : 'return=representation';

  const res = await fetch(url, {
    method: 'POST',
    headers: sbHeaders(cfg, {
      'content-type': 'application/json',
      prefer
    }),
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('insert_failed:' + res.status + ':' + detail.slice(0, 300));
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function rankOf(cfg, score) {
  const res = await fetch(cfg.url + '/rest/v1/leaderboard?select=id&score=gt.' + score, {
    headers: sbHeaders(cfg, { prefer: 'count=exact', range: '0-0' })
  });
  const higher = await totalFrom(res);
  return higher === null ? null : higher + 1;
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

export default async function handler(request, context) {
  const allowedOrigin = env('ALLOWED_ORIGIN', '*');
  const cors = {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method === 'GET') {
    return json(200, { ok: true, service: 'leaderboard-submit', method: 'POST' }, cors);
  }

  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' }, cors, { allow: 'POST, OPTIONS' });
  }

  /* ---------- 1. 读 body ---------- */
  let raw = '';
  try {
    raw = await request.text();
  } catch (e) {
    return json(400, { ok: false, error: 'invalid_body' }, cors);
  }
  if (raw.length > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: 'body_too_large' }, cors);
  }

  let body = null;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return json(400, { ok: false, error: 'invalid_json' }, cors);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, { ok: false, error: 'invalid_json' }, cors);
  }

  /* ---------- 2. 校验 ---------- */
  const nickname = cleanNickname(body.nickname);
  if (!nickname) {
    return json(400, { ok: false, error: 'invalid_nickname' }, cors);
  }

  const score = cleanScore(body.score);
  if (score === null) {
    return json(400, { ok: false, error: 'invalid_score' }, cors);
  }

  const avatarResult = parseAvatarDataUrl(body.avatar);
  if (!avatarResult.ok) {
    const status = avatarResult.code === 'avatar_too_large' ? 413 : 415;
    return json(status, { ok: false, error: avatarResult.code }, cors);
  }

  const stats = cleanStats(body.stats);
  const playerResult = parsePlayerId(body.playerId);
  if (!playerResult.ok) {
    return json(400, { ok: false, error: 'invalid_player_id' }, cors);
  }
  const playerId = playerResult.id;
  const cfg = sbEnv();

  if (!cfg.dryRun && (!cfg.url || !cfg.key)) {
    console.error('leaderboard-submit: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return json(500, { ok: false, error: 'server_misconfigured' }, cors);
  }

  /* ---------- 3. IP 哈希 + 限流 ---------- */
  const ip =
    (context && context.ip) ||
    request.headers.get('x-nf-client-connection-ip') ||
    request.headers.get('x-forwarded-for') ||
    '';
  const clientIp = String(ip).split(',')[0].trim();
  const salt = env('RATE_SALT', 'wt-leaderboard');
  const ipHash = await hashIp(clientIp, salt);

  if (cfg.dryRun) {
    return json(
      201,
      {
        ok: true,
        dryRun: true,
        received: {
          playerId,
          nickname,
          score,
          stats,
          avatarBytes: avatarResult.avatar ? avatarResult.avatar.buf.length : 0,
          ipHash
        }
      },
      cors
    );
  }

  try {
    const recent = await countRecentByIp(cfg, ipHash);
    if (recent >= RATE_LIMIT_PER_WINDOW) {
      return json(429, { ok: false, error: 'rate_limited', retryAfter: 60 }, cors, {
        'retry-after': '60'
      });
    }

    let avatarUrl = null;
    const warnings = [];
    if (avatarResult.avatar) {
      try {
        avatarUrl = await uploadAvatar(cfg, avatarResult.avatar);
      } catch (e) {
        // 头像失败不阻断成绩提交，但要如实告诉客户端
        console.error('leaderboard-submit: avatar upload failed', e.message);
        warnings.push('avatar_upload_failed');
      }
    }

    const row = {
      nickname,
      score,
      stats,
      ip_hash: ipHash
    };
    if (playerId) row.player_id = playerId;
    // 没带新头像时不覆盖已有头像（upsert 只更新 payload 里的列）
    if (avatarUrl || !playerId) row.avatar_url = avatarUrl;

    const entry = await upsertEntry(cfg, row, playerId);
    const finalScore = entry && typeof entry.score === 'number' ? entry.score : score;

    let rank = null;
    try {
      rank = await rankOf(cfg, finalScore);
    } catch (e) {
      console.error('leaderboard-submit: rank query failed', e.message);
    }

    return json(
      201,
      {
        ok: true,
        entry: {
          id: entry ? entry.id : null,
          nickname,
          score: finalScore,
          avatar_url: entry && entry.avatar_url !== undefined ? entry.avatar_url : avatarUrl,
          stats,
          created_at: entry ? entry.created_at : new Date().toISOString()
        },
        rank,
        warnings
      },
      cors
    );
  } catch (e) {
    console.error('leaderboard-submit: upstream error', e && e.stack ? e.stack : e);
    return json(502, { ok: false, error: 'upstream_error' }, cors);
  }
}
