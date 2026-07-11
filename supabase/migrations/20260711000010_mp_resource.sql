-- MP を HP と同格の「管理する資源」にする（企画方針: プレイヤーの理解ハードルを下げ一般的なRPGに寄せる）。
--   HP の current_hp / hp_updated_at と対になる current_mp / mp_updated_at を characters に追加。
--   ・current_mp は絶対MP。maxMP は engine（mag×倍率・formulas）が正本で DB は持たない。
--     null = 満タン（未派遣の初期状態）。
--   ・自然回復は HP と同じ engine staminaRecover・同レート（毎分 最大MPの1%）。
--   ・MP は独立した回復クロック（mp_updated_at）を持つ。
--     → 将来の回復アイテム3種（HP用/MP用/両方用）に素直に対応できる（HP薬は hp 側だけ、MP薬は mp 側だけ触る）。
alter table public.characters
  add column current_mp    int                            check (current_mp >= 0), -- null=満タン
  add column mp_updated_at timestamptz not null default now();                     -- MP 自然回復の起点
