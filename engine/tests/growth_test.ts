/**
 * M5.2: 成長式のテスト。
 *  - XP曲線がソフトキャップ（単調増加・上位ほど1レベルが重い＝伸び鈍化／企画書3.4）。
 *  - XP ↔ レベルの往復が整合（プログレスバーの分子/分母）。
 *  - 1プール配分の消費計算・検証（下限割れ・プール超過・青天井=上限なし／企画書3.5）。
 *  - リスペック費用がレベルで増える（ゴールドシンク）。
 *
 * 依存ゼロ（インライン assert）。
 */

import {
  checkAllocation,
  gainXp,
  poolForLevel,
  progressForXp,
  respecCost,
  spentPoints,
  totalXpForLevel,
  xpToNext,
} from '../src/growth.ts';
import { GROWTH } from '../src/formulas.ts';
import type { SpellLines, Stats } from '../src/schema.ts';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('assert failed: ' + msg);
}
function assertEquals(a: unknown, b: unknown, msg: string): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`assertEquals failed: ${msg}\n  a=${sa}\n  b=${sb}`);
}

const floorStats: Stats = { vit: 1, mag: 1, pow: 1, spd: 1, men: 1 };
const noLines: SpellLines = { fire: 0, cure: 0, sleep: 0, strength: 0 };

// ── 1. XP曲線: 単調増加・superlinear（ソフトキャップ）──────────
Deno.test('XP曲線: 1レベルのコストが単調増加・上位ほど重い（伸び鈍化）', () => {
  for (let l = 1; l < 100; l++) {
    assert(xpToNext(l + 1) > xpToNext(l), `xpToNext は単調増加（L${l}）`);
  }
  // superlinear = 高レベルの方が「1レベルあたり」重い（時間比例で伸びが寝る）
  assert(xpToNext(10) > 10 * xpToNext(1), 'L10 の1レベルは L1 の10倍より重い（加速）');
  // 上限なし（青天井）= 遥か高レベルでも有限だが増え続ける
  assert(xpToNext(1000) > xpToNext(100), '上限で頭打ちにならない');
});

// ── 2. XP ↔ レベル往復 ─────────────────────────────────────
Deno.test('XP↔レベル: 累計XPちょうどでレベル境界に乗る', () => {
  for (const lv of [1, 2, 5, 10, 30]) {
    const at = progressForXp(totalXpForLevel(lv));
    assertEquals(at.level, lv, `totalXpForLevel(${lv}) はちょうど Lv${lv}`);
    assertEquals(at.intoLevel, 0, `境界では intoLevel=0（Lv${lv}）`);
    assertEquals(at.toNext, xpToNext(lv), `toNext は次レベルのコスト（Lv${lv}）`);
    if (lv > 1) {
      const justBelow = progressForXp(totalXpForLevel(lv) - 1);
      assertEquals(justBelow.level, lv - 1, `1手前は Lv${lv - 1}`);
    }
  }
  // 進捗の内訳が閉じている: intoLevel < toNext、totalXp = 累計 + intoLevel
  const p = progressForXp(1234);
  assert(p.intoLevel < p.toNext, 'intoLevel < toNext');
  assertEquals(totalXpForLevel(p.level) + p.intoLevel, p.totalXp, 'totalXp = 累計 + intoLevel');
});

// ── 3. XP獲得でレベルが上がる（複数レベル一気も）──────────────
Deno.test('gainXp: 獲得でレベルが上がり、上がった数を返す', () => {
  const none = gainXp(0, 0);
  assertEquals(none.leveledUp, 0, '獲得0はレベル据え置き');
  assertEquals(none.progress.level, 1, '初期は Lv1');

  const one = gainXp(0, xpToNext(1));
  assertEquals(one.progress.level, 2, 'Lv1→2 ちょうど');
  assertEquals(one.leveledUp, 1, '1レベル上昇');

  // Lv1 から Lv5 到達ぶん一気 → 4レベル上昇
  const many = gainXp(0, totalXpForLevel(5));
  assertEquals(many.progress.level, 5, '一気に Lv5');
  assertEquals(many.leveledUp, 4, '4レベル上昇');

  // 端数の持ち越し: 途中から少し足しても整合
  const mid = gainXp(totalXpForLevel(3), 10);
  assertEquals(mid.progress.totalXp, totalXpForLevel(3) + 10, 'totalXp は前+獲得');
});

