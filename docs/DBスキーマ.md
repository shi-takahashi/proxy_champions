# DBスキーマ：PROXY CHAMPIONS

> 全テーブルの一覧・各項目（列）・正本の所在をまとめた DB リファレンス。
> 作成日: 2026-07-24 / 対象: migration 1〜14 適用後のローカルスタック実状態を introspection（列・FK・seed 実測）
> 関連: `docs/実装プラン.md`（各マイルストーン詳細）／`docs/企画書.md`（設計思想）／`docs/大会設計.md`

## 0. 大原則：ハードコーディングせず、マスタで運用管理する

- **コンテンツ・設定・パラメータは、原則コードに焼き込まず DB マスタ（テーブル）で持つ。** 運用（ライブ ops）がコード変更・デプロイなしに「何を・いくら・いつ・どんな値で」を制御できる状態を正とする。
- **正本の棲み分け**（二重管理＝ドリフトを避ける）：
  - **engine（TypeScript）= 「どう振る舞うか」の正本**：計算式・戦闘ロジック（`battle()` / `dive()` / 成長式）。
  - **DB マスタ = 「何を・いくら・いつ」の正本**：コンテンツと運用値（商品・ダンジョン・敵・価格・期間）。
- サーバー権威は崩さない：マスタはクライアント非公開 or 読み取り専用、書き込みは service_role / psql（＝運用）。プレイヤーに影響する判定（購入・報酬）は Edge Function がマスタを読んで行う。
- マイグレーションは **`supabase migration up` で前進**（`db reset` は遊んだデータを消すので禁止）。

> ⚠️ 現状まだ engine にハードコードされた運用値がある（§6）。原則に照らして「マスタへ移すべき」ものは §6 を見て指示してください。

---

## 1. 全テーブル一覧（public スキーマ・15テーブル）

| 区分 | テーブル | 役割 | クライアント read |
|---|---|---|---|
| **プレイヤーデータ**（本人所有） | `players` | プレイヤー（資源 gold・Auth 連携） | 本人のみ |
| | `characters` | キャラ（ビルド＝ステ/ライン/装備・成長・体力/派遣状態） | 本人のみ |
| | `player_equipment` | 所持装備（型の所持有無） | 本人のみ |
| | `player_items` | 所持消耗品（数量あり） | 本人のみ |
| | `dispatches` | 派遣履歴（DiveResult 保存） | 本人のみ |
| **コンテンツ／設定マスタ**（運用が管理） | `shop_listings` | ショップ販売リスト（何を・いくら・いつ売るか） | 非公開（RPC 経由） |
| | `dungeons` | 派遣ダンジョン（ドロップ表・遭遇表） | 全員 |
| | `enemy_catalog` | 敵（ステ・呪文・装備を完全DB管理） | 全員 |
| | `equipment_catalog` | 装備の登録簿（id/slot/name/kind/売却価格） | 全員 |
| | `item_catalog` | 消耗品の登録簿（id/name/効果/売却価格） | 全員 |
| | `divisions` | 大会ディビジョン（階層・名前） | 全員 |
| **大会運用データ**（バッチ生成物） | `tournaments` | 大会（フェーズ/シード/優勝者/昇降格） | 全員 |
| | `matches` | 試合結果＋eventLog | 全員 |
| | `standings` | 順位表 | 全員 |
| | `tournament_entrants` | 出場者スナップショット（ビルド/名前） | 全員 |

**外部キー関係（主要）**
```
players.id ─────────────► auth.users.id            （匿名Auth連携）
characters.player_id ───► players.id
player_equipment ──► players.id / equipment_catalog.id
player_items ─────► players.id / item_catalog.id
dispatches ───────► players.id / characters.id / dungeons.id
shop_listings ────► equipment_catalog.id / item_catalog.id
tournaments ──────► divisions.id / characters.id(champion)
matches ──────────► tournaments.id / characters.id(a,b)
standings ────────► tournaments.id / characters.id
tournament_entrants ► tournaments.id / characters.id
（dungeons.encounter_table[].enemy_id は enemy_catalog.id を JSONB で参照＝論理FK）
```

> 凡例：列表の型は PostgreSQL 実型。「本人のみ」= RLS で `auth.uid()` 一致行のみ。「全員」= 共有コンテンツ（read 誰でも / write は service_role）。

---

## 2. プレイヤーデータ

