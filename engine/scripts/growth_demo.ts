/**
 * M5.2: 成長曲線の手触り確認 CLI（`deno task growth`）。
 * XP曲線（ソフトキャップ）・配分プール・リスペック費用を一覧して、
 * 「上位ほど1レベルが重い＝伸び鈍化」（企画書3.4）を目視で確認・調整する。
 *
 * 数値はすべて仮（formulas.GROWTH）。
 */

import { poolForLevel, respecCost, totalXpForLevel, xpToNext } from '../src/growth.ts';

const rows = [1, 2, 3, 5, 10, 20, 30, 50, 100];

console.log('Lv   xpToNext    累計XP        プール   リスペック(g)');
console.log('──   ────────    ──────────    ──────   ────────────');
for (const lv of rows) {
  console.log(
    [
      String(lv).padStart(3),
      String(xpToNext(lv)).padStart(9),
      String(totalXpForLevel(lv)).padStart(12),
      String(poolForLevel(lv)).padStart(8),
      String(respecCost(lv)).padStart(12),
    ].join('  '),
  );
}

// 「派遣1回≒何レベルぶん進むか」の目安（M5.1 の稼ぎ 10xp/win 前提）
const xpPerWin = 10;
console.log(
  `\n目安: 10xp/勝 として Lv1→2 は約 ${Math.ceil(xpToNext(1) / xpPerWin)} 勝、` +
    `Lv30→31 は約 ${Math.ceil(xpToNext(30) / xpPerWin)} 勝（＝上位ほど時間がかかる＝伸び鈍化）`,
);
