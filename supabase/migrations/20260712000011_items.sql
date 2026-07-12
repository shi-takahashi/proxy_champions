-- アイテム（消耗品・回復薬）を装備と同格のデータモデルにする（企画書3.3 回復薬）。
--   装備(equipment)と同じ「カタログ＋所持テーブル」構造。ただし消耗品なので所持は数量を持つ
--   （装備＝型の所持有無／アイテム＝個数）。
--
-- 正本の棲み分け（ドリフト防止・装備と同じ思想）:
--   ・回復効果（effect_kind / effect_pct）の正本は engine/src/formulas.ts の ITEMS。
--     Edge Function（use_item）は engine の ITEMS から回復量を算出する。
--   ・DB の item_catalog は FK 先＋クライアント表示用のミラー（装備の equipment_catalog と同じ役回り）。
--
-- 旧 players.potions（HP 全回復の単一カウンタ）はこのテーブルへ移行して撤去する
--   （回復量の異なる回復薬を複数持てるようにする＝装備と同じ非対称のない管理へ統一）。

-- ── item_catalog（共有コンテンツ＝全員読める）
--   effect_kind: hp=HP回復 / mp=MP回復 / both=HP+MP回復
--   effect_pct : 最大値に対する回復割合（0.10=10% / 1.00=全回復）
create table public.item_catalog (
  id          text primary key,                                          -- engine の ITEMS id と一致
  name        text    not null,
  effect_kind text    not null check (effect_kind in ('hp', 'mp', 'both')),
  effect_pct  numeric not null check (effect_pct > 0 and effect_pct <= 1)
);

-- ── seed（engine/src/formulas.ts の ITEMS を反映・内容の正本は engine）
insert into public.item_catalog (id, name, effect_kind, effect_pct) values
  ('potion_hp_small', 'HP回復薬（小）', 'hp',   0.10),
  ('potion_hp_full',  'HP回復薬（大）', 'hp',   1.00),
  ('potion_mp_small', 'MP回復薬（小）', 'mp',   0.10),
  ('potion_mp_full',  'MP回復薬（大）', 'mp',   1.00),
  ('elixir',          'エリクサー',     'both', 1.00);

-- ── player_items（所持・数量あり）
--   装備は型の所持有無（unique だけ）だが、消耗品は個数を持つ（quantity）。
--   書き込みは service_role（Edge Function）のみ＝アイテムの入手/消費をサーバー権威に寄せる（企画書13.6）。
create table public.player_items (
  id          uuid        primary key default gen_random_uuid(),
  player_id   uuid        not null references public.players (id)      on delete cascade,
  item_id     text        not null references public.item_catalog (id),
  quantity    int         not null default 0 check (quantity >= 0),
  acquired_at timestamptz not null default now(),
  unique (player_id, item_id)                                          -- 1 アイテム種別 = 1 行（quantity で個数）
);

create index player_items_player_id_idx on public.player_items (player_id);

-- ── 旧 players.potions → player_items（potion_hp_full）へ移行してから撤去
insert into public.player_items (player_id, item_id, quantity)
  select id, 'potion_hp_full', potions from public.players where potions > 0;

alter table public.players drop column potions;

-- ── ダンジョンのドロップ表を装備・アイテム両対応のタグ付き形へ更新（アイテムも入手できるようにする）
--   旧: [{ "equipment_id": "dagger", "weight": 5 }, ...]
--   新: [{ "kind": "equipment"|"item", "id": "...", "weight": 5 }, ...]
comment on column public.dungeons.drop_table is
  'タグ付きドロップ表: [{ "kind": "equipment"|"item", "id": "dagger", "weight": 5 }, ...]';

update public.dungeons set drop_table = '[
  {"kind":"equipment","id":"dagger","weight":5},
  {"kind":"equipment","id":"mail_leather","weight":5},
  {"kind":"item","id":"potion_hp_small","weight":4},
  {"kind":"item","id":"potion_mp_small","weight":4}
]'::jsonb
where slug = 'novice_field';

-- ── RLS
alter table public.item_catalog enable row level security;
alter table public.player_items  enable row level security;

-- カタログは共有コンテンツ＝全員読める（書き込みは service_role のみ）
create policy "item_catalog: 全員参照"
  on public.item_catalog for select
  using (true);

-- 所持は本人のみ参照（入手/消費の書き込みは service_role が RLS を越えて行う）
create policy "player_items: 自分の所持を参照"
  on public.player_items for select
  using (auth.uid() = player_id);
