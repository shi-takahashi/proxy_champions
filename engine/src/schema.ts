/**
 * M0: 契約の"正本" — ビルド入力 + eventLog + 型定義。
 *
 * engine / DB / Flutter が参照する共通契約（企画書13.1 / 実装プラン M0）。
 * ここは「型と形」だけ。具体数値（仮値）は formulas.ts に置く。
 *
 * 継ぎ目:
 *  - engine → Edge Function : 同一 TS ソースを import（実装プラン 3.2 継ぎ目①）
 *  - engine ↔ Flutter       : この型を app/lib/models に手でミラー（継ぎ目②・線を越えるのは JSON）
 */

// ────────────────────────────────────────────────────────────
// 基本5ステ（企画書3.5.1・1プールから配分・同スケール）
// ────────────────────────────────────────────────────────────
export type StatKey = 'vit' | 'mag' | 'pow' | 'spd' | 'men';

export interface Stats {
  /** 体力（フィジカル） → 最大HP（formulas.hpPerVit）。%最大HP魔法のブレーキも兼ねる */
  vit: number;
  /** 魔力（マジック） → 最大MP＋魔法威力＋受ける魔法ダメージ軽減（魔力vs魔力）＋状態異常成功率 */
  mag: number;
  /** 力（パワー） → 物理攻撃（力×武器） */
  pow: number;
  /** 素早さ（スピード） → CTB持ち点の溜まり（手数）＋物理回避（魔法は躱せない） */
  spd: number;
  /** 精神（メンタル） → 状態異常耐性のみ（魔力vs精神）。魔法ダメージは防げない */
  men: number;
}

// ────────────────────────────────────────────────────────────
// 魔法ライン修行値（企画書3.5.2・同じ1プールから配分）
// 威力は投資量で連続アップ、節目で上位 Tier。Tier = floor(value / 10)
// ────────────────────────────────────────────────────────────
export type SpellLineKey = 'fire' | 'cure' | 'sleep' | 'strength';
export type SpellLines = Record<SpellLineKey, number>;

// ────────────────────────────────────────────────────────────
// 装備（企画書3.6・ゴールド軸＝横の"型"。「+強い」でなく型）
// 型定義はここ / 実データ（仮カタログ）は formulas.ts の WEAPONS/ARMORS/SHIELDS
// ────────────────────────────────────────────────────────────
export type WeaponKind = 'physical' | 'magic';

export interface WeaponDef {
  id: string;
  name: string;
  kind: WeaponKind;
  /** 物理攻撃 = pow × powMult（magic 武器は弱い物理フォールバック＝低 powMult） */
  powMult: number;
  /** 重い武器ほど素早さにペナルティ（手数減）＝横の型のトレードオフ */
  spdPenalty: number;
}

export interface ArmorDef {
  id: string;
  name: string;
  /** 物理ダメージ軽減（守備ステ廃止 → 物理防御は装備が担う・企画書3.5.1） */
  physDef: number;
  /** 重装＝物理に強いが手数減（軽装＝別の型） */
  spdPenalty: number;
}

export interface ShieldDef {
  id: string;
  name: string;
  physDef: number;
}

export interface EquipmentLoadout {
  weapon: string | null; // WeaponDef.id（null=素手フォールバック）
  armor: string | null; // ArmorDef.id
  shield: string | null; // ShieldDef.id
}

// ────────────────────────────────────────────────────────────
// キャラのビルド（＝DB保存形・Flutter入力形・battle() 入力の"正本"）
// ────────────────────────────────────────────────────────────
export interface CharacterBuild {
  characterId: string;
  level: number;
  stats: Stats;
  spellLines: SpellLines;
  equipment: EquipmentLoadout;
}

// ────────────────────────────────────────────────────────────
// 戦闘参加者（engine は「リスト対リスト」で書く・企画書4.1.1）
// 1v1 は各チーム要素1。団体戦(3v3・8章)は要素を増やすだけ＝無改修拡張。
// ────────────────────────────────────────────────────────────
export type SideId = 'A' | 'B';

