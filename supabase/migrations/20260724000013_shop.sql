-- ショップ（ゴールドの出口・企画書3.6「店＝ゴールドで狙い撃ち」／3.3 回復薬）
--   これまでゴールドの用途はリスペックのみ＝ドロップ装備も含め報酬の出口が実質なかった。
--   店で「装備（型）」と「回復薬」をゴールドで買えるようにする（育成ループを閉じる）。
--
-- 正本の棲み分け（ドリフト防止・effect/price ともに engine が正本）:
--   ・価格の正本は engine/src/formulas.ts の SHOP_PRICES。
--     buy（Edge Function）は SHOP_PRICES で価格照会・検証する＝クライアント申告の価格は信じない（企画書13.6）。
--   ・DB の *_catalog.price は FK 先の表示ミラー（equipment_catalog は元々「ショップ照会用」と明記）。
--   price = null は「非売品」（ドロップ限定など）。今は全カタログが売り物。

-- ── equipment_catalog に price（表示ミラー・null=非売品）
alter table public.equipment_catalog
  add column price int check (price is null or price > 0);

update public.equipment_catalog set price = v.price
from (values
  ('sword_iron',   200),
  ('axe_battle',   300),
  ('dagger',       180),
  ('staff_oak',    220),
  ('mail_leather', 150),
  ('mail_iron',    300),
  ('robe',         150),
  ('shield_wood',  100),
  ('shield_iron',  200)
) as v(id, price)
where equipment_catalog.id = v.id;

-- ── item_catalog に price（表示ミラー・null=非売品）
alter table public.item_catalog
  add column price int check (price is null or price > 0);

update public.item_catalog set price = v.price
from (values
  ('potion_hp_small',  30),
  ('potion_hp_full',  150),
  ('potion_mp_small',  30),
  ('potion_mp_full',  150),
  ('elixir',          400)
) as v(id, price)
where item_catalog.id = v.id;

-- ── RLS 追記
--   購入書き込み（gold 減算・所持付与）は buy（service_role）に閉じる＝サーバー権威（企画書13.6）。
--   player_equipment には既に「自分の所持を作成」ポリシーがあるが、店はゴールド減算と原子的にやりたいので
--   Edge Function（service_role）が RLS を越えて実行する（クライアント直挿しは使わない）。
--   price 列はカタログの一部＝既存の「全員参照」ポリシーでそのまま読める（追加ポリシー不要）。
