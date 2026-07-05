-- M3: 大会系（企画書5章・実装プラン M6 で本格運用／ここは器＋契約）
--   divisions（ディビジョン・昇降格の階層）
--   tournaments（1開催）
--   matches（対戦カード＋結果＋eventLog／企画書13.1 の再生契約を保存）
--   standings（順位表）
-- すべて共有コンテンツ＝全員参照可（非同期観戦）。書き込みは service_role のみ
-- （M6 の pg_cron バッチが RLS を越えて実行）。matches の status/processed_at は冪等バッチ用。

-- ── divisions（1〜2階層・昇降格／企画書5.2）
create table public.divisions (
  id   uuid primary key default gen_random_uuid(),
  tier int  not null,                          -- 小さいほど上位
  name text not null,
  unique (tier)
);

insert into public.divisions (tier, name) values
  (1, 'マスター'),
  (2, 'チャレンジャー');

-- ── tournaments
create table public.tournaments (
  id           uuid primary key default gen_random_uuid(),
  division_id  uuid        references public.divisions (id) on delete set null,
  name         text        not null,
  status       text        not null default 'scheduled'
                 check (status in ('scheduled', 'running', 'finished')),
  season       int,
  scheduled_at timestamptz,
  created_at   timestamptz not null default now()
);

create index tournaments_division_idx on public.tournaments (division_id);

-- ── matches（結果＋eventLog）
create table public.matches (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid        references public.tournaments (id) on delete cascade,
  round         int,
  character_a   uuid        references public.characters (id) on delete set null,
  character_b   uuid        references public.characters (id) on delete set null,
  seed          bigint      not null,                    -- 決定論の記録（企画書13.4）
  winner        text        check (winner in ('A', 'B', 'draw')),
  turns         int,
  event_log     jsonb,                                   -- battle() の eventLog（企画書13.1）
  status        text        not null default 'pending'
                  check (status in ('pending', 'done')), -- 冪等バッチ用
  processed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index matches_tournament_idx on public.matches (tournament_id);
create index matches_pending_idx on public.matches (tournament_id) where status = 'pending';

-- ── standings（順位表）
create table public.standings (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  character_id  uuid not null references public.characters (id) on delete cascade,
  wins          int  not null default 0,
  losses        int  not null default 0,
  draws         int  not null default 0,
  points        int  not null default 0,
  rank          int,
  unique (tournament_id, character_id)
);

create index standings_tournament_idx on public.standings (tournament_id);

-- ── RLS: 全員参照（観戦）。書き込みは service_role（バッチ）のみ
alter table public.divisions   enable row level security;
alter table public.tournaments enable row level security;
alter table public.matches     enable row level security;
alter table public.standings   enable row level security;

create policy "divisions: 全員参照"   on public.divisions   for select using (true);
create policy "tournaments: 全員参照" on public.tournaments for select using (true);
create policy "matches: 全員参照"     on public.matches     for select using (true);
create policy "standings: 全員参照"   on public.standings   for select using (true);