export interface Combatant {
  /** 隊列/識別用の一意 ID（1v1 でも一意。将来の隊列=前衛/後衛もこの層に載る） */
  id: string;
  side: SideId;
  build: CharacterBuild;
}

// ────────────────────────────────────────────────────────────
// battle() 入力/出力（署名: (input) => BattleResult）
// ────────────────────────────────────────────────────────────
export interface BattleInput {
  teamA: Combatant[];
  teamB: Combatant[];
  /** 試合ごとに新規発行→毎試合違う結果／記録すれば再現・検証・再生（企画書4.1.2/13.4） */
  seed: number;
}

export interface BattleResult {
  winner: SideId | 'draw'; // draw = ターン上限到達（膠着防止・企画書4.2）
  seed: number;
  turns: number;
  eventLog: BattleEvent[];
}

/** 決定論戦闘エンジンの署名（M1 で実装） */
export type BattleFn = (input: BattleInput) => BattleResult;

// ────────────────────────────────────────────────────────────
// 状態異常（MVPは sleep のみ・毒/麻痺は将来拡張／企画書3.5.2）
// ────────────────────────────────────────────────────────────
export type StatusKey = 'sleep';

// ────────────────────────────────────────────────────────────
// eventLog（企画書13.1・Flutter はこれを順に再生するだけ）
// t = CTB 内部時刻/行動カウンタ（企画書4.1.1）
// discriminated union（type で分岐）。全種別が「再生に必要な最小情報」を持つ。
// ────────────────────────────────────────────────────────────
export type DamageKind = 'physical' | 'magic';

export type BattleEvent =
  // 開始・終了（fighters = 再生に必要な各戦闘者の初期情報：id/side/最大HP＝HPバーの分母）
  | {
    type: 'battle_start';
    t: number;
    teamA: string[];
    teamB: string[];
    fighters: { id: string; side: SideId; maxHp: number }[];
    seed: number;
  }
  | { type: 'battle_end'; t: number; winner: SideId | 'draw'; seed: number }
  // 行動権（持ち点が閾値超）
  | { type: 'gauge_ready'; t: number; actor: string }
  // 物理基本攻撃（力×武器・鎧で軽減・素早さで回避）＝原子的。命中はダメージ inline
  | {
    type: 'attack';
    t: number;
    actor: string;
    target: string;
    weapon: string | null;
    damage: number;
    crit: boolean;
    hpAfter: number;
  }
  // 物理の空振り（回避 or 相手が眠りで…は wake 側で表現）
  | { type: 'miss'; t: number; actor: string; target: string; reason: 'evade' }
  // 呪文詠唱（結果は続く damage/heal/buff/status_apply で表現）
  | { type: 'cast'; t: number; actor: string; spell: SpellLineKey; tier: number; mpAfter: number }
  // 魔法ダメージ（Fire等・魔力で軽減・回避不可・%最大HP成分含む）
  | {
    type: 'damage';
    t: number;
    actor: string;
    target: string;
    amount: number;
    kind: DamageKind;
    crit: boolean;
    hpAfter: number;
  }
  // 回復（Cure）
  | { type: 'heal'; t: number; actor: string; target: string; amount: number; hpAfter: number }
  // バフ（Strength 等・自己/味方強化）
  | {
    type: 'buff';
    t: number;
    actor: string;
    target: string;
    stat: StatKey;
    amount: number;
    duration: number;
  }
  // 状態異常付与の試行（成功率=魔力攻 vs 精神防・0/100%にしない）
  | {
    type: 'status_apply';
    t: number;
    actor: string;
    target: string;
    status: StatusKey;
    success: boolean;
    duration: number;
  }
  // 状態異常の解除（持続切れ or 被弾で起きる）
  | { type: 'status_wake'; t: number; target: string; status: StatusKey; reason: 'expired' | 'hit' }
  // 撃破
  | { type: 'ko'; t: number; target: string };
