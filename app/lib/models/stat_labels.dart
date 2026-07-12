// ステータス／魔法ラインの日本語表示ラベルと「何に効くか」の説明。
// キャラメイク（create）とステ振り（allocate）で共通利用し、表記のブレを防ぐ。
// キーは engine の StatKey / lineKey（vit/mag/... , fire/cure/...）に対応。
// 略号（VIT 等）は使わず、意味の分かる日本語で示す。

/// 基本ステータス: key → (名前, 説明)
const Map<String, (String, String)> statInfo = {
  'vit': ('体力', '最大HPが増える'),
  'mag': ('魔力', '最大MP・魔法の威力・魔法への防御'),
  'pow': ('力', '物理攻撃の威力'),
  'spd': ('素早さ', '手数（行動の速さ）と物理回避'),
  'men': ('精神', '眠りなど状態異常への耐性'),
};

/// 魔法ライン: key → (名前, 説明)。10 ポイントごとに 1 段階強くなる。
const Map<String, (String, String)> lineInfo = {
  'fire': ('火の魔法', '敵にダメージを与える攻撃呪文'),
  'cure': ('回復の魔法', '自分のHPを回復する'),
  'sleep': ('眠りの魔法', '敵を眠らせて動きを止める'),
  'strength': ('力アップ', '自分の物理攻撃を強化する'),
};

/// 装備ID → 日本語名。DB の equipment_catalog.name（seed）のミラー。
/// ★装備を増やしたら DB seed（20260705000003_equipment.sql）とここを揃えること。
const Map<String, String> equipmentNames = {
  'sword_iron': '鉄の剣',
  'axe_battle': '戦斧',
  'dagger': '短剣',
  'staff_oak': '樫の杖',
  'mail_leather': '革鎧',
  'mail_iron': '鉄鎧',
  'robe': 'ローブ',
  'shield_wood': '木の盾',
  'shield_iron': '鉄の盾',
};

/// 装備ID → 日本語名（未知IDはそのまま返す）。
String equipmentName(String id) => equipmentNames[id] ?? id;

/// アイテムID → 日本語名。DB の item_catalog.name（seed）のミラー。
/// ★アイテムを増やしたら DB seed（items マイグレーション）と engine ITEMS とここを揃えること。
const Map<String, String> itemNames = {
  'potion_hp_small': 'HP回復薬（小）',
  'potion_hp_full': 'HP回復薬（大）',
  'potion_mp_small': 'MP回復薬（小）',
  'potion_mp_full': 'MP回復薬（大）',
  'elixir': 'エリクサー',
};

/// アイテムID → 日本語名（未知IDはそのまま返す）。
String itemName(String id) => itemNames[id] ?? id;

/// ドロップ（装備 or アイテム）の表示名。kind で名前解決先を切り替える。
String dropName(String kind, String id) =>
    kind == 'item' ? itemName(id) : equipmentName(id);

/// アイテム効果の説明文（例: 「HPを10%回復」「HP・MPを全回復」）。所持一覧・ボタンで使う。
String itemEffectText(String effectKind, double effectPct) {
  final target = switch (effectKind) {
    'hp' => 'HP',
    'mp' => 'MP',
    _ => 'HP・MP',
  };
  final amount = effectPct >= 1.0 ? '全回復' : '${(effectPct * 100).round()}%回復';
  return '$targetを$amount';
}
