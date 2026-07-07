/**
 * M1: 決定論戦闘エンジン（CTB 持ち点式ターン順・企画書4.1.1）。
 *
 *   battle(input) → { winner, seed, turns, eventLog }
 *
 * 特性:
 *  - 純粋関数（I/O なし・DB も UI も知らない）。同 (input, seed) → 同結果・同ログ（企画書13.4）。
 *  - リスト対リストで実装 → 1v1 は各チーム要素1、団体戦(3v3)は要素を増やすだけ（企画書4.1.1）。
 *  - CTB: 素早さで持ち点が溜まり閾値超で行動 → 手数が変わる。逓減で 2倍速≠2倍手数。
 *  - 呪文はエンジンが定石で自動判断（企画書4.2）。数値はすべて仮（formulas.ts / M2 で調整）。
 */

import type {
  BattleEvent,
  BattleInput,
  BattleResult,
  CharacterBuild,
  Combatant,
  SideId,
  SpellLineKey,
  StatKey,
} from './schema.ts';
import {
  ARMORS,
  CONFIG,
  maxHP,
  maxMP,
  SHIELDS,
  sleepChance,
  spellTier,
  WEAPONS,
} from './formulas.ts';
import { Rng } from './rng.ts';

const UNARMED_MULT = 1.0;

interface Buff {
  stat: StatKey;
  amount: number;
  remaining: number; // 残り行動回数（CTB 軽量版＝時間でなく回数で数える）
}

/** 戦闘中の内部状態（build から解決した値＋動的な値） */
interface CState {
  id: string;
  side: SideId;
  build: CharacterBuild;
  weaponId: string | null;
  weaponMult: number;
  armorDef: number; // 鎧＋盾の物理軽減合計
  maxHp: number;
  maxMp: number;
  baseSpd: number; // 装備ペナルティ適用後
  hp: number;
  mp: number;
  gauge: number;
  alive: boolean;
  actionsTaken: number;
  sleepRemaining: number; // 0 = 起きている
  sleepApplyCount: number; // 再睡眠の逓減用
  buffs: Buff[];
}

type Action =
  | { kind: 'attack' }
  | { kind: 'fire'; tier: number }
  | { kind: 'cure'; tier: number }
  | { kind: 'sleep'; tier: number }
  | { kind: 'strength'; tier: number };

function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

function initState(c: Combatant): CState {
  const eq = c.build.equipment;
  const w = eq.weapon ? WEAPONS[eq.weapon] : undefined;
  const a = eq.armor ? ARMORS[eq.armor] : undefined;
  const s = eq.shield ? SHIELDS[eq.shield] : undefined;
  const spdPenalty = (w?.spdPenalty ?? 0) + (a?.spdPenalty ?? 0);
  const mhp = maxHP(c.build.stats.vit);
  const mmp = maxMP(c.build.stats.mag);
  // M5: 開始 HP/MP（未指定＝満タン）。派遣の体力ループで前戦の残量を持ち越す（企画書3.3）。
  const startHp = clamp(c.startHp ?? mhp, 0, mhp);
  const startMp = clamp(c.startMp ?? mmp, 0, mmp);
  return {
    id: c.id,
    side: c.side,
    build: c.build,
    weaponId: w?.id ?? null,
    weaponMult: w?.powMult ?? UNARMED_MULT,
    armorDef: (a?.physDef ?? 0) + (s?.physDef ?? 0),
    maxHp: mhp,
    maxMp: mmp,
    baseSpd: Math.max(1, c.build.stats.spd - spdPenalty),
    hp: startHp,
    mp: startMp,
    gauge: 0,
    alive: startHp > 0,
    actionsTaken: 0,
    sleepRemaining: 0,
    sleepApplyCount: 0,
    buffs: [],
  };
}

/** 持ち点/tick の増分。逓減（sqrt）で 2倍速≠2倍手数（企画書4.1.1） */
function gaugeGain(c: CState): number {
  return CONFIG.ctb.gainBase * Math.pow(c.baseSpd, CONFIG.ctb.speedExponent);
}

/** バフ込みの実効・力 */
function effectivePow(c: CState): number {
  let p = c.build.stats.pow;
  for (const b of c.buffs) if (b.stat === 'pow') p += b.amount;
  return p;
}

/** 行動の頭でバフの持続を1減らし、切れたら除去 */
function expireBuffs(c: CState): void {
  if (c.buffs.length === 0) return;
  for (const b of c.buffs) b.remaining -= 1;
  c.buffs = c.buffs.filter((b) => b.remaining > 0);
}

