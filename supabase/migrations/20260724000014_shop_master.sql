-- ショップマスタ（販売リスト）：「何を・いくらで・いつ売るか」を1テーブルで運用管理する。
--   狙い：通常は売らない商品を期間限定で出す／セール価格にする等を、コード変更なしに
--         shop_listings 行の追加・編集だけで制御できるようにする（運用＝ライブ ops）。
--
-- これまで（migration 13）は equipment_catalog / item_catalog に price 列を足し
-- 「価格が入っていれば販売中」という派生的な扱いだった。これを撤去し、販売の正本を
-- 独立した shop_listings に移す（在庫と期間を独立管理するため）。
--
-- 正本の棲み分け（更新）:
--   ・「販売リスト（商品名/説明/種類/期間/価格）」の正本 = このテーブル shop_listings（DB）。
--   ・「アイテムがどう振る舞うか（回復量・戦闘効果）」の正本 = engine（ITEMS/WEAPONS 等）。
--   ・equipment_catalog / item_catalog は「全アイテムの登録簿（FK 先・実体）」＝付与対象の実在保証。
--   ・buy（Edge Function）は shop_listings を service_role で読み、販売期間内かを検証して価格を確定
--     ＝クライアント申告の価格/在庫/期間は信じない（企画書13.6）。

-- ── ショップマスタ本体
create table public.shop_listings (
  id            uuid        primary key default gen_random_uuid(),
  product_type  text        not null check (product_type in ('equipment', 'item')),  -- 商品種類
  -- 付与する実体（種類に応じてどちらか一方だけを埋める＝FK で実在保証・polymorphic）
  equipment_id  text        references public.equipment_catalog (id),
  item_id       text        references public.item_catalog (id),
  name          text        not null,                                   -- 商品名（表示・セール名も付けられる）
  description   text,                                                   -- 商品説明（任意）
  price         int         not null check (price > 0),                 -- 必要コイン数（セールで安くも設定可）
  starts_at     timestamptz,                                            -- 販売開始日時（null = 開始制限なし）
  ends_at       timestamptz,                                            -- 販売終了日時（null = 無期限）
  active        boolean     not null default true,                      -- 手動オン/オフ（期間と別に即停止できる）
  sort_order    int         not null default 100,                       -- 表示順（小さいほど上）
  created_at    timestamptz not null default now(),
  -- 種類と実体の整合を強制：equipment なら equipment_id のみ／item なら item_id のみ
  constraint shop_listings_ref_matches_type check (
    (product_type = 'equipment' and equipment_id is not null and item_id is null) or
    (product_type = 'item'      and item_id      is not null and equipment_id is null)
  ),
  -- 開始 < 終了（両方指定時のみ）
  constraint shop_listings_window_ordered check (
    starts_at is null or ends_at is null or starts_at < ends_at
  )
);

create index shop_listings_active_idx on public.shop_listings (active, starts_at, ends_at);

-- ── 既存の price（migration 13）を販売リストへ移送：現行価格を「無期限・常時販売」の行として作る。
--   価格をハードコードせず catalog.price から carry-forward（13 が seed した値をそのまま引き継ぐ）。
insert into public.shop_listings (product_type, equipment_id, name, price, sort_order)
  select 'equipment', c.id, c.name, c.price,
         case c.slot when 'weapon' then 10 when 'armor' then 20 else 30 end
  from public.equipment_catalog c
  where c.price is not null;

insert into public.shop_listings (product_type, item_id, name, price, sort_order)
  select 'item', c.id, c.name, c.price, 40
  from public.item_catalog c
  where c.price is not null;

-- ── price 列は shop_listings に移ったので catalog からは撤去（販売の正本を一本化）
alter table public.equipment_catalog drop column price;
alter table public.item_catalog       drop column price;

-- ── 「今」販売中の商品を返す関数（now() で期間判定＝表示もサーバー時刻が権威）。
--   security definer で shop_listings（クライアント非公開）を代理参照し、有効な行だけ露出する
--   ＝将来の期間限定商品を事前に覗かせない。装備の所持判定に使う equipment_id も返す。
create or replace function public.available_shop_listings()
returns table (
  listing_id   uuid,
  product_type text,
  equipment_id text,
  item_id      text,
  name         text,
  description  text,
  price        int,
  starts_at    timestamptz,
  ends_at      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select l.id, l.product_type, l.equipment_id, l.item_id,
         l.name, l.description, l.price, l.starts_at, l.ends_at
  from public.shop_listings l
  where l.active
    and (l.starts_at is null or l.starts_at <= now())
    and (l.ends_at   is null or l.ends_at   >  now())
  order by l.sort_order, l.price, l.name;
$$;

grant execute on function public.available_shop_listings() to anon, authenticated;

-- ── RLS：マスタ本体はクライアントに公開しない（有効行は上記関数経由でだけ見せる）。
--   書き込み（販売リストの編集）は service_role / DB 管理者のみ＝運用が SQL で管理する。
alter table public.shop_listings enable row level security;
-- select/insert/update/delete いずれのポリシーも作らない＝anon/authenticated は本体を読めない。
-- Edge Function は service_role キーで RLS を越えて読む（buy）。運用は service_role/psql で編集する。
