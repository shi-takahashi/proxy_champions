// 継ぎ目②: engine/src/schema.ts の CharacterBuild を Dart に手書きミラー（正本は TS 側）。
// 線を越えるのは JSON のみ。キーは engine の camelCase 契約に一致させる。

class Stats {
  final int vit; // 体力 → 最大HP
  final int mag; // 魔力 → 最大MP・魔法威力・軽減・状態異常成功率
  final int pow; // 力   → 物理攻撃
  final int spd; // 素早さ → CTB手数・物理回避
  final int men; // 精神 → 状態異常耐性

  const Stats({
    required this.vit,
    required this.mag,
    required this.pow,
    required this.spd,
    required this.men,
  });

  Map<String, dynamic> toJson() => {
        'vit': vit,
        'mag': mag,
        'pow': pow,
        'spd': spd,
        'men': men,
      };

  factory Stats.fromJson(Map<String, dynamic> j) => Stats(
        vit: j['vit'] as int,
        mag: j['mag'] as int,
        pow: j['pow'] as int,
        spd: j['spd'] as int,
        men: j['men'] as int,
      );
}

class SpellLines {
  final int fire;
  final int cure;
  final int sleep;
  final int strength;

  const SpellLines({
    this.fire = 0,
    this.cure = 0,
    this.sleep = 0,
    this.strength = 0,
  });

  Map<String, dynamic> toJson() => {
        'fire': fire,
        'cure': cure,
        'sleep': sleep,
        'strength': strength,
      };

  factory SpellLines.fromJson(Map<String, dynamic> j) => SpellLines(
        fire: j['fire'] as int,
        cure: j['cure'] as int,
        sleep: j['sleep'] as int,
        strength: j['strength'] as int,
      );
}

class EquipmentLoadout {
  final String? weapon; // WeaponDef.id or null（素手）
  final String? armor;
  final String? shield;

  const EquipmentLoadout({this.weapon, this.armor, this.shield});

  Map<String, dynamic> toJson() => {
        'weapon': weapon,
        'armor': armor,
        'shield': shield,
      };

  factory EquipmentLoadout.fromJson(Map<String, dynamic> j) => EquipmentLoadout(
        weapon: j['weapon'] as String?,
        armor: j['armor'] as String?,
        shield: j['shield'] as String?,
      );
}

/// キャラのビルド（= DB 保存形 / battle() 入力の正本）。
class CharacterBuild {
  final int level;
  final Stats stats;
  final SpellLines spellLines;
  final EquipmentLoadout equipment;

  const CharacterBuild({
    required this.level,
    required this.stats,
    required this.spellLines,
    required this.equipment,
  });

  /// characters テーブルの行（列 + JSONB）へ。id/player_id は呼び出し側で付与。
  Map<String, dynamic> toRow(String name) => {
        'name': name,
        'level': level,
        'stats': stats.toJson(),
        'spell_lines': spellLines.toJson(),
        'equipment': equipment.toJson(),
      };
}
