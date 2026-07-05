-- M3: players（Auth連携・匿名→昇格）／実装プラン M3・企画書13.9
-- auth.users にぶら下がるプロフィール。匿名サインインで自動プロビジョンし、
-- 後からメール/ソーシャルで昇格（is_anonymous を同期）する。

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ── 汎用: updated_at 自動更新（characters 等でも使う）
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── players
create table public.players (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text        not null default 'Player',
  is_anonymous boolean     not null default true, -- 昇格すると false（auth.users から同期）
  gold         bigint      not null default 0 check (gold >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger players_set_updated_at
  before update on public.players
  for each row execute function public.set_updated_at();

-- ── 新規ユーザー（匿名含む）→ players 行を自動生成
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.players (id, is_anonymous, display_name)
  values (
    new.id,
    coalesce(new.is_anonymous, false),
    coalesce(new.raw_user_meta_data ->> 'display_name', 'Player')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 匿名→昇格（auth.users.is_anonymous が false に変わる）を players に同期
create or replace function public.handle_user_upgrade()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.players
     set is_anonymous = coalesce(new.is_anonymous, false),
         updated_at   = now()
   where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_updated
  after update of is_anonymous on auth.users
  for each row execute function public.handle_user_upgrade();

-- ── RLS: 自分の行のみ参照・更新（作成はトリガ／service_role が担う）
alter table public.players enable row level security;

create policy "players: 自分の行を参照"
  on public.players for select
  using (auth.uid() = id);

create policy "players: 自分の行を更新"
  on public.players for update
  using (auth.uid() = id)
  with check (auth.uid() = id);
