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
// アイテム（消耗品・回復薬／企画書3.3）
//   装備と同じ「型はここ / 実データ（仮カタログ）は formulas.ts の ITEMS」。
//   装備と違い消耗品なので、所持は個数（DB player_items.quantity）で持つ。
//   effect.pct = 最大値に対する回復割合（0.10=10% / 1.0=全回復）。
// ────────────────────────────────────────────────────────────
export type ItemEffectKind = 'hp' | 'mp' | 'both'; // hp=HP回復 / mp=MP回復 / both=両方

export interface ItemDef {
  id: string;
  name: string;
  effect: { kind: ItemEffectKind; pct: number };
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
  /**
   * M5: 開始 HP（未指定＝満タン maxHP）。派遣ダンジョンの体力ループで
   * 前の戦闘で削れた HP を次戦へ持ち越すのに使う（企画書3.3・"体力0で強制帰還"）。
   */
  startHp?: number;
  /** M5: 開始 MP（未指定＝満タン maxMP）。cure が MP を食い切るまで潜れる（企画書4.2 uptime）。 */
  startMp?: number;
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
  /**
   * M5: 終了時の各戦闘者の状態。派遣ダンジョンが HP/MP を次戦へ持ち越すために読む
   * （企画書3.3 体力ループ）。再生には不要（eventLog が正本）だが dive() の連結に必要。
   */
  endState: CombatantEndState[];
}

export interface CombatantEndState {
  id: string;
  side: SideId;
  hp: number; // 0..maxHP（0 = 撃破）
  mp: number; // 0..maxMP
  alive: boolean;
}

/** 決定論戦闘エンジンの署名（M1 で実装） */
export type BattleFn = (input: BattleInput) => BattleResult;

// ────────────────────────────────────────────────────────────
// M5: 派遣ダンジョン（dive）契約（企画書3.3 / 実装プラン M5）
//   dive(hero, dungeon, seed, minutes) → DiveResult
//   battle() を敵連戦で再利用。HP/MP を試合間で持ち越す（体力ループ）。
//   ・体力0 で強制帰還（endReason='ko'）／指定時間まで戦って時間切れ（'time'）
//   ・勝利ごとに XP/ゴールド、確率でドロップ（サーバー計算・非同期・企画書3.3.1）
// ────────────────────────────────────────────────────────────
// ドロップは装備・アイテム両対応のタグ付き参照（kind で入手先テーブルを振り分け）
export type DropKind = 'equipment' | 'item';

/** ドロップ1件の参照（DiveResult に載る / applyRewards が kind でテーブルを振り分ける）。 */
export interface DropRef {
  kind: DropKind; // equipment=player_equipment / item=player_items
  id: string; // equipment_catalog.id または item_catalog.id
}

export interface DropEntry {
  kind: DropKind; // equipment=装備ドロップ / item=アイテムドロップ
  id: string; // WeaponDef/ArmorDef/ShieldDef の id、または ItemDef の id
  weight: number; // 重み付き抽選（相対）
}

// 遭遇（エンカウント）テーブル: そのダンジョンに「どの敵が」「どの重みで」出るか（ドロップ表と同型）。
//   敵の正本は DB enemy_catalog（完全DB管理）。Edge Function が行から build を組んでここに載せる。
export interface EncounterEntry {
  build: CharacterBuild; // 敵1体のビルド（characterId = enemy_catalog.id）
  weight: number; // 重み付き抽選（相対）
}

/** dive() の入力ダンジョン（DB dungeons 行の engine 側ビュー）。 */
export interface DungeonDef {
  slug: string;
  difficulty: number; // 報酬レートのスケール（敵の強さは encounterTable が決める）
  dropTable: DropEntry[];
  encounterTable: EncounterEntry[]; // 出現する敵と重み（空なら敵なし＝即帰還）
}

export type DiveEndReason = 'time' | 'ko';