### 2.1 `players`（プレイヤー）
Auth（匿名→昇格）に連なるアカウント。`id` は `auth.users.id` を FK 参照。新規ユーザー作成トリガ `handle_new_user` で自動生成。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK →auth.users | プレイヤーID＝認証ユーザーID |
| `display_name` | text NOT NULL ='Player' | 表示名 |
| `is_anonymous` | bool NOT NULL =true | 匿名か（昇格で false・トリガ同期） |
| `gold` | bigint NOT NULL =0 | 所持コイン（報酬で増・ショップ/リスペックで減） |
| `created_at` / `updated_at` | timestamptz | 作成/更新（`set_updated_at` トリガ） |

- **RLS**：本人のみ select/update。挿入はトリガ（service_role）。

### 2.2 `characters`（キャラ＝ビルド＋成長＋体力＋派遣状態）
1ユーザー1キャラ（MVP）。ビルドは JSONB（engine `CharacterBuild` 契約とキー一致）、成長/時刻は列＝ハイブリッド保存。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK | |
| `player_id` | uuid NOT NULL →players | 所有者 |
| `name` | text NOT NULL | キャラ名 |
| `level` | int NOT NULL =1 | レベル（xp から materialize） |
| `xp` | bigint NOT NULL =0 | 累計XP（→level の正本は engine `gainXp`） |
| `stats` | jsonb NOT NULL | 基本5ステ `{vit,mag,pow,spd,men}` |
| `spell_lines` | jsonb =0×4 | 魔法ライン `{fire,cure,sleep,strength}` |
| `equipment` | jsonb =null×3 | 装備 `{weapon,armor,shield}`（equipment_catalog id） |
| `current_hp` | int NULL | 現在HP（null=満タン。maxHP は engine 派生＝DB非保持） |
| `hp_updated_at` | timestamptz | HP自然回復の起点クロック |
| `current_mp` | int NULL | 現在MP（null=満タン・HPと同格の管理資源） |
| `mp_updated_at` | timestamptz | MP自然回復の起点（HPと独立） |
| `dispatch_ends_at` | timestamptz NULL | 派遣帰還予定（null=未派遣＝留守判定） |
| `dispatch_pending` | jsonb NULL | 派遣中に退避した確定用データ（帰還で反映） |
| `created_at` / `updated_at` | timestamptz | |

- **RLS**：本人のみ select/insert/update/delete。
- ⚠️ 報酬付与（xp/gold/hp）はサーバー権威（`run-dispatch`）。ステ振り/リスペックは RLS 内クライアント権威。

### 2.3 `player_equipment`（所持装備）
装備は「型」＝所持有無のみ（数量なし）。ドロップ／購入で1行増える。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK | |
| `player_id` | uuid NOT NULL →players | |
| `equipment_id` | text NOT NULL →equipment_catalog | 所持している型 |
| `acquired_at` | timestamptz | 入手日時 |
| — | UNIQUE(player_id, equipment_id) | 重複所持しない |

- **RLS**：本人 select/insert。⚠️ **付け替え（characters.equipment 更新）UI は未実装**＝買っても倉庫止まり（既知の穴）。

### 2.4 `player_items`（所持消耗品）
消耗品は数量を持つ（装備との違い）。入手/消費はサーバー権威（Edge）。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK | |
| `player_id` | uuid NOT NULL →players | |
| `item_id` | text NOT NULL →item_catalog | |
| `quantity` | int NOT NULL =0 (>=0) | 個数（0で行削除運用） |
| `acquired_at` | timestamptz | |
| — | UNIQUE(player_id, item_id) | 1種別=1行 |

- **RLS**：本人 select のみ（入手/消費の write は service_role）。

### 2.5 `dispatches`（派遣履歴）
1回の派遣＝1行。DiveResult 全体を `result` に保存（再現・監査用）。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK | |
| `player_id` / `character_id` / `dungeon_id` | uuid NOT NULL →各 | 誰が/どのキャラで/どこへ |
| `minutes` | int NOT NULL | 潜航指定時間 |
| `seed` | bigint NOT NULL | 決定論シード（再現可） |
| `start_hp` | int NOT NULL | 出発時HP |
| `end_reason` | text NOT NULL | `'time'`（時間切れ）/`'ko'`（力尽き強制帰還） |
| `xp_gained` / `gold_gained` | bigint =0 | 獲得 |
| `hp_remaining` | int NOT NULL | 帰還時HP |
| `result` | jsonb NOT NULL | DiveResult 全体（戦闘明細・ドロップ等） |
| `created_at` | timestamptz | |

