/**
 * M6: 個人戦バッチ大会 — 決定論の大会進行（企画書5章 / 13.5 / 実装プラン M6）。
 *
 *   予選（総当たりリーグ）→ 決勝（単純トーナメント）→ 昇降格。
 *
 * 特性:
 *  - 純粋関数（battle() を対戦カードで再利用＝"戦闘エンジンは1回だけ実装"／実装プラン13.1）。
 *  - 各試合のシードは deriveSeed(seasonSeed, roundKey, matchIndex) で独立導出。
 *    → 任意のカードを単独で再計算でき、再実行しても同結果＝冪等バッチ（M6.3）の土台（企画書13.5）。
 *  - 決定論: 同 (entrants, seed) → 同 SeasonResult（記録すれば再現・検証・観戦再生）。
 *
 * バッチ（M6.3）はここを 1ラウンド/日 で刻んで呼ぶ（league.rounds[day] を確定 → 保存 → 順位更新）。
 * runSeason() は総当たり検証・balance・demo 用に「1シーズンを一括計算」する合成。
 *
 * ★勝点・決勝枠・昇降格数はすべて仮（formulas.TOURNAMENT）。launch 後 9章 live-ops で調整。
 */

import type {
  BracketMatch,
  BracketResult,
  CharacterBuild,
  LeagueResult,
  MatchOutcome,
  MatchPairing,
  PromotionResult,
  SeasonResult,
  Standing,
  TournamentEntrant,
} from './schema.ts';
import { battle } from './battle.ts';
import { TOURNAMENT } from './formulas.ts';
import { deriveSeed } from './rng.ts';

const BYE = '__bye__';

// ────────────────────────────────────────────────────────────
// 予選: 総当たりの対戦カード（circle method・決定論）
//   奇数人はダミー(BYE)を1枠足して、当たった人はその日「不戦」＝カードを出さない。
//   返り値は「ラウンドの配列」＝バッチはこれを 1ラウンド/日 で処理する（企画書13.5）。
// ────────────────────────────────────────────────────────────
export function roundRobinRounds(ids: string[]): MatchPairing[][] {
  const players = ids.slice();
  if (players.length < 2) return [];
  if (players.length % 2 === 1) players.push(BYE); // 奇数 → 不戦枠
  const n = players.length;

  // 0 番を固定し残りを回す（標準の circle method）＝各人が他全員と1回ずつ当たる
  const arr = players.slice();
  const rounds: MatchPairing[][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairings: MatchPairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== BYE && b !== BYE) pairings.push({ a, b }); // 不戦は落とす
    }
    rounds.push(pairings);
    // 先頭を固定し、残りを時計回りに1つ回す
    const rest = arr.slice(1);
    rest.unshift(rest.pop() as string);
    for (let i = 1; i < n; i++) arr[i] = rest[i - 1];
  }
  return rounds;
}

// ────────────────────────────────────────────────────────────
// 1カードを battle() で解決（決定論）。DB matches 1行にそのまま落ちる形。
// ────────────────────────────────────────────────────────────
export function playMatch(
  seasonSeed: number,
  roundKey: string | number,
  matchIndex: number,
  builds: Map<string, CharacterBuild>,
  pairing: MatchPairing,
): MatchOutcome {
  const seed = deriveSeed(seasonSeed, roundKey, matchIndex);
  const a = builds.get(pairing.a);
  const b = builds.get(pairing.b);
  if (!a || !b) throw new Error(`未知の出場者: ${pairing.a} / ${pairing.b}`);

  const result = battle({
    teamA: [{ id: pairing.a, side: 'A', build: a }],
    teamB: [{ id: pairing.b, side: 'B', build: b }],
    seed,
  });
  const winnerId = result.winner === 'A' ? pairing.a : result.winner === 'B' ? pairing.b : null;
  return {
    a: pairing.a,
    b: pairing.b,
    seed,
    winner: result.winner,
    winnerId,
    turns: result.turns,
    eventLog: result.eventLog,
  };
}

function buildMap(entrants: TournamentEntrant[]): Map<string, CharacterBuild> {
  return new Map(entrants.map((e) => [e.id, e.build]));
}

// ────────────────────────────────────────────────────────────
// 順位表（勝点集計 → ランク付け）。
//   タイブレーク: 勝点 → 勝数 → 敗数少 → deriveSeed(seasonSeed, id)。
//   最後のキーで「id のアルファベット順による系統的な有利」を排除（M2 のミラー公平性と同じ精神）。
// ────────────────────────────────────────────────────────────
export function tallyStandings(
  ids: string[],
  outcomes: MatchOutcome[],
  seasonSeed: number,
): Standing[] {
  const table = new Map<string, Standing>();
  for (const id of ids) {
    table.set(id, { id, wins: 0, losses: 0, draws: 0, points: 0, rank: 0 });
  }
  for (const o of outcomes) {
    const a = table.get(o.a);
    const b = table.get(o.b);
    if (!a || !b) continue;
    if (o.winner === 'draw') {
      a.draws++;
      b.draws++;
      a.points += TOURNAMENT.pointsDraw;
      b.points += TOURNAMENT.pointsDraw;
    } else if (o.winner === 'A') {
      a.wins++;
      b.losses++;
      a.points += TOURNAMENT.pointsWin;
      b.points += TOURNAMENT.pointsLoss;
    } else {
      b.wins++;
      a.losses++;
      b.points += TOURNAMENT.pointsWin;
      a.points += TOURNAMENT.pointsLoss;
    }
  }

  const rows = [...table.values()];
  rows.sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (x.losses !== y.losses) return x.losses - y.losses;
    return deriveSeed(seasonSeed, x.id) - deriveSeed(seasonSeed, y.id); // 決定論・非アルファベット
  });
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

