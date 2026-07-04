/**
 * M2: バランス検証ハーネス（実装プラン M2・企画書9章の live-ops を launch 前に予行）。
 *
 * 代表アーキタイプを総当たり × 多シードで戦わせ、勝率マトリクスと診断を出す。
 * 純粋関数＝インフラ0・一瞬。UI を1画面も作る前に「この数式は面白いバランスか」を数字で見る。
 *
 * 見るもの:
 *  1. 勝率マトリクス（行が列に対する勝率）
 *  2. アーキタイプ別・平均勝率 → 最強ステ/死にステの検出
 *  3. ミラー対戦 ≈ 50% → side/id バイアスが無いことの sanity
 *  4. 三すくみ（速攻物理 ＞ 魔法使い ＞ 重装タンク ＞ 速攻物理・企画書9章）が創発しているか
 *  5. 振れ幅：ソフト相性 60:40（企画書9章）＝多くの対戦が 30〜70% に収まるか
 *
 *   実行: deno task balance   （= deno run scripts/balance.ts）
 *   仮値は formulas.ts。ここで回して調整する。
 */

import { battle } from '../src/battle.ts';
import type { CharacterBuild, SpellLines } from '../src/schema.ts';

const SEEDS = 2000; // 各対戦の試行数（×2オリエンテーションで side バイアス相殺）

function mk(
  id: string,
  stats: { vit: number; mag: number; pow: number; spd: number; men: number },
  lines: Partial<SpellLines>,
  equipment: Partial<CharacterBuild['equipment']>,
): CharacterBuild {
  return {
    characterId: id,
    level: 20,
    stats,
    spellLines: { fire: 0, cure: 0, sleep: 0, strength: 0, ...lines },
    equipment: { weapon: null, armor: null, shield: null, ...equipment },
  };
}

/** 1プールの総投資（ステ合計＋修行値合計）。アーキタイプ間の公平さの目安 */
function pool(b: CharacterBuild): number {
  const s = b.stats;
  const l = b.spellLines;
  return s.vit + s.mag + s.pow + s.spd + s.men + l.fire + l.cure + l.sleep + l.strength;
}

// ── 代表アーキタイプ（三すくみの核 = SPD / MAG / TNK、＋支援ロール） ──
interface Archetype {
  key: string;
  name: string;
  build: CharacterBuild;
}

const ARCHETYPES: Archetype[] = [
  {
    key: 'SPD',
    name: '速攻物理',
    build: mk('spd', { vit: 16, mag: 2, pow: 22, spd: 26, men: 10 }, {}, {
      weapon: 'dagger',
      armor: 'mail_leather',
    }),
  },
  {
    key: 'TNK',
    name: '重装タンク',
    build: mk('tnk', { vit: 26, mag: 4, pow: 20, spd: 8, men: 12 }, { strength: 10 }, {
      weapon: 'axe_battle',
      armor: 'mail_iron',
      shield: 'shield_iron',
    }),
  },
  {
    key: 'MAG',
    name: '魔法使い',
    build: mk('mag', { vit: 12, mag: 22, pow: 4, spd: 18, men: 6 }, { fire: 20 }, {
      weapon: 'staff_oak',
      armor: 'robe',
    }),
  },
  {
    key: 'CLR',
    name: '回復僧侶',
    build: mk('clr', { vit: 20, mag: 14, pow: 8, spd: 10, men: 12 }, { cure: 16, fire: 8 }, {
      weapon: 'staff_oak',
      armor: 'mail_leather',
    }),
  },
  {
    key: 'SLP',
    name: '睡眠術師',
    build: mk('slp', { vit: 14, mag: 18, pow: 6, spd: 16, men: 8 }, { sleep: 12, fire: 10 }, {
      weapon: 'staff_oak',
      armor: 'mail_leather',
    }),
  },
  {
    key: 'BAL',
    name: 'バランス',
    build: mk('bal', { vit: 18, mag: 12, pow: 14, spd: 14, men: 14 }, { fire: 8, strength: 6 }, {
      weapon: 'sword_iron',
      armor: 'mail_leather',
      shield: 'shield_wood',
    }),
  },
];

/** i vs j の勝率（draw 除外）＋ draw率。両オリエンテーションで side バイアス相殺 */
function matchup(i: Archetype, j: Archetype): { iWin: number; draw: number } {
  let iw = 0;
  let jw = 0;
  let dr = 0;
  for (let seed = 0; seed < SEEDS; seed++) {
    // i を A 側／B 側の両方で回す
    const r1 = battle({
      teamA: [{ id: 'A', side: 'A', build: i.build }],
      teamB: [{ id: 'B', side: 'B', build: j.build }],
      seed,
    });
    if (r1.winner === 'A') iw++;
    else if (r1.winner === 'B') jw++;
    else dr++;

    const r2 = battle({
      teamA: [{ id: 'A', side: 'A', build: j.build }],
      teamB: [{ id: 'B', side: 'B', build: i.build }],
      seed,
    });
    if (r2.winner === 'B') iw++;
    else if (r2.winner === 'A') jw++;
    else dr++;

    void r2;
  }
  const decisive = iw + jw;
  const total = iw + jw + dr;
  return { iWin: decisive > 0 ? iw / decisive : 0.5, draw: dr / total };
}

