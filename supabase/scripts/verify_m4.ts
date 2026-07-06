/**
 * M4 DoD 検証（薄い縦スライスのサーバー側を UI 抜きで一気通貫・実装プラン M4）:
 *   1. 匿名サインイン（M3 基盤）
 *   2. character を作成（＝ビルドを DB 保存）
 *   3. Edge Function run-battle を invoke（サーバー側で battle() 実行 → matches へ保存）
 *   4. 返った matchId で matches を読み戻し、eventLog / winner を検証
 *
 * これが M4「サーバー側 DoD」の一次証拠（Flutter 描画に依存せずパイプライン疎通を green で示す）。
 *
 * 実行（supabase start ＋ functions serve run-battle が動いている前提）:
 *   ANON_KEY=... deno run -A supabase/scripts/verify_m4.ts
 */
import type { BattleEvent, CharacterBuild } from '../../engine/src/schema.ts';

const URL = Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321';
const ANON = Deno.env.get('ANON_KEY');
if (!ANON) {
  console.error('ANON_KEY env が必要（supabase status -o env で取得）');
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

async function runBattle(token: string, characterId: string) {
  const res = await fetch(`${URL}/functions/v1/run-battle`, {
    method: 'POST',
    headers: {
      apikey: ANON!,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ characterId }),
  });
  const body = await res.json();
  assert(res.ok, `run-battle invoke 失敗: ${res.status} ${JSON.stringify(body)}`);
  return body as { matchId: string; winner: string; turns: number };
}

async function readMatch(token: string, matchId: string) {
  const res = await fetch(`${URL}/rest/v1/matches?id=eq.${matchId}&select=*`, {
    headers: { apikey: ANON!, Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  assert(res.ok, `match 読み出し失敗: ${res.status} ${JSON.stringify(body)}`);
  assert(Array.isArray(body) && body.length === 1, `match が1件でない: ${JSON.stringify(body)}`);
  return body[0];
}

// ── run
console.log('▶ 1. 匿名サインイン');
const { token, userId } = await signInAnonymously();
console.log(`   ok userId=${userId.slice(0, 8)}…`);

console.log('▶ 2. キャラ作成（DB 保存）');
const characterId = await createCharacter(token, userId, '勇者', {
  level: 12,
  stats: { vit: 12, mag: 6, pow: 14, spd: 9, men: 5 },
  spellLines: { fire: 10, cure: 0, sleep: 0, strength: 0 },
  equipment: { weapon: 'sword_iron', armor: 'mail_iron', shield: 'shield_iron' },
});
console.log(`   ok characterId=${characterId.slice(0, 8)}…`);

console.log('▶ 3. run-battle invoke（サーバー側 battle() → matches 保存）');
const { matchId, winner, turns } = await runBattle(token, characterId);
console.log(`   ok matchId=${matchId.slice(0, 8)}… winner=${winner} turns=${turns}`);

console.log('▶ 4. matches 読み戻し（観戦の契約＝eventLog）');
const match = await readMatch(token, matchId);
assert(match.character_a === characterId, 'character_a が保存キャラと不一致');
assert(match.character_b === null, 'character_b は M4 では null 運用');
assert(match.winner === 'A' || match.winner === 'B' || match.winner === 'draw', 'winner 不正');
assert(match.status === 'done', 'status が done でない');

const log = match.event_log as BattleEvent[];
assert(Array.isArray(log) && log.length > 0, 'event_log が空');
assert(log[0].type === 'battle_start', '先頭が battle_start でない');
assert(log[log.length - 1].type === 'battle_end', '末尾が battle_end でない');
console.log(`   ok event_log ${log.length} 件（${log[0].type} … ${log[log.length - 1].type}）`);

console.log('\n✅ M4 サーバー側 DoD: 匿名Auth→キャラ作成→run-battle(engine)→matches保存→eventLog読み戻し 全通過');
