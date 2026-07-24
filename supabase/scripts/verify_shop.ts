/**
 * ショップ DoD 検証（ゴールドの出口＋ショップマスタによる販売管理）:
 *   1. 匿名サインイン（M3 基盤）
 *   2. character 作成 ／ service_role で gold=1000 付与
 *   3. available_shop_listings（RPC）: マスタ由来の「今売っている」商品が返る（13 から carry-forward した常時販売）
 *   4. buy(listingId: 短剣) → gold 減算・player_equipment に付与
 *   5. 再購入 → 409（型は重複所持しない）
 *   6. buy(listingId: HP回復薬小 ×2) → gold 減算・player_items.quantity=2
 *   7. ★販売期間の制御（ショップマスタで“いつ売るか”）:
 *        a. 期限切れ（ends_at 過去）の行を service_role で追加 → RPC に出ない ＆ buy → 409（販売期間外）
 *        b. 未来開始（starts_at 未来）の行 → RPC に出ない ＆ buy → 409（販売前）
 *        c. 期間内（starts 過去・ends 未来）の行 → RPC に出る ＆ buy 成功（＝期間限定セールが機能）
 *   8. ゴールド不足: gold=50 で高額商品 → 409・gold 不変
 *   9. RLS: shop_listings 本体は anon から読めない／書けない（運用は service_role 専用）
 *
 * 実行（supabase start ＋ functions serve run-dispatch が動いている前提）:
 *   ANON_KEY=... SERVICE_ROLE_KEY=... deno run -A supabase/scripts/verify_shop.ts
 */
import type { CharacterBuild } from '../../engine/src/schema.ts';

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

