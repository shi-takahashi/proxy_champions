/**
 * M6: 個人戦バッチ大会の手触り確認 CLI（`deno task season`）。
 * 1ディビジョン（代表ビルド群）で1シーズンを回し、予選順位表・決勝トーナメント・昇降格を表示する。
 *
 * 観測できる成果物: 実力差が「予選順位 → 優勝 → 昇降格」に創発しているか（企画書5章）。
 * 数値はすべて仮（formulas.TOURNAMENT）。勝点/決勝枠/昇降格数の調整はここを回して見る。
 */

import { runSeason } from '../src/tournament.ts';
import type { CharacterBuild, TournamentEntrant } from '../src/schema.ts';

function build(id: string, s: [number, number, number, number, number], eq: Partial<CharacterBuild['equipment']> = {}): CharacterBuild {
  return {
    characterId: id,
    level: 20,
    stats: { vit: s[0], mag: s[1], pow: s[2], spd: s[3], men: s[4] },
    spellLines: { fire: 0, cure: 0, sleep: 0, strength: 0 },
    equipment: { weapon: 'sword_iron', armor: 'mail_leather', shield: null, ...eq },
  };
}

// アーキタイプ混成の8人ディビジョン（型の違いで順位が創発するか）
const entrants: TournamentEntrant[] = [
  { id: 'タンク', build: { ...build('tank', [40, 2, 16, 10, 12], { armor: 'mail_iron', shield: 'shield_iron' }) } },
  { id: '速攻', build: { ...build('rush', [16, 2, 18, 20, 6], { weapon: 'dagger' }) } },
  { id: '脳筋', build: { ...build('bruiser', [24, 2, 24, 10, 8], { weapon: 'axe_battle', armor: 'mail_iron' }) } },
  {
    id: '魔法',
    build: {
      characterId: 'mage',
      level: 20,
      stats: { vit: 16, mag: 26, pow: 6, spd: 12, men: 10 },
      spellLines: { fire: 40, cure: 0, sleep: 0, strength: 0 },
      equipment: { weapon: 'staff_oak', armor: 'robe', shield: null },
    },
  },
  {
    id: '回復',
    build: {
      characterId: 'cleric',
      level: 20,
      stats: { vit: 20, mag: 20, pow: 12, spd: 10, men: 10 },
      spellLines: { fire: 0, cure: 40, sleep: 0, strength: 0 },
      equipment: { weapon: 'sword_iron', armor: 'mail_leather', shield: null },
    },
  },
  { id: 'バランス', build: build('allrounder', [20, 2, 16, 12, 8]) },
  { id: '新人', build: build('rookie', [14, 2, 12, 9, 5], { armor: null }) },
  { id: '弱兵', build: build('weak', [10, 2, 8, 7, 4], { weapon: null, armor: null }) },
];

const seed = 20260708;
const s = runSeason(entrants, seed);
const name = (id: string) => entrants.find((e) => e.id === id || e.build.characterId === id)?.id ?? id;

console.log(`\n=== シーズン seed=${seed}  出場 ${entrants.length}人 ===`);

console.log('\n── 予選リーグ順位表（総当たり）──');
console.log('  順位  出場者      勝-分-敗   勝点');
for (const r of s.league.standings) {
  console.log(
    `  ${String(r.rank).padStart(2)}位  ${name(r.id).padEnd(8)}  ${r.wins}-${r.draws}-${r.losses}     ${String(r.points).padStart(2)}`,
  );
}

if (s.bracket) {
  console.log(`\n── 決勝トーナメント（上位${s.bracket.seeds.length}シード）──`);
  for (const m of s.bracket.matches) {
    const w = m.outcome.winnerId ?? '（上位シード進出）';
    console.log(`  R${m.round}#${m.slot}  ${name(m.outcome.a)} vs ${name(m.outcome.b)}  → ${name(w)}`);
  }
  console.log(`  🏆 優勝: ${name(s.bracket.championId)}`);
}

console.log('\n── 昇降格 ──');
console.log(`  ▲昇格: ${s.promotion.promote.map(name).join(', ')}`);
console.log(`  ＝残留: ${s.promotion.stay.map(name).join(', ')}`);
console.log(`  ▼降格: ${s.promotion.relegate.map(name).join(', ')}`);
console.log('');
