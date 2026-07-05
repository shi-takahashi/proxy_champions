-- M3: characters（= CharacterBuild／engine/src/schema.ts が正本）
-- ハイブリッド保存（実装プラン L315）:
--   ・検索/集計する軸（player_id / name / level / 時刻）は列
--   ・ビルド本体（stats / spell_lines / equipment）は JSONB で TS 契約とそのまま一致
--     → engine 入力（CharacterBuild）と DB 保存が往復で完全一致（M4 で battle() に渡す）
--
-- JSONB キーは engine の契約に合わせる（camelCase を跨がせない）:
--   stats       = {vit,mag,pow,spd,men}                 （Stats）
--   spell_lines = {fire,cure,sleep,strength}            （SpellLines）
--   equipment   = {weapon,armor,shield}（値=装備id or null）（EquipmentLoadout）
-- CharacterBuild を組む時: { characterId: id, level, stats, spellLines: spell_lines, equipment }

create table public.characters (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid        not null references public.players (id) on delete cascade,
  name        text        not null,
  level       int         not null default 1 check (level >= 1),
  stats       jsonb       not null,
  spell_lines jsonb       not null default '{"fire":0,"cure":0,"sleep":0,"strength":0}'::jsonb,
  equipment   jsonb       not null default '{"weapon":null,"armor":null,"shield":null}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- 契約の最低限の健全性（5ステ・4ライン・3枠が揃っている）
  constraint characters_stats_shape
    check (stats ?& array['vit','mag','pow','spd','men']),
  constraint characters_spell_lines_shape
    check (spell_lines ?& array['fire','cure','sleep','strength']),
  constraint characters_equipment_shape
    check (equipment ?& array['weapon','armor','shield'])
);

create index characters_player_id_idx on public.characters (player_id);

create trigger characters_set_updated_at
  before update on public.characters
  for each row execute function public.set_updated_at();

-- ── RLS: 自分のキャラのみ CRUD（対戦計算は service_role が RLS を越えて読む）
alter table public.characters enable row level security;

create policy "characters: 自分のキャラを参照"
  on public.characters for select
  using (auth.uid() = player_id);

create policy "characters: 自分のキャラを作成"
  on public.characters for insert
  with check (auth.uid() = player_id);

create policy "characters: 自分のキャラを更新"
  on public.characters for update
  using (auth.uid() = player_id)
  with check (auth.uid() = player_id);

create policy "characters: 自分のキャラを削除"
  on public.characters for delete
  using (auth.uid() = player_id);
