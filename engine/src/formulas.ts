/**
 * M0: 戦闘定数 config（仮値）＋派生値関数＋装備カタログ（仮 content）。
 *
 * ★ここの数値はすべて「仮」。M2 バランスハーネスで実測 → 調整し、
 *   launch 後は 9章 live-ops で毎シーズン均す（企画書4.1.2 / 実装プラン M2・6章）。
 * ★方針は確定・数値だけ未確定:
 *   - 小さな乱数を多く（ダメージ ±12.5%）／クリティカルは中倍率（1.5倍）
 *   - 素早さは逓減（2倍速≠2倍手数）／魔法は回避不可／1プールで速度型は紙
 *   - sleep 成功率は 魔力≈精神 周辺で急・floor/ceiling（0/100%なし）
 */

import type { ArmorDef, ShieldDef, Stats, WeaponDef } from './schema.ts';

export const CONFIG = {
  // ── 派生値（企画書3.5.1：HP/MP は体力/魔力から倍率で算出。基本5ステは同スケール維持）
  hpPerVit: 10, // 最大HP = 体力 × 10
  mpPerMag: 5, // 最大MP = 魔力 × 5

  // ── CTB 持ち点式ターン順（企画書4.1.1）
  ctb: {
    threshold: 100, // 持ち点がこれを超えたら行動 → 消費
    gainBase: 20, // 持ち点/tick の基準
    // 逓減: gain = gainBase × 素早さ^exp。exp を下げるほど手数差が圧縮される。
    // 0.35 で「速度13倍 → 手数≈1.9倍」＝速いが万能化しない（M2で 0.5 から調整）
    speedExponent: 0.35,
  },

  // ── 物理（力×武器 − 鎧、±乱数、素早さで回避／企画書4.1）
  physical: {
    variancePct: 0.18, // ±18%（小さな乱数を多く＝良い運。相性を軟らかく・M2で 0.125 から調整）
    critChance: 0.08,
    critMult: 1.5, // 中倍率（一撃で試合を決めない）
    evadeMaxPct: 0.25, // 回避率の上限（控えめ。運ゲー化を防ぐ）
    evadePerSpdDiff: 0.02, // 素早さ差1につき回避+2%（上限まで）
    minDamage: 1,
  },

  // ── 魔法ダメージ Fire（基本 + 術者魔力 − 受け手魔力、下限あり、%最大HP成分／企画書3.5.1・4.2）
  magic: {
    fireBasePerTier: 18, // Tier × これ が基本値
    magAtkScaling: 1.0, // 術者魔力の寄与倍率
    magDefScaling: 1.0, // 受け手魔力の軽減倍率（魔力 vs 魔力）
    floorPct: 0.15, // 下限 = 基本値の 15%（魔力で軽減されても最低これは通る）
    maxHpPctPerTier: 0.0, // %最大HP成分（仮=0。体力全振り対策で M2 調整時に上げる）
    variancePct: 0.18,
  },

  // ── 回復 Cure（企画書4.2：ソロで uptime 延長＝バースト対サステインのビルド分化）
  cure: {
    healBasePerTier: 28,
    magScaling: 0.5, // 魔力も回復量に寄与
  },

  // ── バフ Strength（力アップ。硬い敵の突破に有効／企画書4.2）
  strength: {
    powBonusPerTier: 3,
    duration: 3, // 持続（行動回数。CTB 軽量版＝時間でなく回数で数える）
  },

  // ── 状態異常 Sleep（アップセット装置。精神で自己修正メタ／企画書4.2）
  sleep: {
    // 成功率 = clamp(0.5 + steepness × (魔力攻 − 精神防), floor, ceiling)
    // → 魔力≈精神で 50% 付近を急峻に通過（魔力<精神=ほぼ効かない / 魔力>精神=高確率）
    steepness: 0.06,
    floor: 0.05, // 0% にしない（underdog の希望）
    ceiling: 0.95, // 100% にしない（perma-lock 防止）
    baseDuration: 2, // 持続（行動回数）
    wakeOnHit: true, // 被弾で起きる
    resistGrowthPerApply: 0.5, // 再睡眠に逓減（同対象への再付与で duration 減衰）
  },

  // ── MP 消費（仮／企画書4.1：魔法は MP 切れで弱い物理に戻る）
  mpCost: { fire: 4, cure: 5, sleep: 6, strength: 5 } as Record<string, number>,

  // ── 自動判断 AI の閾値（企画書4.2：HP50%未満→Cure／開幕→Strength／強敵→Sleep／通常→Fire）
  ai: {
    healHpThreshold: 0.5, // HP がこの割合未満で Cure を優先
    openingBuffTurns: 1, // 開幕この行動回数はバフを検討
  },

  // ── 膠着防止（PvP・企画書4.2）
  limits: { maxTurns: 200 },

  // ── 派遣ダンジョン（M5・企画書3.3.1）※すべて仮値。報酬レート/敵強度は M5 バランスで実測調整
  dive: {
    minutesPerBattle: 3, // 1戦の所要（分）＝「指定時間まで連戦」の刻み
    // 報酬（勝利ごと・difficulty 倍。時間投資に比例＝企画書3.3「日次上限なし」）
    xpPerWinBase: 10,
    goldPerWinBase: 5,
    dropChancePerWin: 0.15, // 勝利ごとのドロップ確率（ピティ=天井は M5.3 の永続カウンタ側）
    // 敵生成（difficulty で線形スケール・MVP は物理グラント1型。敵の多様化は live-ops）
    enemyVitBase: 8,
    enemyVitPerDiff: 3,
    enemyPowBase: 6,
    enemyPowPerDiff: 2,
    enemySpdBase: 6,
    enemySpdPerDiff: 1,
  },
} as const;

