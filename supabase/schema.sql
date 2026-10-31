-- ============================================================
-- 《无烬冬日 · 潮汐求生》云端排行榜 · Supabase 初始化 / 升级
-- 用法：Supabase 控制台 → SQL Editor → 新建查询 → 整段粘贴执行
-- 本文件可重复执行（幂等），旧版本表结构会自动补齐新列。
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- 排行榜 ----------
-- 一名玩家一行：player_id 由客户端生成并持久化，
-- 提交时按 player_id upsert，score 取历史最大值（累计总开采量）。
create table if not exists public.leaderboard (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid,
  nickname    text        not null,
  score       integer     not null,
  avatar_url  text,
  stats       jsonb       not null default '{}'::jsonb,
  ip_hash     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint leaderboard_nickname_len check (char_length(nickname) between 1 and 12),
  constraint leaderboard_score_range  check (score >= 0)
);

-- 兼容已经建过表的环境
alter table public.leaderboard add column if not exists player_id  uuid;
alter table public.leaderboard add column if not exists updated_at timestamptz;
update public.leaderboard set updated_at = created_at where updated_at is null;
alter table public.leaderboard alter column updated_at set default now();
alter table public.leaderboard alter column updated_at set not null;

-- player_id 唯一：每名玩家只有一行（NULL 不冲突，兼容旧的匿名记录）
create unique index if not exists leaderboard_player_uidx on public.leaderboard (player_id);

comment on table  public.leaderboard            is '排行榜：一名玩家一行，score 为累计总开采量';
comment on column public.leaderboard.player_id  is '客户端生成并持久化的玩家标识，用于 upsert';
comment on column public.leaderboard.stats      is '白名单统计字段：runs,wins,mined,best,kills,survived,ore';
comment on column public.leaderboard.ip_hash    is '提交者 IP 的加盐 SHA-256 前 32 位，仅用于限流';

-- 榜单排序：累计开采量高的在前，同分先达成者在前
create index if not exists leaderboard_score_idx   on public.leaderboard (score desc, created_at asc);
create index if not exists leaderboard_created_idx on public.leaderboard (created_at desc);
create index if not exists leaderboard_ip_idx      on public.leaderboard (ip_hash, created_at desc);

-- ---------- 写入前处理 ----------
-- 1. 累计分数只增不减（本地存档重置也不会把榜上成绩改小）
-- 2. created_at 保持首次提交时间，updated_at 每次写入刷新
create or replace function public.leaderboard_before_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if old.score > new.score then
      new.score := old.score;
    end if;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists leaderboard_before_write on public.leaderboard;
create trigger leaderboard_before_write
  before insert or update on public.leaderboard
  for each row execute function public.leaderboard_before_write();

-- ---------- 行级安全 ----------
alter table public.leaderboard enable row level security;

-- 读：公开（前端也可以用 anon key 直接查）
drop policy if exists leaderboard_read on public.leaderboard;
create policy leaderboard_read
  on public.leaderboard
  for select
  using (true);

-- 写：不开放给 anon / authenticated；service_role 绕过 RLS，
-- 所以只有 Netlify Function 能写入。

-- ---------- 头像存储桶 ----------
-- 公开读（拿到 public URL 就能显示），写入只走 service_role
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = excluded.public;

-- ============================================================
-- 玩家档案（工号 / 昵称 / 头像 / 最后活跃 / 库存）
-- ============================================================

create table if not exists public.players (
  miner_id       text primary key,
  player_id      uuid unique,
  nickname       text        not null default '无名矿工',
  avatar_url     text,
  inventory      jsonb       not null default '{}'::jsonb,
  last_active_at timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  constraint players_miner_id_fmt check (miner_id ~ '^MINER-[0-9]{6}-[0-9]{6}$'),
  constraint players_nickname_len  check (char_length(nickname) between 1 and 12),
  constraint players_inventory_obj check (jsonb_typeof(inventory) = 'object')
);

comment on table  public.players               is '玩家云端档案：一名玩家一行，主键为工号';
comment on column public.players.miner_id      is '工号，格式 MINER-YYYYMM-XXXXXX';
comment on column public.players.player_id     is '与排行榜关联的客户端 UUID（可空）';
comment on column public.players.inventory     is '玩家点「同步库存」时上传的库存快照（JSON）';
comment on column public.players.last_active_at is '最后一次同步/活跃时间';

create index if not exists players_active_idx on public.players (last_active_at desc);

-- 只允许 service_role（Netlify Function）读写；
-- 客户端不直连，因此不建任何 anon/authenticated 策略。
alter table public.players enable row level security;

-- ============================================================
-- 好友关系（好友申请 + 已通过）
-- 一行代表一对关系：requester 发起、addressee 接收。
-- ============================================================

create table if not exists public.friendships (
  id              uuid primary key default gen_random_uuid(),
  requester_miner text        not null references public.players(miner_id) on delete cascade,
  addressee_miner text        not null references public.players(miner_id) on delete cascade,
  status          text        not null default 'pending'
                              check (status in ('pending', 'accepted')),
  created_at      timestamptz not null default now(),
  responded_at    timestamptz,
  constraint friendships_not_self check (requester_miner <> addressee_miner)
);

comment on table public.friendships is '好友关系：pending 为待同意，accepted 为已成好友';

-- 同一对玩家只允许一行（与方向无关）：A→B 和 B→A 视为同一对
create unique index if not exists friendships_pair_uidx
  on public.friendships (least(requester_miner, addressee_miner), greatest(requester_miner, addressee_miner));

create index if not exists friendships_requester_idx on public.friendships (requester_miner, status);
create index if not exists friendships_addressee_idx on public.friendships (addressee_miner, status);

alter table public.friendships enable row level security;

