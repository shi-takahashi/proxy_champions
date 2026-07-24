-- 売却価格（ショップで不要な装備/アイテムを売る・企画書3.6 ゴールドの入手/シンク周り）
--   買値（shop_listings.price）はショップの販売リスト都合で変動しうる（セール・期間限定）が、
--   「そのアイテム/装備を売ったらいくらか」は在庫の内在的価値＝カタログが持つべき。
--   ショップに並んでいない（販売終了・ドロップ限定）ものでも売れるようにするため、ここが必要。
--
-- 正本の棲み分け:
--   ・売却価格の正本 = equipment_catalog.sell_price / item_catalog.sell_price（DB マスタ）。
--   ・sell（Edge Function）はこの値を service_role で読んで gold 加算＝クライアント申告は信じない。
--   ・sell_price = null は「売却不可」（クエスト品など。今は全カタログ売却可）。
--   ・値は仮（おおむね標準買値の 50%）。買値と同じく運用が catalog を編集して調整する。

alter table public.equipment_catalog
  add column sell_price int check (sell_price is null or sell_price > 0);

update public.equipment_catalog set sell_price = v.sell_price
from (values
  ('sword_iron',   100),
  ('axe_battle',   150),
  ('dagger',        90),
  ('staff_oak',    110),
  ('mail_leather',  75),
  ('mail_iron',    150),
  ('robe',          75),
  ('shield_wood',   50),
  ('shield_iron',  100)
) as v(id, sell_price)
where equipment_catalog.id = v.id;

alter table public.item_catalog
  add column sell_price int check (sell_price is null or sell_price > 0);

update public.item_catalog set sell_price = v.sell_price
from (values
  ('potion_hp_small',  15),
  ('potion_hp_full',   75),
  ('potion_mp_small',  15),
  ('potion_mp_full',   75),
  ('elixir',          200)
) as v(id, sell_price)
where item_catalog.id = v.id;

-- sell_price はカタログの一部＝既存の「全員参照」ポリシーでそのまま読める（追加ポリシー不要）。
