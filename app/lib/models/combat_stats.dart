// 継ぎ目②(拡張): 戦闘の派生値「強さの目安」を engine から Dart に手書きミラー。
// 正本は engine/src/battle.ts の resolve()（ダメージ式）と formulas.ts（WEAPONS/ARMORS/SHIELDS・CONFIG.magic）。
// ★engine を変えたらここも一致させること（装備を増やしたら powMult/physDef も追加）。
// 相手なし・バフなしの静的な素の値＝プレイヤーが自分のビルドの強さを把握する目安。保存はしない（都度計算）。

import 'character_build.dart';

// ── 装備の物理パラメータ（engine WEAPONS/ARMORS/SHIELDS のミラー）
const double _unarmedMult = 1.0; // 素手（engine UNARMED_MULT）
const Map<String, double> _weaponPowMult = {
  'sword_iron': 3.0,
  'axe_battle': 4.2,
  'dagger': 2.2,
  'staff_oak': 1.0,
};
const Map<String, int> _armorPhysDef = {
  'mail_leather': 6,
  'mail_iron': 14,
  'robe': 2,
};
const Map<String, int> _shieldPhysDef = {
  'shield_wood': 4,
  'shield_iron': 8,
};

// ── 魔法(fire)関連（engine CONFIG.magic）
const int _fireBasePerTier = 18; // Tier × これ が基本値
const double _magAtkScaling = 1.0; // 術者魔力の寄与
const double _magDefScaling = 1.0; // 受け手魔力の軽減（魔力 vs 魔力）

int _spellTier(int lineValue) => lineValue ~/ 10; // engine spellTier

/// 強さの目安（相手なし・バフなしの素の値）。
class CombatStats {
  final int physAtk; // 物理攻撃 = 力 × 武器倍率
  final int physDef; // 物理防御 = 鎧 + 盾 の physDef（ステは物理防御に寄与しない）
  final int magAtk; // 魔法攻撃 = 火の段階×基本 + 魔力（火を覚えていなければ 0）
  final int magDef; // 魔法防御 = 魔力（魔力 vs 魔力の軽減）
  const CombatStats(this.physAtk, this.physDef, this.magAtk, this.magDef);
}

CombatStats combatStats(Stats s, SpellLines lines, EquipmentLoadout eq) {
  final wMult = eq.weapon == null ? _unarmedMult : (_weaponPowMult[eq.weapon] ?? _unarmedMult);
  final physAtk = (s.pow * wMult).round();
  final physDef = (eq.armor == null ? 0 : (_armorPhysDef[eq.armor] ?? 0)) +
      (eq.shield == null ? 0 : (_shieldPhysDef[eq.shield] ?? 0));
  final fireTier = _spellTier(lines.fire);
  final magAtk = fireTier >= 1 ? (fireTier * _fireBasePerTier + s.mag * _magAtkScaling).round() : 0;
  final magDef = (s.mag * _magDefScaling).round();
  return CombatStats(physAtk, physDef, magAtk, magDef);
}
