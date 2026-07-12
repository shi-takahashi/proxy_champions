/**
 * M5: 派遣ダンジョン（dive）— 決定論の連戦ループ（企画書3.3.1 / 実装プラン M5）。
 *
 *   dive(hero, dungeon, seed, minutes) → DiveResult
 *
 * 特性:
 *  - 純粋関数（battle() を敵連戦で再利用＝"戦闘エンジンは1回だけ実装"／実装プラン13.1）。
 *  - 体力ループ: HP/MP を試合間で持ち越し（battle() の startHp/startMp・endState）。
 *      cure が続く限り自己回復して長く潜れる＝uptime 延長（企画書4.2 バースト対サステイン）。
 *  - 体力0 で強制帰還（endReason='ko'）／指定時間まで戦って時間切れ（'time'）。そこまでの報酬は持ち帰る。
 *  - 決定論: 同 (hero, dungeon, seed, minutes) → 同 DiveResult（記録すれば再現・検証）。
 *
 * ★報酬レート・敵強度はすべて仮（formulas.CONFIG.dive）。M5 バランスで実測調整。
 */

import type {
  CharacterBuild,
  DiveBattleSummary,
  DiveEndReason,
  DiveResult,
  DropRef,
  DungeonDef,
} from './schema.ts';
import { battle } from './battle.ts';
import { CONFIG, maxHP, maxMP } from './formulas.ts';
import { Rng } from './rng.ts';

const HERO_ID = 'hero';

/** 戦闘の行動回数（turns）を1戦の所要時間（分）に変換。上下限でクランプ。 */
function battleMinutes(turns: number): number {
  const dv = CONFIG.dive;
  return Math.max(dv.minMinutesPerBattle, Math.min(dv.maxMinutesPerBattle, turns * dv.minutesPerTurn));
}

/**
 * 敵ビルドを difficulty で線形スケール生成（MVP は物理グラント1型・決定論＝index 依存）。
 * 敵の多様化（アーキタイプ混在）は launch 後の live-ops（企画書9章）で拡張。
 */
function makeEnemy(dungeon: DungeonDef, index: number): CharacterBuild {
  const d = dungeon.difficulty;
  const dv = CONFIG.dive;
  return {
    characterId: `enemy_${dungeon.slug}_${index}`,
    level: d,
    stats: {
      vit: Math.round(dv.enemyVitBase + d * dv.enemyVitPerDiff),
      mag: 2,
      pow: Math.round(dv.enemyPowBase + d * dv.enemyPowPerDiff),
      spd: Math.round(dv.enemySpdBase + d * dv.enemySpdPerDiff),
      men: 4,
    },
    spellLines: { fire: 0, cure: 0, sleep: 0, strength: 0 },
    equipment: { weapon: 'sword_iron', armor: 'mail_leather', shield: null },
  };
}

/** ドロップ抽選（勝利ごと・重み付き・決定論）。装備/アイテムのタグ付き参照を返す。ハズレは null。 */
function rollDrop(dungeon: DungeonDef, rng: Rng): DropRef | null {
  if (!rng.chance(CONFIG.dive.dropChancePerWin)) return null;
  const table = dungeon.dropTable;
  const total = table.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) return null;
  let r = rng.next() * total;
  let picked = table[table.length - 1];
  for (const e of table) {
    r -= e.weight;
    if (r < 0) {
      picked = e;
      break;
    }
  }
  return { kind: picked.kind, id: picked.id };
}

export interface DiveOptions {
  /** 派遣開始時の HP（未指定＝満タン）。体力が残ったまま再派遣する時に渡す（企画書3.3「体力1以上なら即再派遣」）。 */
  startHp?: number;
  /** 派遣開始時の MP（未指定＝満タン）。MVP の永続層は毎回満タン（体力ループが核）。 */
  startMp?: number;
}

/** 帰還後の自然回復（純粋・企画書3.3）: 現在HP + 経過分×%最大HP を maxHP で頭打ち。 */
export function staminaRecover(currentHp: number, maxHp: number, elapsedMinutes: number): number {
  const gained = Math.floor(Math.max(0, elapsedMinutes) * CONFIG.dive.regenPctPerMinute * maxHp);
  return Math.min(maxHp, Math.max(0, currentHp) + gained);
}

/**
 * 派遣ダンジョン1回ぶんの決定論シミュレーション。
 * @param hero    派遣するキャラ
 * @param dungeon ダンジョン定義（difficulty・ドロップ表）
 * @param seed    この派遣のシード（記録すれば再現・検証）
 * @param minutes 指定潜航時間（分）。この範囲で連戦する
 * @param opts    開始 HP/MP（未指定＝満タン。部分体力からの再派遣に使う）
 */
export function dive(
  hero: CharacterBuild,
  dungeon: DungeonDef,
  seed: number,
  minutes: number,
  opts: DiveOptions = {},
): DiveResult {
  const rng = new Rng(seed);
  const mhp = maxHP(hero.stats.vit);
  const mmp = maxMP(hero.stats.mag);

  let hp = Math.min(mhp, Math.max(0, opts.startHp ?? mhp));
  let mp = Math.min(mmp, Math.max(0, opts.startMp ?? mmp));
  let elapsed = 0;
  let index = 0;
  let totalXp = 0;
  let totalGold = 0;
  let endReason: DiveEndReason = 'time';
  const battles: DiveBattleSummary[] = [];
  const drops: DropRef[] = [];

  // 指定時間内で、体力が残る限り連戦（企画書3.3.1）
  while (elapsed < minutes && hp > 0) {
    const enemy = makeEnemy(dungeon, index);
    const battleSeed = rng.int(1, 2 ** 31);
    const result = battle({
      teamA: [{ id: HERO_ID, side: 'A', build: hero, startHp: hp, startMp: mp }],
      teamB: [{ id: enemy.characterId, side: 'B', build: enemy }],
      seed: battleSeed,
    });
    // 1戦の所要時間 ＝ 戦闘の長引き具合（turns）から算出。弱い敵ほど短く、強敵ほど長い。
    elapsed += battleMinutes(result.turns);

    // HP/MP を次戦へ持ち越す（体力ループ）
    const heroEnd = result.endState.find((s) => s.side === 'A')!;
    hp = heroEnd.hp;
    mp = heroEnd.mp;

    const won = result.winner === 'A';
    let xp = 0;
    let gold = 0;
    let drop: DropRef | null = null;
    if (won) {
      xp = CONFIG.dive.xpPerWinBase * dungeon.difficulty;
      gold = CONFIG.dive.goldPerWinBase * dungeon.difficulty;
      drop = rollDrop(dungeon, rng);
      totalXp += xp;
      totalGold += gold;
      if (drop) drops.push(drop);
    }

    battles.push({
      index,
      winner: result.winner,
      won,
      enemyId: enemy.characterId,
      xp,
      gold,
      drop,
      hpAfter: hp,
      mpAfter: mp,
      minutesElapsed: elapsed,
    });
    index += 1;

    // 体力0 → 強制帰還（そこまでの報酬は持ち帰る・残り時間は取り逃す／企画書3.3）
    if (hp <= 0) {
      endReason = 'ko';
      break;
    }
  }

  return {
    dungeonSlug: dungeon.slug,
    seed,
    battles,
    totalXp,
    totalGold,
    drops,
    hpRemaining: hp,
    mpRemaining: mp,
    minutesElapsed: elapsed,
    endReason,
  };
}
