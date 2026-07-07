/**
 * M5: 派遣ダンジョンの手触り確認 CLI（`deno task dive`）。
 * 代表ビルドを1本潜らせ、連戦の明細と帰還サマリを表示する（観測できる成果物）。
 *
 * 数値はすべて仮（formulas.CONFIG.dive）。報酬レート/敵強度の調整はここを回して見る。
 */

import { dive } from '../src/dive.ts';
import type { CharacterBuild, DungeonDef } from '../src/schema.ts';
import { maxHP, maxMP } from '../src/formulas.ts';

const dungeon: DungeonDef = {
  slug: 'novice_field',
  difficulty: 2,
  dropTable: [
    { equipmentId: 'dagger', weight: 5 },
    { equipmentId: 'mail_leather', weight: 5 },
  ],
};

const builds: Record<string, CharacterBuild> = {
  '脳筋物理': {
    characterId: 'bruiser',
    level: 20,
    stats: { vit: 18, mag: 2, pow: 18, spd: 10, men: 8 },
    spellLines: { fire: 0, cure: 0, sleep: 0, strength: 0 },
    equipment: { weapon: 'sword_iron', armor: 'mail_iron', shield: null },
  },
  '回復サステイン': {
    characterId: 'sustain',
    level: 20,
    stats: { vit: 18, mag: 16, pow: 10, spd: 10, men: 8 },
    spellLines: { fire: 0, cure: 30, sleep: 0, strength: 0 },
    equipment: { weapon: 'sword_iron', armor: 'mail_leather', shield: null },
  },
};

const minutes = 60;
const seed = 20260707;

for (const [name, hero] of Object.entries(builds)) {
  const r = dive(hero, dungeon, seed, minutes);
  console.log(`\n=== ${name}  (HP${maxHP(hero.stats.vit)}/MP${maxMP(hero.stats.mag)}) → ${dungeon.slug} diff${dungeon.difficulty} / ${minutes}分 ===`);
  for (const b of r.battles) {
    const tag = b.won ? '○勝' : b.winner === 'draw' ? '△分' : '●敗';
    const drop = b.drop ? `  drop:${b.drop}` : '';
    console.log(
      `  #${String(b.index).padStart(2)} ${tag}  +${b.xp}xp +${b.gold}g  HP:${b.hpAfter} MP:${b.mpAfter}  (${b.minutesElapsed}分)${drop}`,
    );
  }
  console.log(
    `  → 帰還[${r.endReason}]  ${r.battles.length}戦  計 ${r.totalXp}xp / ${r.totalGold}g  drops:[${r.drops.join(',')}]  残HP${r.hpRemaining}/MP${r.mpRemaining}`,
  );
}