- **RLS**：本人のみ select。

---

## 3. コンテンツ／設定マスタ（運用が管理）

### 3.1 `shop_listings`（ショップ販売リスト）★フルにマスタ管理
「何を・いくらで・いつ売るか」の**正本**。行の追加/編集だけで販売制御（期間限定・セール価格対応）。migration 14。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK | 販売行ID（購入は buy にこれを渡す） |
| `product_type` | text NOT NULL | 商品種類 `'equipment'`/`'item'` |
| `equipment_id` | text NULL →equipment_catalog | 装備の付与対象 |
| `item_id` | text NULL →item_catalog | 消耗品の付与対象 |
| `name` | text NOT NULL | 商品名（表示・セール名も可） |
| `description` | text NULL | 商品説明 |
| `price` | int NOT NULL (>0) | 必要コイン数（セールで安くも可） |
| `starts_at` | timestamptz NULL | 販売開始（null=開始制限なし） |
| `ends_at` | timestamptz NULL | 販売終了（null=無期限） |
| `active` | bool NOT NULL =true | 手動オン/オフ（即停止） |
| `sort_order` | int NOT NULL =100 | 表示順（小さいほど上） |
| `created_at` | timestamptz | |
| — | CHECK | 種類と埋める id の対応強制／`starts_at<ends_at` |

- **アクセス**：本体は RLS で**クライアント非公開**（将来の限定商品を覗かせない）。write は service_role/psql。
- **「今売っているもの」**＝関数 `available_shop_listings()`（`now()` 判定・security definer）が有効行だけ返す。
- **購入検証**：Edge `run-dispatch: buy` が listingId で読み、期間内かを検証→gold 減算→付与。
- **seed（14品・常時販売）**：武器 短剣180/鉄の剣200/樫の杖220/戦斧300、防具 革鎧150/ローブ150/鉄鎧300、盾 木100/鉄200、消耗 HP薬小30/MP薬小30/HP薬大150/MP薬大150/エリクサー400。

```sql
-- 期間限定セール例
insert into shop_listings (product_type, equipment_id, name, description, price, starts_at, ends_at)
values ('equipment','axe_battle','【夏セール】戦斧','夏だけお得', 250, '2026-08-01','2026-08-08');
```

### 3.2 `dungeons`（派遣ダンジョン）★フルにマスタ管理
派遣先。ドロップ表・遭遇表を JSONB で持つ（engine は抽選するだけ）。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text NOT NULL | 安定キー（`novice_field`） |
| `name` | text NOT NULL | 表示名 |
| `type` | text NOT NULL | 種別（`xp` 等） |
| `difficulty` | int NOT NULL =1 | 難度（報酬倍率） |
| `recommended_dive_minutes` | int NOT NULL =30 | 推奨潜航時間 |
| `drop_table` | jsonb =`[]` | `[{kind:'equipment'|'item', id, weight}]` |
| `encounter_table` | jsonb =`[]` | `[{enemy_id, weight}]`（enemy_catalog 参照） |
| `created_at` | timestamptz | |

- **アクセス**：全員 select / write service_role。
- **seed**：`初心者の草原`1件のみ。drop=短剣/革鎧(w5)・HP薬小/MP薬小(w4)。遭遇=slime6/goblin4/bat3/wizard2/ogre1。
- ⚠️ ダンジョンが1件だけ＝多様化はこの表を増やすだけ。

### 3.3 `enemy_catalog`（敵）★フルにマスタ管理
敵ステ・呪文・装備を DB が持つ（engine は敵ステ非保持＝完全DB管理）。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | text PK | `slime` 等 |
| `name` | text NOT NULL | 表示名 |
| `level` | int NOT NULL =1 | レベル |
| `stats` | jsonb NOT NULL | `{vit,mag,pow,spd,men}` |
| `spell_lines` | jsonb | `{fire,cure,sleep,strength}` |
| `equipment` | jsonb | `{weapon,armor,shield}` |

- **アクセス**：全員 select / write service_role。**seed 6体**：スライム/ゴブリン/コウモリ/魔法使い/石像/オーガ（Lv1〜6）。

