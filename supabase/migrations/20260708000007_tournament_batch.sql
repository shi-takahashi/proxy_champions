-- M6.2: 個人戦バッチ大会の永続化（企画書5章 / 13.5 / 実装プラン M6.2）
--   M3 の器（tournaments/matches/divisions/standings）に「バッチ進行に必要な最小の列」を足す。
--   進行ロジックの正本は engine tournament.ts（roundRobinRounds/tallyStandings/runBracket/
--   promotionRelegation）。ここは「状態を持つ器」だけを拡張する（ドリフト防止）。
--
-- バッチの形（企画書13.5）:
--   open  = エントリー確定 → 出場者ビルドを snapshot → リーグ全カードを pending で materialize
--   tick  = 未処理の最小ラウンドを battle() 一斉 → done＋eventLog 保存 → 順位再計算（冪等）
--           リーグ完走 → 決勝トーナメント＋昇降格を確定 → status=finished
-- 冪等: 各カードのシードは open 時に deriveSeed で確定して matches.seed に保存。
--       tick は status='pending' の行だけ done に倒す＝再実行で二重処理しない。

-- ── tournaments: バッチ進行の状態
alter table public.tournaments
  add column phase       text   not null default 'league'
                 check (phase in ('league', 'bracket', 'done')), -- 予選→決勝→終了
  add column season_seed bigint,                                  -- 決定論の記録（全カードの seed 源・企画書13.4）
  add column champion_id uuid   references public.characters (id) on delete set null,
  add column promotion   jsonb,                                   -- PromotionResult（promote/relegate/stay）
  add column finished_at timestamptz;

-- ── matches: 予選(league)か決勝(bracket)かを区別（round はフェーズ内の連番）
alter table public.matches
  add column phase text not null default 'league'
    check (phase in ('league', 'bracket'));

-- ── tournament_entrants（出場者＝エントリー時点のビルド snapshot）
--   ビルドは snapshot する: シーズン途中のリスペックが過去の対戦を遡って変えない＝公平・決定論。
--   engine の CharacterBuild 契約とキー一致の JSONB（跨ぎは camelCase 変換のみ／M3 と同方針）。
create table public.tournament_entrants (
  id            uuid        primary key default gen_random_uuid(),
  tournament_id uuid        not null references public.tournaments (id) on delete cascade,
  character_id  uuid        not null references public.characters (id)  on delete cascade,
  seed_order    int         not null,                 -- エントリー順（対戦表生成の決定論的順序）
  build         jsonb       not null,                 -- CharacterBuild snapshot（level/stats/spellLines/equipment）
  created_at    timestamptz not null default now(),
  unique (tournament_id, character_id)
);

create index tournament_entrants_tournament_idx
  on public.tournament_entrants (tournament_id);

-- ── RLS: 全員参照（非同期観戦＝誰の大会でも順位/カードを見られる）。書き込みは service_role（バッチ）のみ
alter table public.tournament_entrants enable row level security;

create policy "tournament_entrants: 全員参照"
  on public.tournament_entrants for select using (true);
