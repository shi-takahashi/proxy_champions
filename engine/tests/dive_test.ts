/**
 * M5: 派遣ダンジョン（dive）のテスト。
 *  - 最重要 = 決定論（同 (hero, dungeon, seed, minutes) → 完全に同じ DiveResult）。
 *  - 体力ループ: HP を試合間で持ち越す（battle() の startHp / endState）＝カギの新規挙動。
 *  - 報酬集計の整合／体力0 強制帰還／時間切れ／cure が uptime を延ばす（バースト対サステイン）。
 *
 * 依存ゼロ（インライン assert）。
 */

import { dive, staminaRecover } from '../src/dive.ts';
import { battle } from '../src/battle.ts';
import { CONFIG, maxHP } from '../src/formulas.ts';
import type { CharacterBuild, DungeonDef, SpellLines } from '../src/schema.ts';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error('assert failed: ' + msg);
}
function assertEquals(a: unknown, b: unknown, msg: string): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`assertEquals failed: ${msg}\n  a=${sa}\n  b=${sb}`);
}

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

const dungeon: DungeonDef = {
  slug: 'novice_field',
  difficulty: 2,
  dropTable: [
    { kind: 'equipment', id: 'dagger', weight: 5 },
    { kind: 'equipment', id: 'mail_leather', weight: 5 },
    { kind: 'item', id: 'potion_hp_small', weight: 4 },
  ],
};

// 標準的な物理アタッカー（装備あり）
const fighter = makeBuild('fighter', { vit: 16, mag: 2, pow: 16, spd: 10, men: 8 }, {}, {
  weapon: 'sword_iron',
  armor: 'mail_leather',
});

// ── 1. 決定論: 同入力は完全一致 ──────────────────────────────
Deno.test('dive determinism: 同入力は完全に同じ DiveResult', () => {
  const a = dive(fighter, dungeon, 12345, 60);
  const b = dive(fighter, dungeon, 12345, 60);
  assertEquals(a, b, 'DiveResult 完全一致');
});

// ── 2. battle() の startHp 持ち越しプリミティブ（体力ループの土台）──
Deno.test('battle は startHp を尊重（低 HP から始めると負ける）', () => {
  const enemy = makeBuild('enemy', { vit: 12, mag: 2, pow: 12, spd: 8, men: 4 }, {}, {
    weapon: 'sword_iron',
    armor: 'mail_leather',
  });
  const full = battle({
    teamA: [{ id: 'h', side: 'A', build: fighter }],
    teamB: [{ id: 'e', side: 'B', build: enemy }],
    seed: 7,
  });
  const wounded = battle({
    teamA: [{ id: 'h', side: 'A', build: fighter, startHp: 5, startMp: 0 }],
    teamB: [{ id: 'e', side: 'B', build: enemy }],
    seed: 7,
  });
  assert(full.winner === 'A', '満タンなら勝てる相手');
  assert(wounded.winner === 'B', 'HP5 スタートなら同じ相手に負ける（持ち越しが効いている）');
  const wh = wounded.endState.find((s) => s.side === 'A')!;
  assertEquals(wh.hp, 0, '負けた hero の endState.hp は 0');
  assert(!wh.alive, '負けた hero は alive=false');
});

// ── 3. 体力ループ: cure 無しなら HP は試合間で単調に減る ─────────
Deno.test('体力ループ: cure 無しは HP が試合を跨いで単調減少（持ち越し）', () => {
  const r = dive(fighter, dungeon, 999, 300);
  assert(r.battles.length >= 2, `複数戦している（${r.battles.length}）`);
  for (let i = 1; i < r.battles.length; i++) {
    assert(
      r.battles[i].hpAfter <= r.battles[i - 1].hpAfter,
      `battle ${i}: HP は増えない（${r.battles[i - 1].hpAfter}→${r.battles[i].hpAfter}）`,
    );
  }
  // 満タンから始めて削れている＝持ち越しが起きている証拠
  assert(r.battles[r.battles.length - 1].hpAfter < maxHP(fighter.stats.vit), 'どこかで削れている');
});

// ── 4. 報酬集計の整合 ────────────────────────────────────────
Deno.test('報酬: totalXp/gold/drops は明細の合計と一致・勝利のみ報酬', () => {
  const r = dive(fighter, dungeon, 42, 120);
  const sumXp = r.battles.reduce((s, b) => s + b.xp, 0);
  const sumGold = r.battles.reduce((s, b) => s + b.gold, 0);
  const dropList = r.battles.filter((b) => b.drop).map((b) => b.drop);
  assertEquals(r.totalXp, sumXp, 'totalXp == Σ battle.xp');
  assertEquals(r.totalGold, sumGold, 'totalGold == Σ battle.gold');
  assertEquals(r.drops, dropList, 'drops == 明細の drop 列');
  for (const b of r.battles) {
    if (!b.won) {
      assertEquals(b.xp, 0, '敗北/引き分けは xp 0');
      assertEquals(b.gold, 0, '敗北/引き分けは gold 0');
      assertEquals(b.drop, null, '敗北/引き分けは drop なし');
    }
  }
});

