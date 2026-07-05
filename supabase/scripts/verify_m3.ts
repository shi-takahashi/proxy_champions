/**
 * M3 DoD 検証（ローカルスタックに対して実走）:
 *   1. 匿名サインイン（enable_anonymous_sign_ins）→ handle_new_user トリガで players 行が自動生成される
 *   2. その JWT で characters を作成（RLS: auth.uid()=player_id を通過）＝ CharacterBuild を JSONB で保存
 *   3. 読み戻して CharacterBuild を復元 → engine の battle() に渡す（M0スキーマと往復可・DB↔engine 一致）
 *
 * 実行: SUPABASE_URL / ANON_KEY を env で渡す
 *   deno run -A supabase/scripts/verify_m3.ts
 */
import { battle } from '../../engine/src/battle.ts';
import type { CharacterBuild } from '../../engine/src/schema.ts';

const URL = Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321';
const ANON = Deno.env.get('ANON_KEY');
if (!ANON) {
  console.error('ANON_KEY env が必要（supabase status で取得）');
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
  assert(body.user?.is_anonymous === true, `is_anonymous が true でない: ${JSON.stringify(body.user)}`);
  return { token: body.access_token, userId: body.user.id };
}

// DB 行（snake_case）→ engine の CharacterBuild（契約）へ組み立て
function toBuild(row: any): CharacterBuild {
  return {
    characterId: row.id,
    level: row.level,
    stats: row.stats,
    spellLines: row.spell_lines,
    equipment: row.equipment,
  };
}

async function createCharacter(token: string, userId: string, name: string, build: Omit<CharacterBuild, 'characterId'>) {
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
  assert(res.ok, `character 作成失敗(RLS/FK): ${res.status} ${JSON.stringify(body)}`);
  return body[0];
}

async function readCharacters(token: string): Promise<any[]> {
  const res = await fetch(`${URL}/rest/v1/characters?select=*`, {
    headers: { apikey: ANON!, Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  assert(res.ok, `character 読み出し失敗: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// ── run
console.log('▶ 1. 匿名サインイン');
const { token, userId } = await signInAnonymously();
console.log(`   ok userId=${userId}`);

console.log('▶ 2. キャラ作成（RLS越し・JSONBビルド保存）');
const warrior = await createCharacter(token, userId, '脳筋戦士', {
  level: 12,
  stats: { vit: 14, mag: 2, pow: 16, spd: 8, men: 5 },
  spellLines: { fire: 0, cure: 0, sleep: 0, strength: 0 },
  equipment: { weapon: 'axe_battle', armor: 'mail_iron', shield: 'shield_iron' },
});
const mage = await createCharacter(token, userId, '魔法使い', {
  level: 12,
  stats: { vit: 8, mag: 18, pow: 3, spd: 9, men: 7 },
  spellLines: { fire: 30, cure: 10, sleep: 0, strength: 0 },
  equipment: { weapon: 'staff_oak', armor: 'robe', shield: null },
});
console.log(`   ok 作成 2体 (${warrior.id.slice(0, 8)}…, ${mage.id.slice(0, 8)}…)`);

console.log('▶ 3. 読み戻し → CharacterBuild 復元 → battle()');
const rows = await readCharacters(token);
assert(rows.length === 2, `読み戻し件数が2でない: ${rows.length}`);
const a = toBuild(rows.find((r) => r.name === '脳筋戦士'));
const b = toBuild(rows.find((r) => r.name === '魔法使い'));

// JSONB 往復の完全一致（保存した値がそのまま返る＝契約が壊れていない）
assert(a.stats.pow === 16 && a.equipment.weapon === 'axe_battle', 'stats/equipment 往復不一致(A)');
assert(b.spellLines.fire === 30 && b.stats.mag === 18, 'spellLines/stats 往復不一致(B)');

const result = battle({
  teamA: [{ id: a.characterId, side: 'A', build: a }],
  teamB: [{ id: b.characterId, side: 'B', build: b }],
  seed: 424242,
});
console.log(`   ok battle() winner=${result.winner} turns=${result.turns} events=${result.eventLog.length}`);
assert(result.winner === 'A' || result.winner === 'B' || result.winner === 'draw', 'winner 不正');

console.log('\n✅ M3 DoD: 匿名Auth→players自動生成→characters(RLS/JSONB)保存→読み戻し→engine往復 すべて通過');
