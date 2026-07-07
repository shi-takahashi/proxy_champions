/**
 * M5.2: 成長式（レベル/XP曲線・1プール配分・リスペック）— 純粋関数（企画書3.4 / 3.5）。
 *
 * 役割:
 *  - XP → レベル（ソフトキャップ曲線＝上限なし・伸び鈍化のみ／企画書3.4）
 *  - レベル → 配分ポイントのプール（基本5ステ＋4魔法ラインが同じ1プールを奪い合う／企画書3.5）
 *  - 配分の検証（下限・プール超過チェック）＝ステ振り／リスペック共通
 *  - リスペック費用（ゴールドシンク／企画書3.5）
 *
 * ここは infra0 の純粋関数。永続化（xp/gold/現在レベルの保存）は M5.3、UI は M5.4。
 * 数値はすべて仮（formulas.GROWTH）。M5 バランス／9章 live-ops で調整。
 */

import type { SpellLineKey, SpellLines, StatKey, Stats } from './schema.ts';
import { GROWTH } from './formulas.ts';

const STAT_KEYS: StatKey[] = ['vit', 'mag', 'pow', 'spd', 'men'];
const LINE_KEYS: SpellLineKey[] = ['fire', 'cure', 'sleep', 'strength'];

// ────────────────────────────────────────────────────────────
// XP 曲線（ソフトキャップ）
// ────────────────────────────────────────────────────────────

/** level → level+1 に要る XP（superlinear で単調増加＝上位ほど1レベルが重い） */
export function xpToNext(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return Math.round(GROWTH.baseXp * Math.pow(l, GROWTH.curveExp));
}

/** Lv1 から `level` に到達するのに要る累計 XP（Lv1 = 0） */
export function totalXpForLevel(level: number): number {
  const target = Math.max(1, Math.floor(level));
  let sum = 0;
  for (let l = 1; l < target; l++) sum += xpToNext(l);
  return sum;
}

export interface XpProgress {
  totalXp: number;
  level: number;
  intoLevel: number; // 現レベルに入ってからの XP（プログレスバーの分子）
  toNext: number; // 次レベルまでに要る XP（分母）
}

/** 累計 XP → レベルと進捗（青天井。maxLevelGuard で逆算ループを安全に打ち切る） */
export function progressForXp(totalXp: number): XpProgress {
  const total = Math.max(0, Math.floor(totalXp));
  let level = 1;
  let remaining = total;
  while (level < GROWTH.maxLevelGuard) {
    const need = xpToNext(level);
    if (remaining < need) break;
    remaining -= need;
    level += 1;
  }
  return { totalXp: total, level, intoLevel: remaining, toNext: xpToNext(level) };
}

export interface XpGain {
  progress: XpProgress;
  leveledUp: number; // 今回の獲得で上がったレベル数（0 = 据え置き）
}

/** XP 獲得（派遣の報酬など）を適用し、上がったレベル数を返す */
export function gainXp(beforeTotalXp: number, gained: number): XpGain {
  const before = progressForXp(beforeTotalXp);
  const after = progressForXp(Math.max(0, Math.floor(beforeTotalXp)) + Math.max(0, Math.floor(gained)));
  return { progress: after, leveledUp: after.level - before.level };
}

// ────────────────────────────────────────────────────────────
// 1プール配分（基本5ステ＋4魔法ライン／企画書3.5・3.5.2）
// ────────────────────────────────────────────────────────────

/** そのレベルで配れる総ポイント（flat 増加。プールは上限＝未使用は貯めておける） */
export function poolForLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return GROWTH.basePool + (l - 1) * GROWTH.pointsPerLevel;
}

/** 現在の配分が消費しているポイント（ステは下限より上ぶんのみ＋ライン修行値の合計） */
export function spentPoints(stats: Stats, spellLines: SpellLines): number {
  const statSpent = STAT_KEYS.reduce((s, k) => s + Math.max(0, stats[k] - GROWTH.statFloor), 0);
  const lineSpent = LINE_KEYS.reduce((s, k) => s + Math.max(0, spellLines[k]), 0);
  return statSpent + lineSpent;
}

export interface AllocationCheck {
  ok: boolean;
  spent: number;
  pool: number;
  unspent: number; // 余っている配分ポイント（>=0 のとき）
  reason?: string;
}

/** 配分の妥当性検証（ステ振り／リスペック共通）。下限割れ・プール超過を弾く（上限=青天井は無し） */
export function checkAllocation(level: number, stats: Stats, spellLines: SpellLines): AllocationCheck {
  const pool = poolForLevel(level);
  const spent = spentPoints(stats, spellLines);

  for (const k of STAT_KEYS) {
    if (!Number.isFinite(stats[k]) || stats[k] < GROWTH.statFloor) {
      return { ok: false, spent, pool, unspent: pool - spent, reason: `${k} が下限(${GROWTH.statFloor})未満` };
    }
  }
  for (const k of LINE_KEYS) {
    if (!Number.isFinite(spellLines[k]) || spellLines[k] < 0) {
      return { ok: false, spent, pool, unspent: pool - spent, reason: `魔法ライン ${k} が負値` };
    }
  }
  if (spent > pool) {
    return { ok: false, spent, pool, unspent: pool - spent, reason: `配分(${spent}) がプール(${pool}) を超過` };
  }
  return { ok: true, spent, pool, unspent: pool - spent };
}

// ────────────────────────────────────────────────────────────
// リスペック（振り直し・ゴールド消費／企画書3.5）
// ────────────────────────────────────────────────────────────

/** リスペック費用（ゴールド）。レベル比例でシンクとして効かせる */
export function respecCost(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return GROWTH.respecBase + GROWTH.respecPerLevel * l;
}