/** 予選リーグ（総当たり）を最後まで回して順位表を出す（一括計算・検証/demo 用）。 */
export function runLeague(entrants: TournamentEntrant[], seasonSeed: number): LeagueResult {
  const ids = entrants.map((e) => e.id);
  const builds = buildMap(entrants);
  const schedule = roundRobinRounds(ids);

  const rounds: MatchOutcome[][] = schedule.map((pairings, roundIdx) =>
    pairings.map((p, matchIdx) => playMatch(seasonSeed, `L${roundIdx}`, matchIdx, builds, p))
  );
  const standings = tallyStandings(ids, rounds.flat(), seasonSeed);
  return { rounds, standings };
}

// ────────────────────────────────────────────────────────────
// 決勝トーナメント（単純シングルイリミネーション）。
//   予選順位＝シード順。標準シード配置（1位と2位は決勝でしか当たらない）。
//   引き分けは「上位シードが進出」で決着（トーナメントは決着が要る／決定論）。
// ────────────────────────────────────────────────────────────

/** 2の冪 size のブラケット位置に並べるシード index の順（1位が最も楽な山）。 */
function bracketSeedOrder(size: number): number[] {
  let order = [0, 1];
  while (order.length < size) {
    const total = order.length * 2;
    const next: number[] = [];
    for (const s of order) {
      next.push(s);
      next.push(total - 1 - s);
    }
    order = next;
  }
  return order;
}

/** size 以下の最大の2の冪（4→4, 5→4, 3→2）。 */
function largestPow2AtMost(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/**
 * 上位シードから単純トーナメントを実施。
 * @param seededIds 予選順位で並んだ id 列（先頭が1位）
 * @param seasonSeed シード（各試合の seed 導出）
 * @param size 決勝枠（2の冪へ丸める。参加者がそれ未満なら更に丸める）
 */
export function runBracket(
  seededIds: string[],
  builds: Map<string, CharacterBuild>,
  seasonSeed: number,
  size: number = TOURNAMENT.bracketSize,
): BracketResult | null {
  const cap = largestPow2AtMost(Math.min(size, seededIds.length));
  if (cap < 2) return null; // 2人未満は決勝なし

  const seeds = seededIds.slice(0, cap); // 上位 cap 人が進出
  const seedRank = new Map(seeds.map((id, i) => [id, i])); // 小さいほど上位
  const order = bracketSeedOrder(cap);
  let alive = order.map((seedIdx) => seeds[seedIdx]); // ブラケット位置順の id 列

  const matches: BracketMatch[] = [];
  let round = 0;
  while (alive.length > 1) {
    const winners: string[] = [];
    for (let i = 0; i < alive.length; i += 2) {
      const slot = i / 2;
      const outcome = playMatch(seasonSeed, `B${round}`, slot, builds, {
        a: alive[i],
        b: alive[i + 1],
      });
      // 引き分けは上位シードが進出（決定論・トーナメントは決着必須）
      let winnerId = outcome.winnerId;
      if (winnerId === null) {
        const ra = seedRank.get(alive[i]) as number;
        const rb = seedRank.get(alive[i + 1]) as number;
        winnerId = ra <= rb ? alive[i] : alive[i + 1];
      }
      matches.push({ round, slot, outcome });
      winners.push(winnerId);
    }
    alive = winners;
    round++;
  }
  return { seeds, matches, championId: alive[0] };
}

// ────────────────────────────────────────────────────────────
// 昇降格（企画書5.2 J1/J2 ラダー）。予選順位から上位が昇格・下位が降格。
//   出場者が少なく昇格枠と降格枠が重なる場合は「昇格を優先」して重複を排除。
// ────────────────────────────────────────────────────────────
export function promotionRelegation(
  standings: Standing[],
  promoteCount: number = TOURNAMENT.promoteCount,
  relegateCount: number = TOURNAMENT.relegateCount,
): PromotionResult {
  const ordered = [...standings].sort((a, b) => a.rank - b.rank).map((s) => s.id);
  const n = ordered.length;
  const promote = ordered.slice(0, Math.max(0, Math.min(promoteCount, n)));
  const promoteSet = new Set(promote);
  // 降格は下位から。昇格と被る（人数が少ない）分は除く＝昇格優先
  const relegate: string[] = [];
  for (let i = n - 1; i >= 0 && relegate.length < relegateCount; i--) {
    const id = ordered[i];
    if (!promoteSet.has(id)) relegate.push(id);
  }
  const moved = new Set([...promote, ...relegate]);
  const stay = ordered.filter((id) => !moved.has(id));
  return { promote, relegate, stay };
}

// ────────────────────────────────────────────────────────────
// 1シーズン一括（予選 → 決勝 → 昇降格）。1シードから完全再現（検証/balance/demo）。
// ────────────────────────────────────────────────────────────
export function runSeason(entrants: TournamentEntrant[], seasonSeed: number): SeasonResult {
  const builds = buildMap(entrants);
  const league = runLeague(entrants, seasonSeed);
  const seededIds = league.standings.map((s) => s.id); // 予選順位＝シード順
  const bracket = runBracket(seededIds, builds, seasonSeed);
  const promotion = promotionRelegation(league.standings);
  return {
    seed: seasonSeed,
    league,
    bracket,
    championId: bracket ? bracket.championId : (seededIds[0] ?? null),
    promotion,
  };
}
