-- M3: dungeons（企画書3.3 派遣ダンジョン／M5 で本格運用）
--   タイプ・難易度・推奨潜航時間・ドロップ表。共有コンテンツ（全員読める）。
--   drop_table は仮スキーマ: [{ "equipment_id": "sword_iron", "weight": 10 }, ...]
--   （報酬設計の具体は M5・企画書12章で確定。ここは器だけ用意）

create table public.dungeons (
  id                       uuid primary key default gen_random_uuid(),
  slug                     text unique not null,
  name                     text        not null,
  type                     text        not null,          -- gold / xp / equipment 狙い等
  difficulty               int         not null default 1 check (difficulty >= 1),
  recommended_dive_minutes int         not null default 30 check (recommended_dive_minutes > 0),
  drop_table               jsonb       not null default '[]'::jsonb,
  created_at               timestamptz not null default now()
);

-- ── seed（仮の入門ダンジョン1本・M5 で拡充）
insert into public.dungeons (slug, name, type, difficulty, recommended_dive_minutes, drop_table) values
  ('novice_field', '初心者の草原', 'xp', 1, 30,
   '[{"equipment_id":"dagger","weight":5},{"equipment_id":"mail_leather","weight":5}]'::jsonb);

-- ── RLS: 共有コンテンツ＝全員参照（書き込みは service_role のみ）
alter table public.dungeons enable row level security;

create policy "dungeons: 全員参照"
  on public.dungeons for select
  using (true);
