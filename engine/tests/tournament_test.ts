/**
 * M6: 個人戦バッチ大会（tournament）のテスト。
 *  - 最重要 = 決定論（同 (entrants, seed) → 完全に同じ SeasonResult）。
 *  - 冪等の土台: deriveSeed / playMatch は同カードを何度計算しても同結果（バッチ再実行対策・企画書13.5）。
 *  - 予選の総当たり整合（各人が他全員と1回）／勝点保存／順位付け。
 *  - 決勝トーナメント: 2の冪へ丸め・試合数 = cap-1・チャンピオンは出場者の1人。
 *  - 昇降格: 昇格上位・降格下位・重複なし・件数。
 *  - 設計の創発: 明らかに強いビルドが上位を取る（決定論 sanity）。
 *
 * 依存ゼロ（インライン assert）。
 */

import {
  playMatch,
  promotionRelegation,
  roundRobinRounds,
  runBracket,
  runSeason,
  tallyStandings,
} from '../src/tournament.ts';
import { deriveSeed } from '../src/rng.ts';
import { TOURNAMENT } from '../src/formulas.ts';
import type { CharacterBuild, MatchOutcome, TournamentEntrant } from '../src/schema.ts';

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
  equipment: Partial<CharacterBuild['equipment']> = { weapon: 'sword_iron', armor: 'mail_leather' },
): CharacterBuild {
  return {
    characterId: id,
    level: 20,
    stats,
    spellLines: { fire: 0, cure: 0, sleep: 0, strength: 0 },
    equipment: { weapon: null, armor: null, shield: null, ...equipment },
  };
}

// 実力に段差をつけた6人（強→弱）。id は意図的にアルファベット順と実力順をずらす（タイブレーク公平性検証）。
function roster(): TournamentEntrant[] {
  return [
    { id: 'zeta', build: makeBuild('zeta', { vit: 24, mag: 2, pow: 22, spd: 14, men: 10 }) }, // 最強
    { id: 'echo', build: makeBuild('echo', { vit: 22, mag: 2, pow: 20, spd: 13, men: 9 }) },
    { id: 'alpha', build: makeBuild('alpha', { vit: 20, mag: 2, pow: 18, spd: 12, men: 8 }) },
    { id: 'delta', build: makeBuild('delta', { vit: 18, mag: 2, pow: 16, spd: 11, men: 7 }) },
    { id: 'bravo', build: makeBuild('bravo', { vit: 16, mag: 2, pow: 14, spd: 10, men: 6 }) },
    { id: 'yankee', build: makeBuild('yankee', { vit: 12, mag: 2, pow: 10, spd: 8, men: 5 }) }, // 最弱
  ];
}

// ── 1. 決定論: 同入力は完全一致 ──────────────────────────────
Deno.test('season determinism: 同 (entrants, seed) → 完全に同じ SeasonResult', () => {
  const a = runSeason(roster(), 20260708);
  const b = runSeason(roster(), 20260708);
  assertEquals(a, b, 'SeasonResult 完全一致');
});

// ── 2. deriveSeed / playMatch は冪等（バッチ再実行の土台）─────
Deno.test('deriveSeed は独立再計算で一致・playMatch は同カード同結果（冪等）', () => {
  assertEquals(deriveSeed(999, 'L0', 3), deriveSeed(999, 'L0', 3), 'deriveSeed 再現');
  assert(deriveSeed(999, 'L0', 3) !== deriveSeed(999, 'L0', 4), 'index 違いは別シード');
  assert(deriveSeed(999, 'L0', 3) !== deriveSeed(999, 'L1', 3), 'round 違いは別シード');

  const builds = new Map(roster().map((e) => [e.id, e.build]));
  const p = { a: 'zeta', b: 'yankee' };
  const m1 = playMatch(42, 'L0', 0, builds, p);
  const m2 = playMatch(42, 'L0', 0, builds, p); // 再実行（バッチが同じカードを二度計算）
  assertEquals(m1, m2, '同カードの再計算は同結果（冪等）');
});

