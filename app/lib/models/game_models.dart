// M5.4: 育成ループ UI が扱うドメインモデル（DB 行 / run-dispatch 応答のデシリアライズ）。
// characters/players/dungeons の列は snake_case、build 本体(JSONB)は engine 契約の camelCase。

import 'character_build.dart';
import 'game_math.dart';

/// 永続キャラ（= characters 行 + 成長/体力ループ）。1ユーザー1キャラ（企画書）。
class Character {
  final String id;
  final String name;
  final int level;
  final int xp;
  final int? currentHp; // null = 満タン（maxHp は engine 派生）
  final int? currentMp; // null = 満タン（maxMp は engine 派生・HP と同じ管理資源）
  final CharacterBuild build;

  const Character({
    required this.id,
    required this.name,
    required this.level,
    required this.xp,
    required this.currentHp,
    required this.currentMp,
    required this.build,
  });

  int get maxHpValue => maxHp(build.stats.vit);
  int get hpValue => currentHp ?? maxHpValue;
  int get maxMpValue => maxMp(build.stats.mag);
  int get mpValue => currentMp ?? maxMpValue;
  XpProgress get xpProgress => progressForXp(xp);

  factory Character.fromRow(Map<String, dynamic> r) => Character(
        id: r['id'] as String,
        name: r['name'] as String,
        level: r['level'] as int,
        xp: (r['xp'] as num).toInt(),
        currentHp: r['current_hp'] as int?,
        currentMp: r['current_mp'] as int?,
        build: CharacterBuild(
          level: r['level'] as int,
          stats: Stats.fromJson(r['stats'] as Map<String, dynamic>),
          spellLines: SpellLines.fromJson(r['spell_lines'] as Map<String, dynamic>),
          equipment: EquipmentLoadout.fromJson(r['equipment'] as Map<String, dynamic>),
        ),
      );
}

/// run-dispatch(status) のキャラ状態スナップショット。
/// 実効HP（自然回復込み）・回復ETA・派遣中かどうかを、すべてサーバーが算出する。
class CharacterStatus {
  final int hp; // 実効HP（回復反映後／派遣中は出発時点で固定）
  final int maxHp;
  final int mp; // 実効MP（回復反映後／派遣中は出発時点で固定・HP と同じ管理資源）
  final int maxMp;
  final bool resting; // hp <= 0（派遣不可）
  final int minutesToFull; // HP 満タンまでの推定分（0=満タン）
  final int mpMinutesToFull; // MP 満タンまでの推定分（0=満タン）
  final int minutesToReady; // 派遣可能（HP 1以上）までの推定分（0=すでに可能）
  final bool dispatching; // 派遣中（留守）
  final bool canCollect; // 帰還予定時刻を過ぎ、受け取り可能
  final int minutesRemaining; // 帰還までの残り分（派遣中のみ）
  final String dungeonName; // 派遣先（派遣中のみ）

  const CharacterStatus({
    required this.hp,
    required this.maxHp,
    required this.mp,
    required this.maxMp,
    required this.resting,
    required this.minutesToFull,
    required this.mpMinutesToFull,
    required this.minutesToReady,
    required this.dispatching,
    required this.canCollect,
    required this.minutesRemaining,
    required this.dungeonName,
  });

  factory CharacterStatus.fromJson(Map<String, dynamic> j) => CharacterStatus(
        hp: (j['hp'] as num).toInt(),
        maxHp: (j['maxHp'] as num).toInt(),
        mp: (j['mp'] as num?)?.toInt() ?? 0,
        maxMp: (j['maxMp'] as num?)?.toInt() ?? 0,
        resting: j['resting'] as bool,
        minutesToFull: (j['minutesToFull'] as num).toInt(),
        mpMinutesToFull: (j['mpMinutesToFull'] as num?)?.toInt() ?? 0,
        minutesToReady: (j['minutesToReady'] as num).toInt(),
        dispatching: (j['dispatching'] as bool?) ?? false,
        canCollect: (j['canCollect'] as bool?) ?? false,
        minutesRemaining: (j['minutesRemaining'] as num?)?.toInt() ?? 0,
        dungeonName: (j['dungeonName'] as String?) ?? '',
      );
}

/// プレイヤー資源（= players 行）。
class PlayerState {
  final int gold;
  const PlayerState({required this.gold});

  factory PlayerState.fromRow(Map<String, dynamic> r) => PlayerState(
        gold: (r['gold'] as num).toInt(),
      );
}

/// 所持アイテム1種（= player_items 行 + 埋め込み item_catalog）。消耗品なので個数(quantity)を持つ。
class InventoryItem {
  final String id;
  final String name;
  final String effectKind; // 'hp' | 'mp' | 'both'
  final double effectPct; // 最大値に対する回復割合（0.10=10% / 1.0=全回復）
  final int quantity;

  const InventoryItem({
    required this.id,
    required this.name,
    required this.effectKind,
    required this.effectPct,
    required this.quantity,
  });

  factory InventoryItem.fromRow(Map<String, dynamic> r) {
    final cat = r['item_catalog'] as Map<String, dynamic>; // PostgREST 埋め込み
    return InventoryItem(
      id: cat['id'] as String,
      name: cat['name'] as String,
      effectKind: cat['effect_kind'] as String,
      effectPct: (cat['effect_pct'] as num).toDouble(),
      quantity: (r['quantity'] as num).toInt(),
    );
  }
}

