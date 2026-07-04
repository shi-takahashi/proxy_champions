/**
 * M1: 戦闘エンジンのテスト。
 *  - 最重要 = 決定論（同 (input, seed) → 完全に同じログ・勝者・ターン数）。
 *  - 加えて式の"手触り"（MPフォールバック・眠りが精神で効きにくい 等）の境界確認。
 *
 * 依存ゼロ（std/assert を使わずインライン assert）＝オフラインでも走る。
 */

import { battle1v1 } from '../src/battle.ts';
import type { BattleEvent, CharacterBuild, SpellLines } from '../src/schema.ts';

// ── インライン assert ───────────────────────────────────────
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('assert failed: ' + msg);
}
function assertEquals(a: unknown, b: unknown, msg: string): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`assertEquals failed: ${msg}\n  a=${sa}\n  b=${sb}`);
}

// ── ビルド生成ヘルパー ─────────────────────────────────────
function makeBuild(
  id: string,
  stats: { vit: number; mag: number; pow: number; spd: number; men: number },
  lines: Partial<SpellLines> = {},
  equipment: Partial<CharacterBuild['equipment']> = {},
): CharacterBuild {
  return {
    characterId: id,
    level: 20,
    stats,
    spellLines: { fire: 0, cure: 0, sleep: 0, strength: 0, ...lines },
    equipment: { weapon: null, armor: null, shield: null, ...equipment },
  };
}

// 代表ビルド
const warrior = makeBuild('warrior', { vit: 20, mag: 2, pow: 18, spd: 10, men: 8 }, {}, {
  weapon: 'sword_iron',
  armor: 'mail_iron',
});
const mage = makeBuild('mage', { vit: 8, mag: 20, pow: 4, spd: 14, men: 4 }, { fire: 30 }, {
  weapon: 'staff_oak',
  armor: 'robe',
});
const cleric = makeBuild('cleric', { vit: 16, mag: 14, pow: 8, spd: 8, men: 12 }, { fire: 10, cure: 20 }, {
  weapon: 'staff_oak',
  armor: 'mail_leather',
});

// ── 1. 決定論: 同 seed → 完全一致 ───────────────────────────
Deno.test('determinism: 同 seed は完全に同じ結果とログ', () => {
  const r1 = battle1v1(warrior, mage, 12345);
  const r2 = battle1v1(warrior, mage, 12345);
  assertEquals(r1.winner, r2.winner, 'winner');
  assertEquals(r1.turns, r2.turns, 'turns');
  assertEquals(r1.eventLog, r2.eventLog, 'eventLog 完全一致');
});

// ── 2. seed 違い: 有効な結果が必ず出る（＝運で揺れるが常に整合） ──
Deno.test('seed 違いでも常に battle_end と勝者が整合', () => {
  for (const seed of [1, 2, 3, 100, 9999]) {
    const r = battle1v1(warrior, mage, seed);
    const last = r.eventLog[r.eventLog.length - 1] as Extract<BattleEvent, { type: 'battle_end' }>;
    assert(last.type === 'battle_end', `seed ${seed}: 末尾は battle_end`);
    assertEquals(last.winner, r.winner, `seed ${seed}: end.winner == result.winner`);
    assert(['A', 'B', 'draw'].includes(r.winner), `seed ${seed}: winner は A/B/draw`);
  }
});

// ── 3. 決定論の勝者安定: 同カード同 seed の勝者は常に同じ ────────
Deno.test('同カード同 seed の勝者・ターン数は不変', () => {
  const base = battle1v1(mage, cleric, 777);
  for (let i = 0; i < 5; i++) {
    const r = battle1v1(mage, cleric, 777);
    assertEquals(r.winner, base.winner, `run ${i}: winner`);
    assertEquals(r.turns, base.turns, `run ${i}: turns`);
  }
});

// ── 4. MP フォールバック: 呪文が無い脳筋は cast を一切出さず attack のみ ──
Deno.test('非魔法型は cast を出さず物理攻撃のみ', () => {
  const r = battle1v1(warrior, warrior, 42);
  const casts = r.eventLog.filter((e) => e.type === 'cast');
  const attacks = r.eventLog.filter((e) => e.type === 'attack');
  assertEquals(casts.length, 0, 'cast は 0');
  assert(attacks.length > 0, 'attack が出ている');
});

// ── 5. 眠り: 精神が薄い相手には効き、厚い相手には効きにくい ───────
Deno.test('sleep は低精神に効き高精神に効きにくい（自己修正メタ）', () => {
  const sleeper = makeBuild('sleeper', { vit: 12, mag: 22, pow: 4, spd: 12, men: 4 }, { sleep: 20, fire: 20 });
  const glassLowMen = makeBuild('lowmen', { vit: 12, mag: 4, pow: 14, spd: 10, men: 2 }, {}, { weapon: 'sword_iron' });
  // 精神(32) を眠らせ役の魔力(22) より明確に上に → カーブ上「ほぼ効かない」帯
  const tankHighMen = makeBuild('highmen', { vit: 20, mag: 6, pow: 14, spd: 10, men: 32 }, {}, {
    weapon: 'sword_iron',
    armor: 'mail_iron',
  });

  const successRate = (target: CharacterBuild) => {
    let attempts = 0;
    let hits = 0;
    for (let seed = 0; seed < 300; seed++) {
      for (const e of battle1v1(sleeper, target, seed).eventLog) {
        if (e.type === 'status_apply' && e.status === 'sleep') {
          attempts++;
          if (e.success) hits++;
        }
      }
    }
    return attempts > 0 ? hits / attempts : 0;
  };

  const low = successRate(glassLowMen);
  const high = successRate(tankHighMen);
  assert(low > high, `低精神(${low.toFixed(2)}) > 高精神(${high.toFixed(2)}) であるべき`);
  assert(low > 0.5, `低精神には過半で入る（${low.toFixed(2)}）`);
  assert(high < 0.5, `高精神には効きにくい（${high.toFixed(2)}）`);
});

// ── 6. 便利ラッパーの決定論（battle1v1 と直接 battle の一致は省略・実装同一） ──
Deno.test('draw にならず現実的な決着がつく（脳筋 vs 魔法）', () => {
  let decisive = 0;
  for (let seed = 0; seed < 50; seed++) {
    if (battle1v1(warrior, mage, seed).winner !== 'draw') decisive++;
  }
  assert(decisive >= 45, `大半の試合で決着（${decisive}/50）`);
});
