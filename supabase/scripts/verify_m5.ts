/**
 * M5.3 DoD 検証（育成ループの永続化を UI 抜きで一気通貫・実装プラン M5.3）:
 *   1. 匿名サインイン（M3 基盤）
 *   2. character 作成（level1 / xp0 / current_hp=null=満タン）
 *   3. run-dispatch(action:dispatch) → dive() をサーバーで回し XP/ゴールド/体力/ドロップを DB 反映
 *   4. characters 読み戻し: xp↑・level は gainXp と一致・current_hp が保存されている（体力ループ）
 *   5. players 読み戻し: gold↑
 *   6. dispatches 読み戻し: 自分の派遣履歴が見える（DiveResult 保存）
 *   7. アイテム: service_role で HP回復薬（大）=1 付与 → use_item → 満タン回復・quantity 減算
 *   8. RLS: 2人目の匿名ユーザーからは 1人目の dispatches が見えない
 *
 * 実行（supabase start ＋ functions serve run-dispatch が動いている前提）:
 *   ANON_KEY=... SERVICE_ROLE_KEY=... deno run -A supabase/scripts/verify_m5.ts
 */
import type { CharacterBuild } from '../../engine/src/schema.ts';
import { gainXp } from '../../engine/src/growth.ts';
import { maxHP } from '../../engine/src/formulas.ts';

const URL = Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321';
const ANON = Deno.env.get('ANON_KEY');
const SERVICE = Deno.env.get('SERVICE_ROLE_KEY');
if (!ANON || !SERVICE) {
  console.error('ANON_KEY と SERVICE_ROLE_KEY env が必要（supabase status -o env で取得）');
  Deno.exit(2);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('❌ ' + msg);
}

async function signInAnonymously(): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON!, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = await res.json();
  assert(res.ok, `匿名サインイン失敗: ${res.status} ${JSON.stringify(body)}`);
  return { token: body.access_token, userId: body.user.id };
}

async function createCharacter(
  token: string,
  userId: string,
  name: string,
  build: Omit<CharacterBuild, 'characterId'>,
): Promise<string> {
  const res = await fetch(`${URL}/rest/v1/characters`, {
    method: 'POST',
    headers: {
      apikey: ANON!,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      player_id: userId,
      name,
      level: build.level,
      stats: build.stats,
      spell_lines: build.spellLines,
      equipment: build.equipment,
    }),
  });
  const body = await res.json();
  assert(res.ok, `character 作成失敗: ${res.status} ${JSON.stringify(body)}`);
  return body[0].id;
}

