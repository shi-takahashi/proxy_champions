/**
 * デバッグ機能（コイン付与）の検証。★DEBUG_TOOLS=true で serve している前提（有効時の挙動）。
 *   1. 匿名サインイン → キャラ作成（gold=0）
 *   2. debug_grant_gold(amount=1000) → gold=1000（付与できる）
 *   3. 追加で +100 → gold=1100（累積）
 *   4. 不正な amount（0 / 過大）は 400 で弾く
 *
 * 無効時（本番相当・DEBUG_TOOLS 未設定）に 403 になることは、別途 env なしで serve して確認する
 *   （verify では両方を1プロセスで作れないため、下の「動かし方」を参照）。
 *
 * 実行:
 *   ANON_KEY=... SERVICE_ROLE_KEY=... deno run -A supabase/scripts/verify_debug.ts
 */
const URL = Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321';
const ANON = Deno.env.get('ANON_KEY');
if (!ANON) {
  console.error('ANON_KEY env が必要（supabase status -o env で取得）');
  Deno.exit(2);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error('❌ ' + msg);
}
function h(token: string): Record<string, string> {
  return { apikey: ANON!, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function signIn(): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${URL}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: ANON!, 'Content-Type': 'application/json' }, body: '{}',
  });
  const b = await res.json();
  assert(res.ok, `匿名サインイン失敗: ${res.status} ${JSON.stringify(b)}`);
  return { token: b.access_token, userId: b.user.id };
}

async function createChar(token: string, userId: string): Promise<string> {
  const res = await fetch(`${URL}/rest/v1/characters`, {
    method: 'POST', headers: { ...h(token), Prefer: 'return=representation' },
    body: JSON.stringify({
      player_id: userId, name: '見習い', level: 1,
      stats: { vit: 16, mag: 4, pow: 16, spd: 10, men: 6 },
      spell_lines: { fire: 0, cure: 0, sleep: 0, strength: 0 },
      equipment: { weapon: 'sword_iron', armor: 'mail_leather', shield: null },
    }),
  });
  const b = await res.json();
  assert(res.ok, `character 作成失敗: ${res.status} ${JSON.stringify(b)}`);
  return b[0].id;
}

async function invoke(token: string, body: unknown) {
  const res = await fetch(`${URL}/functions/v1/run-dispatch`, { method: 'POST', headers: h(token), body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, json: await res.json() };
}
async function gold(token: string, userId: string): Promise<number> {
  const res = await fetch(`${URL}/rest/v1/players?id=eq.${userId}&select=gold`, { headers: h(token) });
  return Number((await res.json())[0].gold);
}

console.log('▶ 1. サインイン・キャラ作成（gold=0）');
const { token, userId } = await signIn();
const characterId = await createChar(token, userId);
assert((await gold(token, userId)) === 0, '初期 gold が 0 でない');
console.log(`   ok char=${characterId.slice(0, 8)}… gold=0`);

console.log('▶ 2. debug_grant_gold(1000) → gold=1000');
const g1 = await invoke(token, { action: 'debug_grant_gold', characterId, amount: 1000 });
assert(g1.ok, `付与失敗（DEBUG_TOOLS=true で serve している?）: ${g1.status} ${JSON.stringify(g1.json)}`);
assert(g1.json.goldLeft === 1000, `goldLeft 不一致: ${JSON.stringify(g1.json)}`);
assert((await gold(token, userId)) === 1000, 'DB gold が 1000 でない');
console.log('   ok gold=1000');

console.log('▶ 3. さらに +100 → gold=1100（累積）');
const g2 = await invoke(token, { action: 'debug_grant_gold', characterId, amount: 100 });
assert(g2.ok && g2.json.goldLeft === 1100, `累積付与不一致: ${JSON.stringify(g2.json)}`);
console.log('   ok gold=1100');

console.log('▶ 4. 不正な amount は 400');
const bad0 = await invoke(token, { action: 'debug_grant_gold', characterId, amount: 0 });
assert(bad0.status === 400, `amount=0 が 400 でない: ${bad0.status}`);
const bad2 = await invoke(token, { action: 'debug_grant_gold', characterId, amount: 9_999_999 });
assert(bad2.status === 400, `過大 amount が 400 でない: ${bad2.status}`);
assert((await gold(token, userId)) === 1100, '不正付与で gold が動いた');
console.log('   ok amount=0/過大 は 400・gold 不変');

console.log('\n✅ デバッグ(コイン付与) DoD: 有効時に付与できる・累積する・不正弾く 全通過');