// ── 3. 予選: 総当たり（各人が他全員と1回ずつ）───────────────
Deno.test('roundRobin: 各人が他全員と正確に1回ずつ当たる（偶数・奇数）', () => {
  // 偶数6人 → 5ラウンド・各ラウンド3カード・総当たり15カード
  const ids6 = roster().map((e) => e.id);
  const r6 = roundRobinRounds(ids6);
  assertEquals(r6.length, 5, '6人 → 5ラウンド');
  const cards6 = r6.flat();
  assertEquals(cards6.length, 15, '6人総当たり = 15カード');
  const seen = new Map<string, number>();
  for (const c of cards6) {
    const key = [c.a, c.b].sort().join('|');
    seen.set(key, (seen.get(key) ?? 0) + 1);
    assert(c.a !== c.b, '自分自身とは当たらない');
  }
  assertEquals(seen.size, 15, '重複ペアなし（全ペアが1回）');
  for (const [, cnt] of seen) assertEquals(cnt, 1, '各ペア1回');

  // 奇数5人 → 5ラウンド・不戦で各ラウンド2カード・総当たり10カード
  const ids5 = ids6.slice(0, 5);
  const r5 = roundRobinRounds(ids5);
  assertEquals(r5.length, 5, '5人 → 5ラウンド（不戦枠あり）');
  assertEquals(r5.flat().length, 10, '5人総当たり = 10カード');
  const pairs5 = new Set(r5.flat().map((c) => [c.a, c.b].sort().join('|')));
  assertEquals(pairs5.size, 10, '5人全ペア10が1回ずつ');

  assertEquals(roundRobinRounds(['solo']).length, 0, '1人はカード無し');
  assertEquals(roundRobinRounds([]).length, 0, '0人はカード無し');
});

// ── 4. 順位表: 勝点保存・戦績整合 ────────────────────────────
Deno.test('standings: 勝点は保存し、各人の総試合数が一致', () => {
  const entrants = roster();
  const s = runSeason(entrants, 7);
  const st = s.league.standings;
  assertEquals(st.length, entrants.length, '全員が順位表に載る');

  // 各カードは勝敗=3点・引分=2点(1+1) を配る。総勝点 = Σカードの寄与
  const cards = s.league.rounds.flat();
  let expectedPoints = 0;
  for (const c of cards) {
    expectedPoints += c.winner === 'draw'
      ? TOURNAMENT.pointsDraw * 2
      : TOURNAMENT.pointsWin + TOURNAMENT.pointsLoss;
  }
  const actualPoints = st.reduce((sum, r) => sum + r.points, 0);
  assertEquals(actualPoints, expectedPoints, '総勝点はカードから配られた合計と一致');

  // 各人 wins+losses+draws = 対戦数（6人 → 各5試合）
  for (const r of st) {
    assertEquals(r.wins + r.losses + r.draws, entrants.length - 1, `${r.id} は他全員と1回`);
  }
  // rank は 1..N の連番
  const ranks = st.map((r) => r.rank).sort((a, b) => a - b);
  assertEquals(ranks, [1, 2, 3, 4, 5, 6], 'rank は 1..N 連番');
});

// ── 5. タイブレーク公平性: 全員ミラー同一ビルドでもアルファベット順に偏らない ──
Deno.test('standings tiebreak: 同点はアルファベット順に系統的偏りを持たない', () => {
  // 完全同一ビルドの4人 → 総当たりは side バイアスのみで決まる。id 順位付けが a,b,c,d 固定なら偏り。
  const same = (id: string) => ({ id, build: makeBuild(id, { vit: 18, mag: 2, pow: 16, spd: 11, men: 7 }) });
  const ids = ['aaa', 'bbb', 'ccc', 'ddd'];
  // 複数シードで首位の id を集計 → 特定 id（アルファベット先頭）に固定されないこと
  const winners = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const s = runSeason(ids.map(same), seed);
    winners.add(s.league.standings[0].id);
  }
  assert(winners.size >= 2, `首位が複数の id に分散する（アルファベット固定でない）: ${[...winners]}`);
});