/** 自動判断 AI の定石（企画書4.2）: 回復 > 開幕バフ > 眠り > 攻撃魔法 > 物理フォールバック */
function chooseAction(self: CState, enemy: CState): Action {
  const lines = self.build.spellLines;
  const fireT = spellTier(lines.fire);
  const cureT = spellTier(lines.cure);
  const sleepT = spellTier(lines.sleep);
  const strT = spellTier(lines.strength);

  // 1. HP が閾値未満 → 回復
  if (cureT >= 1 && self.mp >= CONFIG.mpCost.cure && self.hp < self.maxHp * CONFIG.ai.healHpThreshold) {
    return { kind: 'cure', tier: cureT };
  }
  // 2. 開幕 → バフ（まだ pow バフが無いとき）
  if (
    self.actionsTaken < CONFIG.ai.openingBuffTurns &&
    strT >= 1 &&
    self.mp >= CONFIG.mpCost.strength &&
    !self.buffs.some((b) => b.stat === 'pow')
  ) {
    return { kind: 'strength', tier: strT };
  }
  // 3. 相手が起きている → 眠り（アップセット装置）
  if (sleepT >= 1 && self.mp >= CONFIG.mpCost.sleep && enemy.sleepRemaining <= 0) {
    return { kind: 'sleep', tier: sleepT };
  }
  // 4. 攻撃魔法
  if (fireT >= 1 && self.mp >= CONFIG.mpCost.fire) {
    return { kind: 'fire', tier: fireT };
  }
  // 5. 物理フォールバック（MP 切れ・非魔法型の基本行動）
  return { kind: 'attack' };
}

/** ダメージ適用後の共通処理: 撃破 or 被弾で覚醒（企画書4.2） */
function afterDamage(target: CState, t: number, log: BattleEvent[]): void {
  if (target.hp <= 0) {
    target.alive = false;
    log.push({ type: 'ko', t, target: target.id });
    return;
  }
  if (target.sleepRemaining > 0 && CONFIG.sleep.wakeOnHit) {
    target.sleepRemaining = 0;
    log.push({ type: 'status_wake', t, target: target.id, status: 'sleep', reason: 'hit' });
  }
}

function resolve(action: Action, self: CState, enemy: CState, rng: Rng, log: BattleEvent[], t: number): void {
  switch (action.kind) {
    case 'attack': {
      // 素早さ差で回避（物理のみ・控えめ・企画書4.1）
      const evade = clamp(
        (enemy.baseSpd - self.baseSpd) * CONFIG.physical.evadePerSpdDiff,
        0,
        CONFIG.physical.evadeMaxPct,
      );
      if (rng.chance(evade)) {
        log.push({ type: 'miss', t, actor: self.id, target: enemy.id, reason: 'evade' });
        break;
      }
      let dmg = effectivePow(self) * self.weaponMult - enemy.armorDef;
      dmg = Math.max(CONFIG.physical.minDamage, dmg);
      const crit = rng.chance(CONFIG.physical.critChance);
      if (crit) dmg *= CONFIG.physical.critMult;
      dmg *= rng.variance(CONFIG.physical.variancePct);
      dmg = Math.max(CONFIG.physical.minDamage, Math.round(dmg));
      enemy.hp -= dmg;
      log.push({
        type: 'attack',
        t,
        actor: self.id,
        target: enemy.id,
        weapon: self.weaponId,
        damage: dmg,
        crit,
        hpAfter: Math.max(0, enemy.hp),
      });
      afterDamage(enemy, t, log);
      break;
    }
    case 'fire': {
      self.mp -= CONFIG.mpCost.fire;
      log.push({ type: 'cast', t, actor: self.id, spell: 'fire', tier: action.tier, mpAfter: self.mp });
      const base = action.tier * CONFIG.magic.fireBasePerTier;
      // 魔法ダメージ = 基本 + 術者魔力 − 受け手魔力（下限あり・回避不可・企画書3.5.1/4.2）
      let dmg = base + self.build.stats.mag * CONFIG.magic.magAtkScaling -
        enemy.build.stats.mag * CONFIG.magic.magDefScaling;
      dmg = Math.max(base * CONFIG.magic.floorPct, dmg);
      dmg += enemy.maxHp * CONFIG.magic.maxHpPctPerTier * action.tier; // %最大HP成分（仮0）
      dmg *= rng.variance(CONFIG.magic.variancePct);
      dmg = Math.max(1, Math.round(dmg));
      enemy.hp -= dmg;
      log.push({
        type: 'damage',
        t,
        actor: self.id,
        target: enemy.id,
        amount: dmg,
        kind: 'magic',
        crit: false,
        hpAfter: Math.max(0, enemy.hp),
      });
      afterDamage(enemy, t, log);
      break;
    }
    case 'cure': {
      self.mp -= CONFIG.mpCost.cure;
      log.push({ type: 'cast', t, actor: self.id, spell: 'cure', tier: action.tier, mpAfter: self.mp });
      const heal = Math.round(
        action.tier * CONFIG.cure.healBasePerTier + self.build.stats.mag * CONFIG.cure.magScaling,
      );
      const before = self.hp;
      self.hp = Math.min(self.maxHp, self.hp + heal);
      log.push({ type: 'heal', t, actor: self.id, target: self.id, amount: self.hp - before, hpAfter: self.hp });
      break;
    }
    case 'strength': {
      self.mp -= CONFIG.mpCost.strength;
      log.push({ type: 'cast', t, actor: self.id, spell: 'strength', tier: action.tier, mpAfter: self.mp });
      const amount = action.tier * CONFIG.strength.powBonusPerTier;
      self.buffs.push({ stat: 'pow', amount, remaining: CONFIG.strength.duration });
      log.push({
        type: 'buff',
        t,
        actor: self.id,
        target: self.id,
        stat: 'pow',
        amount,
        duration: CONFIG.strength.duration,
      });
      break;
    }
    case 'sleep': {
      self.mp -= CONFIG.mpCost.sleep;
      log.push({ type: 'cast', t, actor: self.id, spell: 'sleep', tier: action.tier, mpAfter: self.mp });
      // 成功率 = 魔力(攻) vs 精神(防)・0/100%にしない（企画書4.2）
      const success = rng.chance(sleepChance(self.build.stats.mag, enemy.build.stats.men));
      let duration = 0;
      if (success) {
        const reduction = Math.floor(enemy.sleepApplyCount * CONFIG.sleep.resistGrowthPerApply);
        duration = Math.max(1, CONFIG.sleep.baseDuration - reduction); // 再睡眠に逓減
        enemy.sleepRemaining = duration;
        enemy.sleepApplyCount += 1;
      }
      log.push({ type: 'status_apply', t, actor: self.id, target: enemy.id, status: 'sleep', success, duration });
      break;
    }
  }
  self.actionsTaken += 1;
}

