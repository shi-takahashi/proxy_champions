// 継ぎ目②: engine の数値契約（formulas.CONFIG 派生値 / GROWTH / growth.ts）を Dart に手書きミラー。
// 正本は TS 側（engine/src/formulas.ts・growth.ts）。UI は HPバー/XPバー/ステ振り検証にこれを使う。
// ★数値を engine と一致させること（engine を変えたらここも更新）。線を越えるのは JSON のみ。

import 'dart:math';

/// 派生値（formulas.CONFIG）
const int hpPerVit = 10; // 最大HP = 体力 × 10
const int mpPerMag = 5; // 最大MP = 魔力 × 5

int maxHp(int vit) => vit * hpPerVit;
int maxMp(int mag) => mag * mpPerMag;

/// 成長定数（formulas.GROWTH）
const int growthBaseXp = 100;
const double growthCurveExp = 1.5;
const int statFloor = 1;
const int basePool = 40; // ★engine formulas.GROWTH.basePool と一致させること
const int pointsPerLevel = 5;
const int respecBase = 50;
const int respecPerLevel = 20;
const int maxLevelGuard = 9999;

const statKeys = ['vit', 'mag', 'pow', 'spd', 'men'];
const lineKeys = ['fire', 'cure', 'sleep', 'strength'];

/// level → level+1 に要る XP（superlinear・単調増加＝ソフトキャップ）
int xpToNext(int level) {
  final l = max(1, level);
  return (growthBaseXp * pow(l, growthCurveExp)).round();
}

/// Lv1 から `level` 到達に要る累計 XP（Lv1 = 0）
int totalXpForLevel(int level) {
  final target = max(1, level);
  var sum = 0;
  for (var l = 1; l < target; l++) {
    sum += xpToNext(l);
  }
  return sum;
}

class XpProgress {
  final int totalXp;
  final int level;
  final int intoLevel; // 現レベルに入ってからの XP（バー分子）
  final int toNext; // 次レベルまでに要る XP（バー分母）
  const XpProgress(this.totalXp, this.level, this.intoLevel, this.toNext);

  double get fraction => toNext == 0 ? 0 : intoLevel / toNext;
}

/// 累計 XP → レベルと進捗
XpProgress progressForXp(int totalXp) {
  final total = max(0, totalXp);
  var level = 1;
  var remaining = total;
  while (level < maxLevelGuard) {
    final need = xpToNext(level);
    if (remaining < need) break;
    remaining -= need;
    level += 1;
  }
  return XpProgress(total, level, remaining, xpToNext(level));
}

/// そのレベルで配れる総ポイント（flat 増加・未使用は貯められる）
int poolForLevel(int level) => basePool + (max(1, level) - 1) * pointsPerLevel;

/// 現在の配分が消費しているポイント（ステは下限より上ぶん＋ライン合計）
int spentPoints(Map<String, int> stats, Map<String, int> lines) {
  var spent = 0;
  for (final k in statKeys) {
    spent += max(0, (stats[k] ?? statFloor) - statFloor);
  }
  for (final k in lineKeys) {
    spent += max(0, lines[k] ?? 0);
  }
  return spent;
}

class AllocationCheck {
  final bool ok;
  final int spent;
  final int pool;
  final int unspent;
  final String? reason;
  const AllocationCheck(this.ok, this.spent, this.pool, this.unspent, [this.reason]);
}

/// 配分の妥当性検証（下限割れ・プール超過を弾く／上限＝青天井は無し）
AllocationCheck checkAllocation(int level, Map<String, int> stats, Map<String, int> lines) {
  final pool = poolForLevel(level);
  final spent = spentPoints(stats, lines);
  for (final k in statKeys) {
    if ((stats[k] ?? statFloor) < statFloor) {
      return AllocationCheck(false, spent, pool, pool - spent, '$k が下限($statFloor)未満');
    }
  }
  for (final k in lineKeys) {
    if ((lines[k] ?? 0) < 0) {
      return AllocationCheck(false, spent, pool, pool - spent, '魔法ライン $k が負値');
    }
  }
  if (spent > pool) {
    return AllocationCheck(false, spent, pool, pool - spent, '配分($spent) がプール($pool) を超過');
  }
  return AllocationCheck(true, spent, pool, pool - spent);
}

/// リスペック費用（ゴールド・レベル比例）
int respecCost(int level) => respecBase + respecPerLevel * max(1, level);