// ── 6. 決勝トーナメント: 丸め・試合数・チャンピオン ────────────
Deno.test('bracket: 2の冪へ丸め、試合数 = cap-1、champion は出場者', () => {
  const entrants = roster();
  const builds = new Map(entrants.map((e) => [e.id, e.build]));
  const seeded = entrants.map((e) => e.id); // 6人

  const b4 = runBracket(seeded, builds, 123, 4);
  assert(b4 !== null, '4枠は成立');
  assertEquals(b4!.seeds.length, 4, '上位4人が進出');
  assertEquals(b4!.matches.length, 3, '4人トーナメント = 3試合（2準決+1決勝）');
  assert(b4!.seeds.includes(b4!.championId), 'champion は出場者の1人');

  // 5枠指定でも 4（最大の2の冪）へ丸める
  const b5 = runBracket(seeded, builds, 123, 5);
  assertEquals(b5!.seeds.length, 4, '5枠 → 4へ丸め');

  // 3人しかいなければ 2枠（1試合）
  const b3 = runBracket(seeded.slice(0, 3), builds, 123, 4);
  assertEquals(b3!.seeds.length, 2, '3人 → 2枠');
  assertEquals(b3!.matches.length, 1, '2人 = 1試合');

  // 1人は決勝なし
  assertEquals(runBracket(['solo'], new Map([['solo', makeBuild('solo', { vit: 10, mag: 2, pow: 10, spd: 10, men: 5 })]]), 1, 4), null, '2人未満は null');
});

// ── 7. 昇降格: 上位昇格・下位降格・重複なし ───────────────────
Deno.test('promotion/relegation: 上位が昇格・下位が降格・重複なし', () => {
  const s = runSeason(roster(), 55);
  const st = s.league.standings; // rank 昇順
  const pr = s.promotion;

  assertEquals(pr.promote.length, TOURNAMENT.promoteCount, '昇格枠数');
  assertEquals(pr.relegate.length, TOURNAMENT.relegateCount, '降格枠数');
  // 昇格は上位 rank・降格は下位 rank
  assertEquals(pr.promote, st.slice(0, TOURNAMENT.promoteCount).map((r) => r.id), '昇格は上位から');
  assertEquals(
    new Set(pr.relegate),
    new Set(st.slice(-TOURNAMENT.relegateCount).map((r) => r.id)),
    '降格は下位から',
  );
  // 重複なし・全員がどこかに分類
  const all = [...pr.promote, ...pr.relegate, ...pr.stay];
  assertEquals(new Set(all).size, all.length, 'promote/relegate/stay に重複なし');
  assertEquals(all.length, st.length, '全員が分類される');

  // 出場者が少なく枠が重なる → 昇格優先で重複排除
  const tiny = promotionRelegation(
    [
      { id: 'x', wins: 3, losses: 0, draws: 0, points: 9, rank: 1 },
      { id: 'y', wins: 1, losses: 2, draws: 0, points: 3, rank: 2 },
      { id: 'z', wins: 0, losses: 3, draws: 0, points: 0, rank: 3 },
    ],
    2,
    2,
  );
  const tinyAll = [...tiny.promote, ...tiny.relegate, ...tiny.stay];
  assertEquals(new Set(tinyAll).size, 3, '3人でも重複なく分類（昇格優先）');
  assert(tiny.promote.includes('x'), '首位は昇格');
  assert(!tiny.relegate.includes('x'), '昇格者は同時に降格しない');
});

// ── 8. 設計の創発: 明らかに強いビルドが上位・優勝を取りやすい ──
Deno.test('emergent: 実力差があると強者が上位/優勝を取りやすい（決定論 sanity）', () => {
  // 複数シーズンでチャンピオンと首位を集計 → 最強(zeta)が優位
  let zetaChamp = 0;
  let zetaTop = 0;
  const seeds = [11, 22, 33, 44, 55, 66, 77, 88, 99, 111];
  for (const seed of seeds) {
    const s = runSeason(roster(), seed);
    if (s.championId === 'zeta') zetaChamp++;
    if (s.league.standings[0].id === 'zeta') zetaTop++;
  }
  assert(zetaTop >= seeds.length / 2, `最強は予選首位を過半で取る（${zetaTop}/${seeds.length}）`);
  assert(zetaChamp >= seeds.length / 2, `最強は優勝を過半で取る（${zetaChamp}/${seeds.length}）`);

  // 最弱(yankee)はまず優勝しない
  const yankeeChamp = seeds.filter((seed) => runSeason(roster(), seed).championId === 'yankee').length;
  assert(yankeeChamp <= 1, `最弱はほぼ優勝しない（${yankeeChamp}）`);
});