/** 決定論戦闘エンジン本体 */
export function battle(input: BattleInput): BattleResult {
  const rng = new Rng(input.seed);
  const combatants: CState[] = [...input.teamA, ...input.teamB].map(initState);
  const log: BattleEvent[] = [];

  const teamAlive = (side: SideId): number => combatants.filter((c) => c.side === side && c.alive).length;
  const firstAliveEnemy = (self: CState): CState | undefined =>
    combatants.find((c) => c.alive && c.side !== self.side);

  log.push({
    type: 'battle_start',
    t: 0,
    teamA: input.teamA.map((c) => c.id),
    teamB: input.teamB.map((c) => c.id),
    fighters: combatants.map((c) => ({ id: c.id, side: c.side, maxHp: c.maxHp })),
    seed: input.seed,
  });

  let tick = 0;
  let turns = 0;
  const tickCap = CONFIG.limits.maxTurns * 30; // 絶対安全弁（全員睡眠等の空回り対策）

  while (turns < CONFIG.limits.maxTurns && tick < tickCap) {
    if (teamAlive('A') === 0 || teamAlive('B') === 0) break;
    tick += 1;

    // 全生存者に持ち点を加算
    for (const c of combatants) if (c.alive) c.gauge += gaugeGain(c);

    // 閾値超のうち持ち点最大が行動（同値は 素早さ → id で決定論タイブレーク）
    const ready = combatants.filter((c) => c.alive && c.gauge >= CONFIG.ctb.threshold);
    if (ready.length === 0) continue;
    ready.sort((a, b) => b.gauge - a.gauge || b.baseSpd - a.baseSpd || (a.id < b.id ? -1 : 1));
    const actor = ready[0];
    actor.gauge -= CONFIG.ctb.threshold;

    log.push({ type: 'gauge_ready', t: tick, actor: actor.id });
    expireBuffs(actor);

    // 睡眠中は行動できない（持続を1消費・切れたら覚醒）
    if (actor.sleepRemaining > 0) {
      actor.sleepRemaining -= 1;
      if (actor.sleepRemaining <= 0) {
        log.push({ type: 'status_wake', t: tick, target: actor.id, status: 'sleep', reason: 'expired' });
      }
      continue;
    }

    const enemy = firstAliveEnemy(actor);
    if (!enemy) break;
    turns += 1;
    resolve(chooseAction(actor, enemy), actor, enemy, rng, log, tick);
  }

  const aAlive = teamAlive('A') > 0;
  const bAlive = teamAlive('B') > 0;
  const winner: SideId | 'draw' = aAlive && !bAlive ? 'A' : bAlive && !aAlive ? 'B' : 'draw';
  log.push({ type: 'battle_end', t: tick, winner, seed: input.seed });

  // M5: 終了時の各戦闘者の HP/MP（派遣が次戦へ持ち越すために読む・企画書3.3）
  const endState = combatants.map((c) => ({
    id: c.id,
    side: c.side,
    hp: Math.max(0, c.hp),
    mp: c.mp,
    alive: c.alive,
  }));

  return { winner, seed: input.seed, turns, eventLog: log, endState };
}

/** 1v1 の便利ラッパー（ハーネス/テスト用） */
export function battle1v1(a: CharacterBuild, b: CharacterBuild, seed: number): BattleResult {
  return battle({
    teamA: [{ id: a.characterId, side: 'A', build: a }],
    teamB: [{ id: b.characterId, side: 'B', build: b }],
    seed,
  });
}

/** SpellLineKey を明示 export（外部でライン名を型安全に扱う用） */
export type { SpellLineKey };