function anonHeaders(token: string): Record<string, string> {
  return { apikey: ANON!, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
function svc(): Record<string, string> {
  return { apikey: SERVICE!, Authorization: `Bearer ${SERVICE!}`, 'Content-Type': 'application/json' };
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

async function createCharacter(token: string, userId: string): Promise<string> {
  const build: Omit<CharacterBuild, 'characterId'> = {
    level: 1,
    stats: { vit: 16, mag: 4, pow: 16, spd: 10, men: 6 },
    spellLines: { fire: 0, cure: 0, sleep: 0, strength: 0 },
    equipment: { weapon: 'sword_iron', armor: 'mail_leather', shield: null },
  };
  const res = await fetch(`${URL}/rest/v1/characters`, {
    method: 'POST',
    headers: { ...anonHeaders(token), Prefer: 'return=representation' },
    body: JSON.stringify({
      player_id: userId, name: '見習い', level: build.level,
      stats: build.stats, spell_lines: build.spellLines, equipment: build.equipment,
    }),
  });
  const body = await res.json();
  assert(res.ok, `character 作成失敗: ${res.status} ${JSON.stringify(body)}`);
  return body[0].id;
}

async function invoke(token: string, body: unknown) {
  const res = await fetch(`${URL}/functions/v1/run-dispatch`, {
    method: 'POST', headers: anonHeaders(token), body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, json: await res.json() };
}

// deno-lint-ignore no-explicit-any
async function listings(token: string): Promise<any[]> {
  const res = await fetch(`${URL}/rest/v1/rpc/available_shop_listings`, {
    method: 'POST', headers: anonHeaders(token), body: '{}',
  });
  const body = await res.json();
  assert(res.ok, `available_shop_listings 失敗: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function setGold(userId: string, gold: number): Promise<void> {
  const res = await fetch(`${URL}/rest/v1/players?id=eq.${userId}`, {
    method: 'PATCH', headers: { ...svc(), Prefer: 'return=minimal' }, body: JSON.stringify({ gold }),
  });
  assert(res.ok, `gold 設定失敗: ${res.status}`);
}
async function getGold(token: string, userId: string): Promise<number> {
  const res = await fetch(`${URL}/rest/v1/players?id=eq.${userId}&select=gold`, { headers: anonHeaders(token) });
  const rows = await res.json();
  return Number(rows[0].gold);
}

/** service_role でショップマスタに販売行を追加し、その listingId を返す（運用の“商品追加”を模す）。
 *  ※ shop_listings はプレイヤーに見える「マスタ」なので、テストで足した行は最後に必ず消す（下の cleanup）。 */
const _insertedListingIds: string[] = [];
async function addListing(row: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${URL}/rest/v1/shop_listings`, {
    method: 'POST', headers: { ...svc(), Prefer: 'return=representation' }, body: JSON.stringify(row),
  });
  const body = await res.json();
  assert(res.ok, `shop_listings 追加失敗: ${res.status} ${JSON.stringify(body)}`);
  _insertedListingIds.push(body[0].id);
  return body[0].id;
}
async function cleanupListings(): Promise<void> {
  for (const id of _insertedListingIds) {
    await fetch(`${URL}/rest/v1/shop_listings?id=eq.${id}`, {
      method: 'DELETE', headers: { ...svc(), Prefer: 'return=minimal' },
    });
  }
}

// ── run
console.log('▶ 1-2. サインイン・キャラ作成・gold=1000');
const { token, userId } = await signInAnonymously();
const characterId = await createCharacter(token, userId);
await setGold(userId, 1000);
assert((await getGold(token, userId)) === 1000, 'gold=1000 になっていない');
console.log(`   ok user=${userId.slice(0, 8)}… char=${characterId.slice(0, 8)}… gold=1000`);

console.log('▶ 3. available_shop_listings（RPC）で常時販売の商品が返る');
const shop = await listings(token);
const dagger = shop.find((l) => l.equipment_id === 'dagger');
const potionSmall = shop.find((l) => l.item_id === 'potion_hp_small');
assert(dagger && dagger.price === 180, `短剣が販売されていない/価格不一致: ${JSON.stringify(dagger)}`);
assert(potionSmall && potionSmall.price === 30, `HP回復薬小が販売されていない: ${JSON.stringify(potionSmall)}`);
console.log(`   ok ${shop.length}品販売中（短剣=${dagger.price}G / HP薬小=${potionSmall.price}G）`);

console.log('▶ 4. buy(短剣=180) → gold 減算・所持付与');
const b1 = await invoke(token, { action: 'buy', characterId, listingId: dagger.listing_id });
assert(b1.ok, `装備購入失敗: ${b1.status} ${JSON.stringify(b1.json)}`);
assert(b1.json.goldLeft === 820, `goldLeft 不一致: ${b1.json.goldLeft}`);
const ownRes = await fetch(`${URL}/rest/v1/player_equipment?equipment_id=eq.dagger&select=id`, { headers: anonHeaders(token) });
assert(((await ownRes.json()) as unknown[]).length === 1, 'player_equipment に dagger が無い');
console.log('   ok 短剣 所持・gold=820');

console.log('▶ 5. 再購入 → 409');
const b2 = await invoke(token, { action: 'buy', characterId, listingId: dagger.listing_id });
assert(b2.status === 409, `再購入が 409 でない: ${b2.status} ${JSON.stringify(b2.json)}`);
assert((await getGold(token, userId)) === 820, '再購入拒否で gold が減っている');
console.log('   ok 409・gold 不変（820）');

console.log('▶ 6. buy(HP回復薬小 ×2 = 60) → quantity=2');
const b3 = await invoke(token, { action: 'buy', characterId, listingId: potionSmall.listing_id, quantity: 2 });
assert(b3.ok, `アイテム購入失敗: ${b3.status} ${JSON.stringify(b3.json)}`);
assert(b3.json.goldLeft === 760, `goldLeft 不一致: ${b3.json.goldLeft}`);
assert(b3.json.quantityLeft === 2, `quantityLeft 不一致: ${b3.json.quantityLeft}`);
console.log('   ok HP薬小×2・gold=760');

try {
console.log('▶ 7. 販売期間の制御（ショップマスタで“いつ売るか”）');
const now = Date.now();
const past = new Date(now - 3600_000).toISOString();
const future = new Date(now + 3600_000).toISOString();
const farFuture = new Date(now + 7200_000).toISOString();

// a. 期限切れ（ends_at 過去）
const expiredId = await addListing({
  product_type: 'equipment', equipment_id: 'robe', name: '【終了済み】ローブ', price: 100, ends_at: past,
});
// b. 未来開始（starts_at 未来）
const futureId = await addListing({
  product_type: 'equipment', equipment_id: 'mail_iron', name: '【予告】鉄鎧', price: 300,
  starts_at: future, ends_at: farFuture,
});
// c. 期間内（starts 過去・ends 未来）＝期間限定セール
const activeId = await addListing({
  product_type: 'equipment', equipment_id: 'staff_oak', name: '【期間限定】樫の杖', price: 150,
  starts_at: past, ends_at: future,
});

const shop2 = await listings(token);
const ids = new Set(shop2.map((l) => l.listing_id));
assert(!ids.has(expiredId), '期限切れ商品が販売リストに出ている');
assert(!ids.has(futureId), '未来開始商品が販売リストに出ている');
assert(ids.has(activeId), '期間内の限定商品が販売リストに出ていない');
const activeRow = shop2.find((l) => l.listing_id === activeId);
assert(activeRow.name === '【期間限定】樫の杖' && activeRow.ends_at !== null, '限定商品の名前/終了日が返っていない');
console.log(`   ok RPC: 期限切れ✗ 未来✗ 期間内○（${shop2.length}品）`);

// buy: 期限切れ → 409 ／ 未来 → 409 ／ 期間内 → 成功
const buyExpired = await invoke(token, { action: 'buy', characterId, listingId: expiredId });
assert(buyExpired.status === 409, `期限切れの購入が 409 でない: ${buyExpired.status} ${JSON.stringify(buyExpired.json)}`);
const buyFuture = await invoke(token, { action: 'buy', characterId, listingId: futureId });
assert(buyFuture.status === 409, `未来開始の購入が 409 でない: ${buyFuture.status} ${JSON.stringify(buyFuture.json)}`);
const buyActive = await invoke(token, { action: 'buy', characterId, listingId: activeId });
assert(buyActive.ok, `期間内の購入が失敗: ${buyActive.status} ${JSON.stringify(buyActive.json)}`);
assert(buyActive.json.goldLeft === 610, `限定購入後の gold 不一致: ${buyActive.json.goldLeft}`); // 760-150
console.log('   ok buy: 期限切れ409・未来409・期間内は成功（gold=610）');

console.log('▶ 8. ゴールド不足: gold=50 で 樫の杖(150) → 409・gold 不変');
await setGold(userId, 50);
// staff_oak は購入済みなので別の期間内商品を追加して不足を試す
const pricyId = await addListing({
  product_type: 'equipment', equipment_id: 'mail_leather', name: '革鎧', price: 150,
});
const b4 = await invoke(token, { action: 'buy', characterId, listingId: pricyId });
assert(b4.status === 409, `不足時に 409 でない: ${b4.status} ${JSON.stringify(b4.json)}`);
assert((await getGold(token, userId)) === 50, '購入失敗なのに gold が減っている');
console.log('   ok 409・gold 不変（50）');

console.log('▶ 8.5 売却（不要な装備/アイテムをゴールドに換える・売価は catalog.sell_price）');
await setGold(userId, 500);
// カタログの sell_price ミラー確認（正本＝DB）
const scRes = await fetch(`${URL}/rest/v1/equipment_catalog?id=eq.dagger&select=sell_price`, { headers: anonHeaders(token) });
const scRows = await scRes.json();
assert(Number(scRows[0].sell_price) === 90, `dagger の sell_price 不一致: ${JSON.stringify(scRows)}`);
// a. 所持中の短剣（step4 で購入）を売る → +90
const sell1 = await invoke(token, { action: 'sell', characterId, kind: 'equipment', id: 'dagger' });
assert(sell1.ok, `装備売却失敗: ${sell1.status} ${JSON.stringify(sell1.json)}`);
assert(sell1.json.goldGained === 90 && sell1.json.goldLeft === 590, `売却額不一致: ${JSON.stringify(sell1.json)}`);
const gone = await fetch(`${URL}/rest/v1/player_equipment?equipment_id=eq.dagger&select=id`, { headers: anonHeaders(token) });
assert(((await gone.json()) as unknown[]).length === 0, '売却後も dagger を所持している');
// b. 装備中のもの（キャラの weapon=sword_iron）は売れない：所持に足してから売却 → 409
await fetch(`${URL}/rest/v1/player_equipment`, {
  method: 'POST', headers: { ...svc(), Prefer: 'return=minimal' },
  body: JSON.stringify({ player_id: userId, equipment_id: 'sword_iron' }),
});
const sellEquipped = await invoke(token, { action: 'sell', characterId, kind: 'equipment', id: 'sword_iron' });
assert(sellEquipped.status === 409, `装備中の売却が 409 でない: ${sellEquipped.status} ${JSON.stringify(sellEquipped.json)}`);
// c. 未所持のものは売れない → 409
const sellMissing = await invoke(token, { action: 'sell', characterId, kind: 'equipment', id: 'axe_battle' });
assert(sellMissing.status === 409, `未所持の売却が 409 でない: ${sellMissing.status}`);
// d. 回復薬を1個売る（step6 で2個所持）→ +15・残1
const sellItem = await invoke(token, { action: 'sell', characterId, kind: 'item', id: 'potion_hp_small' });
assert(sellItem.ok, `アイテム売却失敗: ${sellItem.status} ${JSON.stringify(sellItem.json)}`);
assert(sellItem.json.goldGained === 15 && sellItem.json.quantityLeft === 1, `アイテム売却不一致: ${JSON.stringify(sellItem.json)}`);
assert((await getGold(token, userId)) === 605, `売却後の gold 不一致: ${await getGold(token, userId)}`);
console.log('   ok 短剣売却+90 / 装備中409 / 未所持409 / 回復薬売却+15(残1) → gold=605');

console.log('▶ 9. RLS: shop_listings 本体は anon から読めない/書けない');
const readBase = await fetch(`${URL}/rest/v1/shop_listings?select=id`, { headers: anonHeaders(token) });
const baseRows = await readBase.json();
assert(Array.isArray(baseRows) && baseRows.length === 0, `anon がマスタ本体を読めている: ${JSON.stringify(baseRows)}`);
const writeBase = await fetch(`${URL}/rest/v1/shop_listings`, {
  method: 'POST', headers: anonHeaders(token),
  body: JSON.stringify({ product_type: 'item', item_id: 'elixir', name: '不正', price: 1 }),
});
assert(!writeBase.ok, `anon がマスタに書けてしまう: ${writeBase.status}`);
console.log(`   ok 本体 read=0件・write 拒否(${writeBase.status})`);

console.log('\n✅ ショップ DoD: 販売リスト(RPC)→購入→重複拒否→複数購入→【販売期間制御】→ゴールド不足→RLS 全通過');
} finally {
  // テストで足した販売行はプレイヤーに見えるマスタを汚さないよう必ず消す（成功・失敗どちらでも）。
  await cleanupListings();
}