/** 1戦ぶんの結果サマリ（帰還後の明細表示・報酬内訳／再生は matches 側） */
export interface DiveBattleSummary {
  index: number;
  winner: SideId | 'draw';
  won: boolean; // hero(side A) が勝ったか
  enemyId: string;
  xp: number;
  gold: number;
  drop: DropRef | null; // ドロップ（装備 or アイテム。無し=null）
  hpAfter: number; // この戦闘後の hero HP（次戦へ持ち越す値）
  mpAfter: number;
  minutesElapsed: number; // 派遣開始からの累計（分）
}

export interface DiveResult {
  dungeonSlug: string;
  seed: number;
  battles: DiveBattleSummary[];
  totalXp: number;
  totalGold: number;
  drops: DropRef[]; // 装備・アイテムのドロップ（applyRewards が kind で振り分ける）
  hpRemaining: number; // 帰還時の HP（自然回復の起点）
  mpRemaining: number;
  minutesElapsed: number;
  endReason: DiveEndReason;
}

// ────────────────────────────────────────────────────────────
// M6: 個人戦バッチ大会（企画書5章 / 13.5 / 実装プラン M6）
//   シーズン = 予選（総当たりリーグ）→ 決勝（単純トーナメント）→ 昇降格。
//   すべて battle() を再利用した決定論の純粋関数（"戦闘エンジンは1回だけ実装"）。
//   バッチ（M6.3）は 1ラウンド/日 で回すため、各試合のシードは
//   (seasonSeed, roundKey, matchIndex) から独立に導出（deriveSeed）＝冪等・再現可。
// ────────────────────────────────────────────────────────────

/** 大会の出場者（DB: characters.id + その時点のビルド。engine はビルドしか要らない）。 */
export interface TournamentEntrant {
  id: string;
  build: CharacterBuild;
}

/** 対戦カード（side A = a / side B = b）。バッチはこれを1件 = matches 1行に落とす。 */
export interface MatchPairing {
  a: string; // entrant id（side A）
  b: string; // entrant id（side B）
}

/** 1カードの結果（DB matches 行の engine 側ビュー。eventLog はそのまま保存＝再生の正本）。 */
export interface MatchOutcome {
  a: string;
  b: string;
  seed: number;
  winner: SideId | 'draw'; // 'A' = a の勝ち / 'B' = b の勝ち
  winnerId: string | null; // 勝者の entrant id（引き分け = null）
  turns: number;
  eventLog: BattleEvent[];
}

/** 順位表の1行（企画書5.2 の対戦帯内順位）。 */
export interface Standing {
  id: string;
  wins: number;
  losses: number;
  draws: number;
  points: number; // TOURNAMENT.pointsWin/Draw/Loss
  rank: number; // 1 始まり（1 = 首位）
}

/** 予選リーグ（総当たり）1シーズンぶん。rounds は 1ラウンド/日 でバッチが処理する単位。 */
export interface LeagueResult {
  rounds: MatchOutcome[][];
  standings: Standing[]; // rank 昇順（首位が先頭）
}

/** 決勝トーナメントの1試合（round=0 が初戦・slot=ブラケット位置）。 */
export interface BracketMatch {
  round: number;
  slot: number;
  outcome: MatchOutcome;
}

/** 決勝トーナメント（単純シングルイリミネーション）。 */
export interface BracketResult {
  seeds: string[]; // 出場者（予選順位＝シード順）
  matches: BracketMatch[];
  championId: string;
}

/** 昇降格の判定結果（企画書5.2 J1/J2 ラダー）。 */
export interface PromotionResult {
  promote: string[]; // 上位ディビジョンへ
  relegate: string[]; // 下位ディビジョンへ
  stay: string[];
}

/** 1シーズン総合（予選 → 決勝 → 昇降格）。1シードから完全再現。 */
export interface SeasonResult {
  seed: number;
  league: LeagueResult;
  bracket: BracketResult | null; // 出場者 2 未満なら null
  championId: string | null;
  promotion: PromotionResult;
}

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