### 3.4 `equipment_catalog`（装備の登録簿）△一部マスタ
装備の登録簿（FK 先・表示名・売却価格）。⚠️ **性能（powMult 等）の正本は engine**（§6-①）。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | text PK | `sword_iron` 等 |
| `slot` | text NOT NULL | `weapon`/`armor`/`shield` |
| `name` | text NOT NULL | 表示名 |
| `kind` | text NULL | `physical`/`magic`（weapon のみ） |
| `sell_price` | int NULL (>0) | 売却価格（売る時に得るコイン・null=売却不可） |

- 全員 select / write service_role。seed 9件。powMult/physDef/spdPenalty は DB に無し。
- **売却価格の正本＝この `sell_price`**（買値 shop_listings.price とは独立＝ショップ非掲載品でも売れる）。sell（Edge）が読んで gold 加算。seed 仮値（標準買値の約50%・migration 15）。

### 3.5 `item_catalog`（消耗品の登録簿）△一部マスタ
登録簿（表示名・効果・売却価格）。⚠️ **回復量の正本は engine `ITEMS`**（DB effect_* は表示ミラー＝§6-②）。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | text PK | `potion_hp_small` 等 |
| `name` | text NOT NULL | 表示名 |
| `effect_kind` | text NOT NULL | `hp`/`mp`/`both` |
| `effect_pct` | numeric NOT NULL | 回復割合（0.10〜1.00） |
| `sell_price` | int NULL (>0) | 売却価格（売る時に得るコイン・null=売却不可） |

- 全員 select / write service_role。seed 5件。

### 3.6 `divisions`（大会ディビジョン）○小さなマスタ
大会の階層（J1/J2 式・企画書5.2）。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK | |
| `tier` | int NOT NULL | 階層（1=最上位） |
| `name` | text NOT NULL | 表示名 |

- 全員 select / write service_role。seed 2件（1=マスター/2=チャレンジャー）。

---

## 4. 大会運用データ（バッチ生成物）

> 静的マスタではなく、大会バッチ（`run-tournament`）が生成・更新する運用データ。現在いずれも rows=0（未開催）。

### 4.1 `tournaments`（大会）
| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK | |
| `division_id` | uuid NULL →divisions | 所属ディビジョン |
| `name` | text NOT NULL | 大会名 |
| `status` | text =`scheduled` | 状態 |
| `season` | int NULL | シーズン |
| `scheduled_at` / `finished_at` | timestamptz NULL | 予定/終了 |
| `phase` | text =`league` | `league`（予選）/`bracket`（決勝） |
| `season_seed` | bigint NULL | 決定論シード（冪等の土台・deriveSeed） |
| `champion_id` | uuid NULL →characters | 優勝者 |
| `promotion` | jsonb NULL | 昇降格結果 `{promote,relegate,stay}` |
| `created_at` | timestamptz | |

### 4.2 `matches`（試合）
| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK | |
| `tournament_id` | uuid NULL →tournaments | null=練習試合/即時オート（M4） |
| `phase` | text =`league` | 予選/決勝 |
| `round` | int NULL | ラウンド（日次tick 単位） |
| `character_a` / `character_b` | uuid NULL →characters | 対戦者（b=null はダミー戦） |
| `seed` | bigint NOT NULL | 決定論シード |
| `winner` | text NULL | `'A'`/`'B'` |
| `turns` | int NULL | 行動数（派遣の時間換算に利用） |
| `event_log` | jsonb NULL | 再生の正本（eventLog 12種） |
| `status` | text =`pending` | `pending`/`done`（冪等） |
| `processed_at` | timestamptz NULL | |
| `created_at` | timestamptz | |

### 4.3 `standings`（順位表）
| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK | |
| `tournament_id` | uuid NOT NULL →tournaments | |
| `character_id` | uuid NOT NULL →characters | |
| `wins`/`losses`/`draws` | int =0 | 星取り |
| `points` | int =0 | 勝点（done 試合からフル再計算＝冪等） |
| `rank` | int NULL | 順位 |

### 4.4 `tournament_entrants`（出場者スナップショット）
シーズン途中のリスペックが過去対戦を遡らないよう、エントリー時点のビルド/名前を固定（公平・決定論）。

| 列 | 型 | 意味 |
|---|---|---|
| `id` | uuid PK | |
| `tournament_id` | uuid NOT NULL →tournaments | |
| `character_id` | uuid NOT NULL →characters | |
| `seed_order` | int NOT NULL | 組み合わせ用の並び |
| `build` | jsonb NOT NULL | エントリー時ビルド（CharacterBuild） |
| `name` | text NULL | 観戦者向け名前（RLS 回避の公開スナップショット） |
| `created_at` | timestamptz | |