// ── 4. 配分プール: レベルで増える ───────────────────────────
Deno.test('poolForLevel: Lv1=basePool、レベルごとに pointsPerLevel 増える', () => {
  assertEquals(poolForLevel(1), GROWTH.basePool, 'Lv1 は basePool');
  assertEquals(poolForLevel(2), GROWTH.basePool + GROWTH.pointsPerLevel, 'Lv2');
  assertEquals(
    poolForLevel(20),
    GROWTH.basePool + 19 * GROWTH.pointsPerLevel,
    'Lv20',
  );
});

// ── 5. 消費ポイント計算（ステは下限より上ぶん＋ライン合計）──────
Deno.test('spentPoints: 下限より上のステ＋ライン修行値の合計', () => {
  assertEquals(spentPoints(floorStats, noLines), 0, '全ステ下限・ライン0 は消費0');
  const stats: Stats = { vit: 6, mag: 3, pow: 1, spd: 1, men: 1 }; // (5)+(2)+0+0+0 = 7
  const lines: SpellLines = { fire: 4, cure: 0, sleep: 0, strength: 1 }; // 5
  assertEquals(spentPoints(stats, lines), 12, '(vit5+mag2)+(fire4+str1)=12');
});

// ── 6. 配分検証: プール内OK・超過NG・下限割れNG・青天井（上限なし）──
Deno.test('checkAllocation: プール内OK / 超過NG / 下限割れNG / 上限なし', () => {
  const lv = 5;
  const pool = poolForLevel(lv); // basePool + 4*pointsPerLevel

  // ちょうど使い切り（全部 vit に寄せる = 青天井: 上限で弾かれない）
  const allVit: Stats = { vit: GROWTH.statFloor + pool, mag: 1, pow: 1, spd: 1, men: 1 };
  const ok = checkAllocation(lv, allVit, noLines);
  assert(ok.ok, `使い切りは OK（${ok.reason ?? ''}）`);
  assertEquals(ok.spent, pool, 'spent == pool');
  assertEquals(ok.unspent, 0, 'unspent 0');

  // 1点超過 = NG
  const over: Stats = { vit: GROWTH.statFloor + pool + 1, mag: 1, pow: 1, spd: 1, men: 1 };
  assert(!checkAllocation(lv, over, noLines).ok, 'プール超過は NG');

  // 余らせても OK（unspent>0）
  const under: Stats = { vit: GROWTH.statFloor + 3, mag: 1, pow: 1, spd: 1, men: 1 };
  const u = checkAllocation(lv, under, noLines);
  assert(u.ok && u.unspent === pool - 3, '余りは貯められる');

  // 下限割れ = NG
  const below: Stats = { vit: 0, mag: 1, pow: 1, spd: 1, men: 1 };
  assert(!checkAllocation(lv, below, noLines).ok, '下限割れは NG');

  // 負のライン = NG
  assert(!checkAllocation(lv, floorStats, { ...noLines, fire: -1 }).ok, '負のラインは NG');
});

// ── 7. リスペック費用: レベルで増える正の値（ゴールドシンク）──────
Deno.test('respecCost: 正でレベルとともに増える', () => {
  assert(respecCost(1) > 0, 'Lv1 でも正の費用');
  for (let l = 1; l < 50; l++) {
    assert(respecCost(l + 1) > respecCost(l), `費用は単調増加（L${l}）`);
  }
});
