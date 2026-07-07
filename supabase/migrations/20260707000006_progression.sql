-- M5.3: 育成ループの永続化（企画書3.3 派遣ダンジョン／実装プラン M5.3）
--   characters に 成長(xp) ＋ 体力ループ(current_hp / hp_updated_at) を追加。
--   players に 回復薬(potions)。dispatches に派遣履歴（DiveResult を保存）。
--
-- 正本の棲み分け（ドリフト防止）:
--   ・xp → level は engine growth（gainXp）が正本。level 列は materialized な派生値
--     （Edge Function が xp 更新時に gainXp で再計算して書く）。
--   ・current_hp は絶対HP。maxHP は engine（vit×倍率・formulas）が正本で DB は持たない。
--     null = 満タン（未派遣の初期状態）。
--   ・自然回復は engine staminaRecover が正本。DB は hp_updated_at（起点）だけ持ち、
--     Edge Function が now()-hp_updated_at から回復量を算出する。

-- ── characters: 成長＋体力ループ
alter table public.characters
  add column xp            bigint      not null default 0 check (xp >= 0),
  add column current_hp    int                            check (current_hp >= 0), -- null=満タン
  add column hp_updated_at timestamptz not null default now();                     -- 自然回復の起点

-- ── players: 回復薬（体力を一気に回復・企画書3.3）
alter table public.players
  add column potions int not null default 0 check (potions >= 0);

-- ── dispatches（派遣履歴＝1回の潜航の記録）
--   非同期観戦の縦版: あとで明細（どの敵に勝った/ドロップ/帰還理由）を振り返れる。
--   書き込みは service_role（Edge Function）のみ＝報酬計算をサーバー権威に寄せる（企画書13.6）。
create table public.dispatches (
  id           uuid        primary key default gen_random_uuid(),
  player_id    uuid        not null references public.players (id)    on delete cascade,
  character_id uuid        not null references public.characters (id) on delete cascade,
  dungeon_id   uuid        not null references public.dungeons (id),
  minutes      int         not null check (minutes > 0),
  seed         bigint      not null,                                  -- 決定論の記録（再現・検証／企画書13.4）
  start_hp     int         not null check (start_hp >= 0),            -- 派遣開始時の体力（再派遣の透明性）
  end_reason   text        not null check (end_reason in ('time', 'ko')),
  xp_gained    bigint      not null default 0 check (xp_gained >= 0),
  gold_gained  bigint      not null default 0 check (gold_gained >= 0),
  hp_remaining int         not null check (hp_remaining >= 0),
  result       jsonb       not null,                                  -- DiveResult（明細・ドロップ）
  created_at   timestamptz not null default now()
);

create index dispatches_player_idx on public.dispatches (player_id);
create index dispatches_character_idx on public.dispatches (character_id);

-- ── RLS: 自分の派遣履歴のみ参照。書き込みは service_role（Edge Function）のみ
alter table public.dispatches enable row level security;

create policy "dispatches: 自分の履歴を参照"
  on public.dispatches for select
  using (auth.uid() = player_id);