/// ショップの販売行1件（= ショップマスタ shop_listings の「今売っている」行）。
/// available_shop_listings() 関数が now() で期間判定して返す＝表示もサーバー時刻が権威。
/// 商品名/説明/価格/期間はすべてマスタ側の管理項目（運用がテーブル編集で制御）。
class ShopListing {
  final String listingId; // shop_listings.id（buy はこれで指定）
  final String productType; // 'equipment' | 'item'（商品種類）
  final String? equipmentId; // 装備なら付与対象の型 id（所持判定に使う）
  final String? itemId; // 回復薬なら付与対象の item id
  final String name; // 商品名（表示）
  final String? description; // 商品説明
  final int price; // 必要コイン数
  final DateTime? endsAt; // 販売終了（null=無期限。限定表示に使う）
  final bool owned; // 装備で既に所持している型か（重複購入不可）

  const ShopListing({
    required this.listingId,
    required this.productType,
    required this.equipmentId,
    required this.itemId,
    required this.name,
    required this.description,
    required this.price,
    required this.endsAt,
    required this.owned,
  });

  bool get isEquipment => productType == 'equipment';
  bool get isLimited => endsAt != null; // 販売終了日あり＝期間限定

  factory ShopListing.fromRow(Map<String, dynamic> r, Set<String> ownedEquipmentIds) {
    final eqId = r['equipment_id'] as String?;
    return ShopListing(
      listingId: r['listing_id'] as String,
      productType: r['product_type'] as String,
      equipmentId: eqId,
      itemId: r['item_id'] as String?,
      name: r['name'] as String,
      description: r['description'] as String?,
      price: (r['price'] as num).toInt(),
      endsAt: r['ends_at'] == null ? null : DateTime.parse(r['ends_at'] as String).toLocal(),
      owned: eqId != null && ownedEquipmentIds.contains(eqId),
    );
  }
}

/// 売却できる所持品1件（= player_equipment / player_items ＋ カタログの sell_price）。
/// 売却価格の正本は catalog.sell_price（DB マスタ・null=売却不可）。装備は quantity=1。
class SellEntry {
  final String kind; // 'equipment' | 'item'
  final String id;
  final String name;
  final int? sellPrice; // null = 売却不可
  final int quantity; // 装備=1／消耗品=所持個数

  const SellEntry({
    required this.kind,
    required this.id,
    required this.name,
    required this.sellPrice,
    required this.quantity,
  });

  bool get isEquipment => kind == 'equipment';
  bool get sellable => sellPrice != null;

  /// player_equipment 行（equipment_catalog 埋め込み）から。
  factory SellEntry.equipment(Map<String, dynamic> r) {
    final cat = r['equipment_catalog'] as Map<String, dynamic>;
    return SellEntry(
      kind: 'equipment',
      id: cat['id'] as String,
      name: cat['name'] as String,
      sellPrice: (cat['sell_price'] as num?)?.toInt(),
      quantity: 1,
    );
  }

  /// player_items 行（item_catalog 埋め込み）から。
  factory SellEntry.item(Map<String, dynamic> r) {
    final cat = r['item_catalog'] as Map<String, dynamic>;
    return SellEntry(
      kind: 'item',
      id: cat['id'] as String,
      name: cat['name'] as String,
      sellPrice: (cat['sell_price'] as num?)?.toInt(),
      quantity: (r['quantity'] as num).toInt(),
    );
  }
}

/// 派遣先ダンジョン（= dungeons 行・共有コンテンツ）。
class Dungeon {
  final String id;
  final String slug;
  final String name;
  final String type;
  final int difficulty;
  final int recommendedDiveMinutes;

  const Dungeon({
    required this.id,
    required this.slug,
    required this.name,
    required this.type,
    required this.difficulty,
    required this.recommendedDiveMinutes,
  });

  factory Dungeon.fromRow(Map<String, dynamic> r) => Dungeon(
        id: r['id'] as String,
        slug: r['slug'] as String,
        name: r['name'] as String,
        type: r['type'] as String,
        difficulty: r['difficulty'] as int,
        recommendedDiveMinutes: r['recommended_dive_minutes'] as int,
      );
}

/// ドロップ1件（装備 or アイテム）。kind で入手先が分かる（表示名は stat_labels.dropName）。
class DropRef {
  final String kind; // 'equipment' | 'item'
  final String id;
  const DropRef({required this.kind, required this.id});

  factory DropRef.fromJson(Map<String, dynamic> j) =>
      DropRef(kind: j['kind'] as String, id: j['id'] as String);
}

/// run-dispatch(dispatch) の帰還サマリ。
class DispatchResult {
  final String dispatchId;
  final int battles;
  final String endReason; // 'time' | 'ko'
  final int xpGained;
  final int goldGained;
  final List<DropRef> drops; // 装備・アイテムのドロップ（タグ付き）
  final int level;
  final int leveledUp;
  final int hpRemaining;
  final int mpRemaining;
  final int startHp;

  const DispatchResult({
    required this.dispatchId,
    required this.battles,
    required this.endReason,
    required this.xpGained,
    required this.goldGained,
    required this.drops,
    required this.level,
    required this.leveledUp,
    required this.hpRemaining,
    required this.mpRemaining,
    required this.startHp,
  });

  bool get returnedByKo => endReason == 'ko';

  factory DispatchResult.fromJson(Map<String, dynamic> j) => DispatchResult(
        dispatchId: j['dispatchId'] as String,
        battles: j['battles'] as int,
        endReason: j['endReason'] as String,
        xpGained: (j['xpGained'] as num).toInt(),
        goldGained: (j['goldGained'] as num).toInt(),
        drops: (j['drops'] as List)
            .map((e) => DropRef.fromJson(e as Map<String, dynamic>))
            .toList(),
        level: j['level'] as int,
        leveledUp: j['leveledUp'] as int,
        hpRemaining: j['hpRemaining'] as int,
        mpRemaining: (j['mpRemaining'] as num?)?.toInt() ?? 0,
        startHp: j['startHp'] as int,
      );
}
