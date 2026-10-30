-- ============================================================
-- 《无烬冬日 · 潮汐求生》云端排行榜 · Supabase 初始化
-- 用法：Supabase 控制台 → SQL Editor → 新建查询 → 整段粘贴执行
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- 排行榜 ----------
create table if not exists public.leaderboard (
  id          uuid primary key default gen_random_uuid(),
  nickname    text        not null,
  score       integer     not null,
  avatar_url  text,
  stats       jsonb       not null default '{}'::jsonb,
  ip_hash     text,
  created_at  timestamptz not null default now(),
  constraint leaderboard_nickname_len  check (char_length(nickname) between 1 and 12),
  constraint leaderboard_score_range   check (score >= 0)
);

comment on table  public.leaderboard            is '排行榜提交记录（昵称 / 分数 / 头像 / 统计）';
comment on column public.leaderboard.stats      is '本局或生涯统计，白名单字段：runs,wins,mined,best,kills,survived,ore';
comment on column public.leaderboard.ip_hash    is '提交者 IP 的加盐 SHA-256 前 32 位，仅用于限流，不存明文 IP';

-- 榜单排序：分数高的在前，同分先到先得
create index if not exists leaderboard_score_idx   on public.leaderboard (score desc, created_at asc);
create index if not exists leaderboard_created_idx on public.leaderboard (created_at desc);
-- 限流查询：同一 IP 最近一分钟提交了几次
create index if not exists leaderboard_ip_idx      on public.leaderboard (ip_hash, created_at desc);

-- ---------- 行级安全 ----------
alter table public.leaderboard enable row level security;

-- 读：公开（前端用 anon key 就能拉榜）
drop policy if exists leaderboard_read on public.leaderboard;
create policy leaderboard_read
  on public.leaderboard
  for select
  using (true);

-- 写：不开放给 anon / authenticated。
-- service_role 会绕过 RLS，所以只有 Netlify Function 能写入。

-- ---------- 头像存储桶 ----------
-- 公开读（拿到 public URL 就能显示），写入只走 service_role
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = excluded.public;

-- 如果之后想禁止匿名直接读文件，把上面 public 改成 false，
-- 并改为用 Netlify Function 签发 signed URL。