// ────────────────────────────────────────────────────────────
// M5.2 成長（レベル/XP曲線・配分プール・リスペック）※すべて仮値・企画書3.4/3.5
//   ソフトキャップ = 上限なし・伸び鈍化のみ（青天井の桁暴走だけ抑える／公平化ではない）。
//   仕組み: レベルは flat な配分ポイントを配るが、1レベルに要る XP は superlinear に増える
//           → 時間比例で「上位ほど1時間あたりの伸びが寝る」手触り（3.4 の狙い②）。
// ────────────────────────────────────────────────────────────
export const GROWTH = {
  baseXp: 100, // Lv1→2 に要る XP
  curveExp: 1.5, // XP曲線の指数（>1 で上位ほど1レベルが重い＝伸び鈍化）
  statFloor: 1, // 各基本ステの下限（1プールの原資はここから上に積む）
  basePool: 10, // Lv1 の配分ポイント
  pointsPerLevel: 5, // レベルアップごとに増える配分ポイント
  respecBase: 50, // リスペック基本費用（ゴールド・企画書3.5 ゴールドシンク）
  respecPerLevel: 20, // レベル比例のシンク
  maxLevelGuard: 9999, // 逆算ループの安全弁（青天井でも無限ループにしない）
} as const;

// ────────────────────────────────────────────────────────────
// 派生値関数（企画書3.5.1）
// ────────────────────────────────────────────────────────────
export function maxHP(vit: number): number {
  return vit * CONFIG.hpPerVit;
}

export function maxMP(mag: number): number {
  return mag * CONFIG.mpPerMag;
}

/** 修行値 → Tier（威力は連続、節目で上位 Tier 習得／企画書3.5.2） */
export function spellTier(lineValue: number): number {
  return Math.floor(lineValue / 10);
}

/** sleep 成功率（魔力攻 vs 精神防・floor/ceiling・0/100%なし／企画書4.2） */
export function sleepChance(atkMag: number, defMen: number): number {
  const raw = 0.5 + CONFIG.sleep.steepness * (atkMag - defMen);
  return Math.min(CONFIG.sleep.ceiling, Math.max(CONFIG.sleep.floor, raw));
}

/** ステから派生する派生値のまとめ（M1 で使う想定・便利関数） */
export function derive(stats: Stats): { maxHP: number; maxMP: number } {
  return { maxHP: maxHP(stats.vit), maxMP: maxMP(stats.mag) };
}

// ────────────────────────────────────────────────────────────
// 装備カタログ（仮 content・企画書3.6「+強い」でなく「型」）
// 実データはここ / 型は schema.ts。DB/Flutter は id を持ち、engine が解決する。
// ────────────────────────────────────────────────────────────
export const WEAPONS: Record<string, WeaponDef> = {
  sword_iron: { id: 'sword_iron', name: '鉄の剣', kind: 'physical', powMult: 3.0, spdPenalty: 0 },
  axe_battle: { id: 'axe_battle', name: '戦斧', kind: 'physical', powMult: 4.2, spdPenalty: 2 },
  dagger: { id: 'dagger', name: '短剣', kind: 'physical', powMult: 2.2, spdPenalty: -1 },
  staff_oak: { id: 'staff_oak', name: '樫の杖', kind: 'magic', powMult: 1.0, spdPenalty: 0 },
};

export const ARMORS: Record<string, ArmorDef> = {
  mail_leather: { id: 'mail_leather', name: '革鎧', physDef: 6, spdPenalty: 0 },
  mail_iron: { id: 'mail_iron', name: '鉄鎧', physDef: 14, spdPenalty: 2 },
  robe: { id: 'robe', name: 'ローブ', physDef: 2, spdPenalty: -1 }, // 魔法型向け（将来: 魔法耐性）
};

export const SHIELDS: Record<string, ShieldDef> = {
  shield_wood: { id: 'shield_wood', name: '木の盾', physDef: 4 },
  shield_iron: { id: 'shield_iron', name: '鉄の盾', physDef: 8 },
};
