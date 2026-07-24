/**
 * use_item が「効果を DB item_catalog（正本）から読んで回復する」ことの検証。
 * （engine ITEMS 撤去＝効果の DB 一本化のリグレッション確認）
 *   1. サインイン→キャラ作成（vit16→maxHP160 / mag4→maxMP20）
 *   2. current_hp=1 に落とす → potion_hp_small(10%) 使用 → +16（DB の effect_pct=0.10 を読んでいる）
 *   3. potion_hp_full(100%) 使用 → 満タン(160)
 *   4. current_mp=0 → potion_mp_full(100%) → 満タン(20)
 *   5. 未知アイテム → 400
 *
 * 実行: ANON_KEY=... SERVICE_ROLE_KEY=... deno run -A supabase/scripts/verify_item.ts
 */
const URL = Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:54321';
const ANON = Deno.env.get('ANON_KEY');
const SERVICE = Deno.env.get('SERVICE_ROLE_KEY');
if (!ANON || !SERVICE) {
  console.error('ANON_KEY と SERVICE_ROLE_KEY env が必要');
  Deno.exit(2);
}
function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error('❌ ' + m);
}
function h(t: string): Record<string, string> {
  return { apikey: ANON!, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' };
}
function svc(): Record<string, string> {
  return { apikey: SERVICE!, Authorization: `Bearer ${SERVICE!}`, 'Content-Type': 'application/json' };
}
async function invoke(t: string, body: unknown) {
  const r = await fetch(`${URL}/functions/v1/run-dispatch`, { method: 'POST', headers: h(t), body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, json: await r.json() };
}

const su = await fetch(`${URL}/auth/v1/signup`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}' });
const sb = await su.json();
const token = sb.access_token as string, userId = sb.user.id as string;
const cc = await fetch(`${URL}/rest/v1/characters`, {
  method: 'POST', headers: { ...h(token), Prefer: 'return=representation' },
  body: JSON.stringify({
    player_id: userId, name: '見習い', level: 1,
    stats: { vit: 16, mag: 4, pow: 16, spd: 10, men: 6 },
    spell_lines: { fire: 0, cure: 0, sleep: 0, strength: 0 },
    equipment: { weapon: 'sword_iron', armor: 'mail_leather', shield: null },
  }),
});
const characterId = (await cc.json())[0].id as string;
console.log(`▶ キャラ作成 char=${characterId.slice(0, 8)}… (maxHP160/maxMP20)`);

async function grant(itemId: string, qty: number) {
  await fetch(`${URL}/rest/v1/player_items`, {
    method: 'POST', headers: { ...svc(), Prefer: 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify({ player_id: userId, item_id: itemId, quantity: qty }),
  });
}
async function setChar(patch: Record<string, unknown>) {
  await fetch(`${URL}/rest/v1/characters?id=eq.${characterId}`, {
    method: 'PATCH', headers: { ...svc(), Prefer: 'return=minimal' }, body: JSON.stringify(patch),
  });
}

console.log('▶ 2. HP=1 → HP回復薬（小）10% → +16（DB effect_pct を読む）');
await setChar({ current_hp: 1, hp_updated_at: new Date().toISOString() });
await grant('potion_hp_small', 1);
const s = await invoke(token, { action: 'use_item', characterId, itemId: 'potion_hp_small' });
assert(s.ok, `use_item(small) 失敗: ${s.status} ${JSON.stringify(s.json)}`);
assert(s.json.hp >= 17 && s.json.hp <= 18, `10%回復が効いていない（1+16≒17 期待）: hp=${s.json.hp}`);
console.log(`   ok hp=${s.json.hp}（DB の 0.10 を反映）`);

console.log('▶ 3. HP回復薬（大）100% → 満タン160');
await grant('potion_hp_full', 1);
const f = await invoke(token, { action: 'use_item', characterId, itemId: 'potion_hp_full' });
assert(f.ok && f.json.hp === 160, `満タン回復でない: ${JSON.stringify(f.json)}`);
console.log(`   ok hp=${f.json.hp}`);

console.log('▶ 4. MP=0 → MP回復薬（大）100% → 満タン20');
await setChar({ current_mp: 0, mp_updated_at: new Date().toISOString() });
await grant('potion_mp_full', 1);
const m = await invoke(token, { action: 'use_item', characterId, itemId: 'potion_mp_full' });
assert(m.ok && m.json.mp === 20, `MP満タンでない: ${JSON.stringify(m.json)}`);
console.log(`   ok mp=${m.json.mp}`);

console.log('▶ 5. 未知アイテム → 400');
const u = await invoke(token, { action: 'use_item', characterId, itemId: 'no_such_item' });
assert(u.status === 400, `未知アイテムが 400 でない: ${u.status}`);
console.log('   ok 400');

console.log('\n✅ use_item は DB item_catalog の効果で回復する（engine ITEMS 撤去のリグレッション OK）');
