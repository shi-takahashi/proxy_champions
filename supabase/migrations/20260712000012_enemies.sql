-- 敵（モンスター）をマスタテーブル管理にする（企画書3.3 派遣ダンジョン／敵の多様化）。
--   ・enemy_catalog … 敵の正本（完全DB管理）。ステ値/魔法ライン/装備を JSONB で保持し、
--     DB 行を編集するだけで新規追加・強さ調整ができる（engine の再デプロイ不要）。
--   ・dungeons.encounter_table … そのダンジョンに「どの敵が」「どの重みで」出るかの遭遇表
--     （ドロップ表と同じタグ無し重み付きリスト）。DB を編集するだけで編成を変えられる：
--       例）魔法型の weight を高く＝魔法使いが多いダンジョン
--       例）オーガを低 weight で1枠＝低確率で強敵が出るダンジョン
--
-- 敵の強さは encounter_table の編成が決める（dungeons.difficulty は報酬レート専用に据え置き）。
-- 敵ビルドは Edge Function(run-dispatch) が enemy_catalog 行から組み、engine dive() に渡す。
-- 装備 id（weapon/armor/shield）は engine の WEAPONS/ARMORS/SHIELDS を参照（そこは engine 正本）。

-- ── enemy_catalog（共有コンテンツ＝全員読める・書き込みは service_role のみ）
--   stats:       { vit, mag, pow, spd, men }（engine の Stats）
--   spell_lines: { fire, cure, sleep, strength }（魔法ライン修行値・10 ごとに1 Tier）
--   equipment:   { weapon, armor, shield }（engine 装備 id または null＝素手/無し）
create table public.enemy_catalog (
  id          text  primary key,
  name        text  not null,
  level       int   not null default 1 check (level >= 1),
  stats       jsonb not null,
  spell_lines jsonb not null default '{"fire":0,"cure":0,"sleep":0,"strength":0}'::jsonb,
  equipment   jsonb not null default '{"weapon":null,"armor":null,"shield":null}'::jsonb
);

-- ── seed（標準6種・雑魚〜強敵まで型を散らす）
insert into public.enemy_catalog (id, name, level, stats, spell_lines, equipment) values
  ('slime',  'スライム',  1,
   '{"vit":6,"mag":1,"pow":4,"spd":5,"men":2}',
   '{"fire":0,"cure":0,"sleep":0,"strength":0}',
   '{"weapon":null,"armor":null,"shield":null}'),
  ('goblin', 'ゴブリン',  2,
   '{"vit":10,"mag":2,"pow":8,"spd":7,"men":4}',
   '{"fire":0,"cure":0,"sleep":0,"strength":0}',
   '{"weapon":"dagger","armor":"mail_leather","shield":null}'),
  ('bat',    'コウモリ',  2,
   '{"vit":6,"mag":2,"pow":5,"spd":12,"men":3}',
   '{"fire":0,"cure":0,"sleep":0,"strength":0}',
   '{"weapon":null,"armor":null,"shield":null}'),
  ('wizard', '魔法使い',  4,
   '{"vit":7,"mag":14,"pow":3,"spd":8,"men":6}',
   '{"fire":20,"cure":0,"sleep":0,"strength":0}',
   '{"weapon":"staff_oak","armor":"robe","shield":null}'),
  ('statue', '石像',      5,
   '{"vit":22,"mag":2,"pow":9,"spd":3,"men":8}',
   '{"fire":0,"cure":0,"sleep":0,"strength":0}',
   '{"weapon":null,"armor":"mail_iron","shield":"shield_iron"}'),
  ('ogre',   'オーガ',    6,
   '{"vit":20,"mag":2,"pow":16,"spd":6,"men":6}',
   '{"fire":0,"cure":0,"sleep":0,"strength":0}',
   '{"weapon":"axe_battle","armor":"mail_iron","shield":null}');

-- ── dungeons に遭遇表を追加（[{ "enemy_id": "slime", "weight": 6 }, ...]）
alter table public.dungeons
  add column encounter_table jsonb not null default '[]'::jsonb;

comment on column public.dungeons.encounter_table is
  '遭遇表: [{ "enemy_id": "slime", "weight": 6 }, ...]（enemy_catalog.id を重み付きで参照）';

-- 入門ダンジョン「初心者の草原」の編成: 雑魚多め・素早い/魔法型を少し・低確率でオーガ（強敵）。
update public.dungeons set encounter_table = '[
  {"enemy_id":"slime","weight":6},
  {"enemy_id":"goblin","weight":4},
  {"enemy_id":"bat","weight":3},
  {"enemy_id":"wizard","weight":2},
  {"enemy_id":"ogre","weight":1}
]'::jsonb
where slug = 'novice_field';

-- ── RLS
alter table public.enemy_catalog enable row level security;

create policy "enemy_catalog: 全員参照"
  on public.enemy_catalog for select
  using (true);