// ── 5. 終了条件: time / ko の不変条件 ───────────────────────────
Deno.test('終了条件: ko⇔HP0・time⇔HP>0、時間は指定内、刻みは戦闘長依存', () => {
  // 弱い hero を高難度へ → いつか強制帰還
  const weak = makeBuild('weak', { vit: 8, mag: 2, pow: 8, spd: 8, men: 4 }, {}, { weapon: 'dagger' });
  const hard: DungeonDef = { slug: 'hard', difficulty: 6, dropTable: [] };
  const ko = dive(weak, hard, 3, 600);
  assertEquals(ko.endReason, 'ko', '弱者×高難度は強制帰還');
  assertEquals(ko.hpRemaining, 0, 'ko なら HP0');
  assert(ko.battles[ko.battles.length - 1].won === false, 'ko の最終戦は勝っていない');

  // 強い hero を低難度へ → 時間切れまで生存
  const tank = makeBuild('tank', { vit: 40, mag: 2, pow: 18, spd: 10, men: 12 }, {}, {
    weapon: 'sword_iron',
    armor: 'mail_iron',
    shield: 'shield_iron',
  });
  const easy: DungeonDef = { slug: 'easy', difficulty: 1, dropTable: [] };
  const t = dive(tank, easy, 3, 30);
  assertEquals(t.endReason, 'time', '強者×低難度は時間切れ');
  assert(t.hpRemaining > 0, 'time なら HP は残る');
  // 最後の1戦は時間内に開始して超過し得るが、超過は高々1戦ぶん。
  assert(
    t.minutesElapsed < 30 + CONFIG.dive.maxMinutesPerBattle,
    '指定時間の超過は最後の1戦ぶんまで',
  );
  // 刻みは戦闘の長さ（turns）依存で可変。各戦の増分が上下限クランプ内かを検証。
  let prev = 0;
  for (let i = 0; i < t.battles.length; i++) {
    const step = t.battles[i].minutesElapsed - prev;
    assert(
      step >= CONFIG.dive.minMinutesPerBattle - 1e-9 && step <= CONFIG.dive.maxMinutesPerBattle + 1e-9,
      `1戦の所要は[min,max]内（step=${step}）`,
    );
    prev = t.battles[i].minutesElapsed;
  }
});

// ── 6b. 部分体力からの再派遣（startHp）＝永続層の体力ループ ─────
Deno.test('dive は startHp を尊重（部分体力から再派遣）', () => {
  const mhp = maxHP(fighter.stats.vit);
  const full = dive(fighter, dungeon, 500, 300);
  const wounded = dive(fighter, dungeon, 500, 300, { startHp: Math.floor(mhp / 4) });
  // 少ない体力から始めれば早く力尽きる（＝持ち越しが効く）
  assert(
    wounded.battles.length <= full.battles.length,
    `低HPスタートは戦数が増えない（wounded ${wounded.battles.length} ≤ full ${full.battles.length}）`,
  );
  assert(wounded.endReason === 'ko', '1/4 体力なら強制帰還しやすい');
});

// ── 6c. 自然回復（純粋・時間で回復・maxHP 頭打ち）───────────────
Deno.test('staminaRecover: 時間で回復し maxHP で頭打ち', () => {
  const maxHp = 200;
  assertEquals(staminaRecover(0, maxHp, 0), 0, '経過0分は回復なし');
  const perMin = CONFIG.dive.regenPctPerMinute * maxHp; // 2/分
  assertEquals(staminaRecover(0, maxHp, 10), Math.floor(10 * perMin), '10分ぶん回復');
  assertEquals(staminaRecover(190, maxHp, 100), maxHp, 'maxHP を超えない（頭打ち）');
  assert(staminaRecover(50, maxHp, 30) > 50, '回復は増加方向');
});

// ── 6. cure が uptime を延ばす（バースト対サステイン・企画書4.2）──
Deno.test('cure 持ちは cure 無しより長く潜れる（uptime 延長）', () => {
  // 同じ地力（vit/pow/spd/men 同一・魔力も同一）。差は「cure ラインへの投資」だけ。
  const base = { vit: 18, mag: 16, pow: 10, spd: 10, men: 8 };
  const eq = { weapon: 'sword_iron', armor: 'mail_leather' };
  const healer = makeBuild('healer', base, { cure: 30 }, eq);
  const noCure = makeBuild('nocure', base, {}, eq);
  const grind: DungeonDef = { slug: 'grind', difficulty: 3, dropTable: [] };

  const h = dive(healer, grind, 55, 600);
  const n = dive(noCure, grind, 55, 600);
  assert(
    h.battles.length >= n.battles.length,
    `cure 持ちは戦数で下回らない（healer ${h.battles.length} vs noCure ${n.battles.length}）`,
  );
  assert(
    h.battles.filter((b) => b.won).length >= n.battles.filter((b) => b.won).length,
    `cure 持ちは勝利数で下回らない`,
  );
});