async function getDungeonId(token: string, slug: string): Promise<string> {
  const res = await fetch(`${URL}/rest/v1/dungeons?slug=eq.${slug}&select=id`, {
    headers: { apikey: ANON!, Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  assert(res.ok && Array.isArray(body) && body.length === 1, `dungeon 取得失敗: ${JSON.stringify(body)}`);
  return body[0].id;
}

async function invoke(token: string, body: unknown) {
  const res = await fetch(`${URL}/functions/v1/run-dispatch`, {
    method: 'POST',
    headers: { apikey: ANON!, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

async function readOne(token: string, path: string) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: ANON!, Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  assert(res.ok, `読み出し失敗(${path}): ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// ── run
console.log('▶ 1. 匿名サインイン');
const { token, userId } = await signInAnonymously();
console.log(`   ok userId=${userId.slice(0, 8)}…`);

console.log('▶ 2. キャラ作成（level1 / xp0 / current_hp=満タン）');
const build: Omit<CharacterBuild, 'characterId'> = {
  level: 1,
  stats: { vit: 16, mag: 4, pow: 16, spd: 10, men: 6 },
  spellLines: { fire: 0, cure: 0, sleep: 0, strength: 0 },
  equipment: { weapon: 'sword_iron', armor: 'mail_leather', shield: null },
};
const characterId = await createCharacter(token, userId, '見習い', build);
const maxHp = maxHP(build.stats.vit);
console.log(`   ok characterId=${characterId.slice(0, 8)}… maxHP=${maxHp}`);

console.log('▶ 3. run-dispatch(dispatch)（サーバーで dive → 報酬反映）');
const dungeonId = await getDungeonId(token, 'novice_field');
const disp = await invoke(token, { action: 'dispatch', characterId, dungeonId, minutes: 60 });
assert(disp.ok, `dispatch 失敗: ${disp.status} ${JSON.stringify(disp.json)}`);
const d = disp.json;
console.log(
  `   ok ${d.battles}戦 [${d.endReason}] +${d.xpGained}xp +${d.goldGained}g Lv${d.level}(↑${d.leveledUp}) 残HP${d.hpRemaining}/${maxHp} drops:[${(d.drops ?? []).map((x: { id: string }) => x.id).join(',')}]`,
);
assert(d.xpGained > 0, '派遣で XP を得ている');
assert(d.goldGained > 0, '派遣でゴールドを得ている');
assert(d.hpRemaining >= 0 && d.hpRemaining <= maxHp, 'hpRemaining が範囲内');

console.log('▶ 4. characters 読み戻し（xp↑・level は gainXp と一致・current_hp 保存）');
const chars = await readOne(token, `characters?id=eq.${characterId}&select=xp,level,current_hp`);
const ch = chars[0];
const expected = gainXp(0, d.xpGained);
assert(Number(ch.xp) === d.xpGained, `xp 保存不一致: ${ch.xp} != ${d.xpGained}`);
assert(ch.level === expected.progress.level, `level が gainXp と不一致: ${ch.level} != ${expected.progress.level}`);
assert(ch.current_hp === d.hpRemaining, `current_hp 保存不一致: ${ch.current_hp} != ${d.hpRemaining}`);
console.log(`   ok xp=${ch.xp} level=${ch.level} current_hp=${ch.current_hp}`);

console.log('▶ 5. players 読み戻し（gold↑）');
const players = await readOne(token, `players?id=eq.${userId}&select=gold`);
assert(Number(players[0].gold) === d.goldGained, `gold 反映不一致: ${players[0].gold} != ${d.goldGained}`);
console.log(`   ok gold=${players[0].gold}`);

console.log('▶ 6. dispatches 読み戻し（自分の派遣履歴＝DiveResult）');
const disps = await readOne(token, `dispatches?character_id=eq.${characterId}&select=*`);
assert(Array.isArray(disps) && disps.length === 1, `dispatch 履歴が1件でない: ${disps.length}`);
assert(disps[0].result?.battles?.length === d.battles, 'result(DiveResult) の battles が一致');
assert(disps[0].end_reason === d.endReason, 'end_reason 一致');
console.log(`   ok 履歴1件 seed=${disps[0].seed} result.battles=${disps[0].result.battles.length}`);

console.log('▶ 7. アイテム: service_role で HP回復薬（大）=1 付与 → use_item で満タン回復');
const grant = await fetch(`${URL}/rest/v1/player_items`, {
  method: 'POST',
  headers: {
    apikey: SERVICE!,
    Authorization: `Bearer ${SERVICE!}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  },
  body: JSON.stringify({ player_id: userId, item_id: 'potion_hp_full', quantity: 1 }),
});
assert(grant.ok, `アイテム付与失敗: ${grant.status}`);
const pot = await invoke(token, { action: 'use_item', characterId, itemId: 'potion_hp_full' });
assert(pot.ok, `use_item 失敗: ${pot.status} ${JSON.stringify(pot.json)}`);
assert(pot.json.hp === maxHp, `満タン回復でない: ${pot.json.hp} != ${maxHp}`);
assert(pot.json.quantityLeft === 0, `quantity 減算されていない: ${pot.json.quantityLeft}`);
const afterPot = await readOne(token, `characters?id=eq.${characterId}&select=current_hp`);
assert(afterPot[0].current_hp === maxHp, `current_hp が満タンでない: ${afterPot[0].current_hp}`);
console.log(`   ok アイテム使用 → current_hp=${afterPot[0].current_hp} quantityLeft=${pot.json.quantityLeft}`);

console.log('▶ 8. RLS: 2人目からは1人目の dispatches が見えない');
const { token: token2 } = await signInAnonymously();
const otherView = await readOne(token2, `dispatches?character_id=eq.${characterId}&select=id`);
assert(Array.isArray(otherView) && otherView.length === 0, `他人の派遣履歴が見えている: ${JSON.stringify(otherView)}`);
console.log('   ok 他人の派遣履歴は0件');

console.log('\n✅ M5.3 DoD: 派遣→dive→報酬(XP/level/gold/体力/ドロップ)反映→履歴→回復薬→RLS 全通過');