function pct(x: number): string {
  return (x * 100).toFixed(0).padStart(3) + '%';
}

// ── 実行 ───────────────────────────────────────────────────
console.log(`\n=== M2 バランス検証ハーネス（${SEEDS} seeds × 2 orientation / 対戦） ===\n`);

console.log('アーキタイプ（1プール総投資 = ステ合計＋修行値合計）:');
for (const a of ARCHETYPES) {
  console.log(`  ${a.key}  ${a.name.padEnd(6, '　')}  pool=${pool(a.build)}`);
}

const n = ARCHETYPES.length;
const winMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
const drawMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    if (i === j) {
      const m = matchup(ARCHETYPES[i], ARCHETYPES[j]); // ミラー sanity
      winMatrix[i][j] = m.iWin;
      drawMatrix[i][j] = m.draw;
    } else if (j > i) {
      const m = matchup(ARCHETYPES[i], ARCHETYPES[j]);
      winMatrix[i][j] = m.iWin;
      winMatrix[j][i] = 1 - m.iWin;
      drawMatrix[i][j] = m.draw;
      drawMatrix[j][i] = m.draw;
    }
  }
}

// 勝率マトリクス
console.log('\n── 勝率マトリクス（行 の 列 に対する勝率・draw除外）──');
console.log('       ' + ARCHETYPES.map((a) => a.key.padStart(5)).join(' '));
for (let i = 0; i < n; i++) {
  const row = ARCHETYPES.map((_, j) => (i === j ? '  ・ ' : pct(winMatrix[i][j]).padStart(5))).join(' ');
  console.log(`  ${ARCHETYPES[i].key}  ${row}`);
}

// 平均勝率（対他アーキタイプ）→ 最強/死にステ検出
console.log('\n── アーキタイプ別 平均勝率（対他5種）── 50%付近が理想（一強/死にステが無い）');
const avg = ARCHETYPES.map((a, i) => {
  let sum = 0;
  let cnt = 0;
  for (let j = 0; j < n; j++) {
    if (i === j) continue;
    sum += winMatrix[i][j];
    cnt++;
  }
  return { key: a.key, name: a.name, avg: sum / cnt };
}).sort((x, y) => y.avg - x.avg);
for (const a of avg) console.log(`  ${a.key}  ${a.name.padEnd(6, '　')}  ${pct(a.avg)}`);

// ミラー sanity
console.log('\n── ミラー対戦（同型 vs 同型）≈ 50% なら side/id バイアス無し ──');
for (let i = 0; i < n; i++) {
  console.log(`  ${ARCHETYPES[i].key}  ${pct(winMatrix[i][i])}`);
}

// 三すくみチェック（企画書9章）
console.log('\n── 三すくみチェック（企画書9章: 速攻物理 ＞ 魔法使い ＞ 重装タンク ＞ 速攻物理）──');
const idx = (k: string) => ARCHETYPES.findIndex((a) => a.key === k);
const cyc: [string, string][] = [['SPD', 'MAG'], ['MAG', 'TNK'], ['TNK', 'SPD']];
let cycOk = 0;
for (const [a, b] of cyc) {
  const w = winMatrix[idx(a)][idx(b)];
  const ok = w > 0.5;
  if (ok) cycOk++;
  console.log(`  ${a} vs ${b}: ${pct(w)}  ${ok ? '✓ 勝ち越し' : '✗ 想定と逆'}`);
}
console.log(`  → 三すくみ成立: ${cycOk}/3`);

// 振れ幅（ソフト相性 60:40）
console.log('\n── 振れ幅（ソフト相性の目安。ハードカウンター=極端な相性を検出）──');
let hard = 0;
let softish = 0;
const pairs: string[] = [];
for (let i = 0; i < n; i++) {
  for (let j = i + 1; j < n; j++) {
    const w = winMatrix[i][j];
    if (w < 0.2 || w > 0.8) {
      hard++;
      pairs.push(`${ARCHETYPES[i].key} vs ${ARCHETYPES[j].key} = ${pct(w)}`);
    } else if (w >= 0.35 && w <= 0.65) softish++;
  }
}
const totalPairs = (n * (n - 1)) / 2;
console.log(`  互角寄り(35-65%): ${softish}/${totalPairs}   ハードカウンター(<20%|>80%): ${hard}/${totalPairs}`);
if (pairs.length) for (const p of pairs) console.log(`    ⚠ ${p}`);

console.log('\n=== 完了。仮値は formulas.ts で調整して再実行 ===\n');