---

## 5. マスタ／データを読む口

| 用途 | 口 | 備考 |
|---|---|---|
| 販売中の商品 | RPC `available_shop_listings()` | now() 判定・security definer |
| 購入の価格/期間検証 | Edge `run-dispatch: buy` が `shop_listings` を service_role 読み | 権威 |
| 売却の価格照合 | Edge `run-dispatch: sell` が `catalog.sell_price` を service_role 読み | 権威（装備中/売却不可は 409） |
| 売れる所持品一覧 | `player_equipment`/`player_items` を catalog 埋め込みで本人 select | sell_price 付き |
| ★デバッグ コイン付与 | Edge `run-dispatch: debug_grant_gold` | env `DEBUG_TOOLS=true` 時のみ。本番は 403（後述） |

**デバッグ機能の安全ガード（本番で使えないように）**：`debug_*` アクションは env `DEBUG_TOOLS=true` のときだけ動く（未設定なら 403）。ローカルは `supabase/functions/.env`（`.gitignore` 済＝コミットも本番デプロイもされない）に `DEBUG_TOOLS=true` を置き、`supabase functions serve` が自動ロードする。本番は secrets に `DEBUG_TOOLS` を入れない＝機能が存在しない。クライアントも `kDebugMode`（リリースで false）でUIを出さない＝二重ガード。
| 派遣の敵/ドロップ抽選 | Edge `run-dispatch` が `dungeons`+`enemy_catalog` 読み | 権威 |
| ダンジョン/装備名/消耗品名 | `dungeons`/`equipment_catalog`/`item_catalog` を全員 select | 表示 |
| 観戦（順位/カード/再生） | `tournaments`/`standings`/`matches`/`tournament_entrants` 全員 select | 表示 |

**DB 関数**：`available_shop_listings`（販売中一覧）／`handle_new_user`・`handle_user_upgrade`（Auth トリガ）／`set_updated_at`（updated_at 自動更新）。

---

## 6. まだ engine にハードコードされている運用値（マスタ化の候補）

原則（§0）に照らすと以下は「運用が触りたくなり得る値」だが**現状 engine 定数**（`engine/src/formulas.ts`）。マスタへ寄せるか要判断。

1. **装備の性能**（`WEAPONS/ARMORS/SHIELDS`）：`powMult`・`physDef`・`spdPenalty`。→ `equipment_catalog` に性能列を足せば運用調整可（売却価格 `sell_price` は既に catalog へ移済み＝同じ要領で性能も移せる）。
2. **消耗品の効果**（`ITEMS`）：`effect_kind`/`effect_pct`。DB `item_catalog` に同列があるのに**engine が正本**＝二重。一本化すべき。
3. **派遣の報酬・回復レート**（`CONFIG.dive`）：`xpPerWinBase=10`・`goldPerWinBase=5`・`dropChancePerWin=0.15`・`regenPctPerMinute=0.01`・戦闘時間換算。→ live-ops で最も触る。ダンジョン別にしたいなら `dungeons` 列 or 専用マスタ。
4. **成長式**（`GROWTH`）：`baseXp=100`・`curveExp=1.5`・`basePool=40`・`pointsPerLevel=5`・`respecBase=50`・`respecPerLevel=20`。
5. **大会フォーマット**（`TOURNAMENT`）：`pointsWin/Draw/Loss`・`bracketSize=4`・`promote/relegateCount=2`。→ `divisions` 拡張 or 大会マスタ候補。
6. **戦闘定数**（`CONFIG` 物理/魔法/CTB/sleep）・**呪文MPコスト**（`CONFIG.mpCost`）・**呪文Tier刻み**（`spellTier`=10刻み）。→ 「どう振る舞うか」なので engine 正本が自然だが、バランス値として運用が触るなら別。

> ①②は「登録簿マスタがあるのに性能/効果だけ engine」という中途半端さ＝真っ先の整理候補。

---

## 7. メンテナンスの約束

- スキーマ変更は **migration を1本足して `supabase migration up`**（`db reset` 禁止）。
- **正本を二重に持たない**：値をマスタへ移したら engine 定数は消す（②のような二重を残さない）。
- **このドキュメントはテーブル/列/seed を変えたら追従更新**する。
