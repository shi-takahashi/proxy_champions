-- M3: equipment（企画書3.6・ゴールド軸＝横の「型」）
--   ・equipment_catalog … engine の WEAPONS/ARMORS/SHIELDS の id を正本にミラー（FK先＋ショップ照会用）
--     ステ効果（powMult/physDef 等）は engine/src/formulas.ts が正本なので DB では持たない（ドリフト防止）。
--   ・player_equipment … 所持（MVP は数量なし＝型の所持有無のみ）
-- 参照: engine が id を解決するので DB/Flutter は id を持つだけ（実装プラン 3.2）

create table public.equipment_catalog (
  id   text primary key,                                        -- engine の装備 id と一致
  slot text not null check (slot in ('weapon', 'armor', 'shield')),
  name text not null,
  kind text check (kind in ('physical', 'magic'))               -- weapon のみ意味を持つ
);

create table public.player_equipment (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid        not null references public.players (id) on delete cascade,
  equipment_id text        not null references public.equipment_catalog (id),
  acquired_at  timestamptz not null default now(),
  unique (player_id, equipment_id)                              -- 型は所持有無（重複所持しない）
);

create index player_equipment_player_id_idx on public.player_equipment (player_id);

-- ── seed: engine/src/formulas.ts のカタログを反映（内容の正本は engine）
insert into public.equipment_catalog (id, slot, name, kind) values
  ('sword_iron',   'weapon', '鉄の剣', 'physical'),
  ('axe_battle',   'weapon', '戦斧',   'physical'),
  ('dagger',       'weapon', '短剣',   'physical'),
  ('staff_oak',    'weapon', '樫の杖', 'magic'),
  ('mail_leather', 'armor',  '革鎧',   null),
  ('mail_iron',    'armor',  '鉄鎧',   null),
  ('robe',         'armor',  'ローブ', null),
  ('shield_wood',  'shield', '木の盾', null),
  ('shield_iron',  'shield', '鉄の盾', null);

-- ── RLS
alter table public.equipment_catalog enable row level security;
alter table public.player_equipment  enable row level security;

-- カタログは共有コンテンツ＝全員読める（書き込みは service_role のみ）
create policy "equipment_catalog: 全員参照"
  on public.equipment_catalog for select
  using (true);

-- 所持は本人のみ
create policy "player_equipment: 自分の所持を参照"
  on public.player_equipment for select
  using (auth.uid() = player_id);

create policy "player_equipment: 自分の所持を作成"
  on public.player_equipment for insert
  with check (auth.uid() = player_id);
