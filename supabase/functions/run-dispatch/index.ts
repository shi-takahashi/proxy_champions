/**
 * M5.3: 派遣ダンジョン（育成ループのサーバー層・実装プラン M5.3 / 継ぎ目①）。
 *
 *   POST /functions/v1/run-dispatch   header: Authorization: Bearer <jwt>
 *   body:
 *     { action: 'dispatch', characterId, dungeonId, minutes }
 *        → 派遣を「開始」する（実時間・非同期／企画書3.3.1）。決定論シミュ結果を dispatch_pending に
 *          退避し、帰還予定時刻 dispatch_ends_at をセットするだけ。報酬はまだ渡さない（留守にする）。
 *     { action: 'collect', characterId }
 *        → 帰還予定時刻を過ぎていれば、退避した結果を確定して受け取る（XP/ゴールド/体力/ドロップを反映）。
 *          ・xp→level は engine growth(gainXp) が正本（level 列を materialize）
 *          ・体力ループ: 帰還時 hpRemaining を current_hp に保存（次の派遣へ持ち越す）
 *          ・ドロップは kind で振り分け（equipment→player_equipment / item→player_items）
 *     { action: 'dispatch_instant', characterId, dungeonId, minutes }   ★デバッグ用
 *        → 旧挙動: 押した瞬間に全連戦を解決して即座に報酬まで反映（動作確認を速くするため温存）。
 *     { action: 'use_item', characterId, itemId }
 *        → 所持アイテム（回復薬）を1つ消費。DB item_catalog の効果（hp/mp/both × 割合）で回復し
 *          player_items の quantity を減算（0 になったら行を削除）。
 *     { action: 'buy', characterId, listingId, quantity? }
 *        → ショップ購入（ゴールドの出口・企画書3.6）。listingId＝ショップマスタ shop_listings の行。
 *          価格も販売期間もマスタ行を service_role で読んで権威的に検証（販売期間外は 409）。
 *          gold を減算して所持を付与（equipment→player_equipment / item→player_items）。
 *          装備は「型」＝所持有無（既所持は 409）。回復薬は quantity 個（既定1）加算。
 *     { action: 'sell', characterId, kind: 'equipment'|'item', id, quantity? }
 *        → 不要な装備/アイテムを売る。売却価格の正本は catalog.sell_price（DB マスタ）。
 *          gold を加算して所持を減らす。装備中のもの・売却不可(sell_price=null)は 409。
 *     { action: 'debug_grant_gold', characterId, amount? }   ★デバッグ専用
 *        → コインを付与（ショップ購入の動作確認用）。env DEBUG_TOOLS=true のときだけ有効・本番は 403。
 *     { action: 'status', characterId }
 *        → 実効体力（自然回復込み）＋回復ETA、および派遣中かどうか/帰還までの残り分を返す（ホーム表示用）
 *
 * engine は同一ソースを相対 import（"戦闘エンジンは1回だけ実装"／企画書13.1）。
 * engine を変更したら engine/ で `deno task sync-edge` を再実行して _engine を更新する。
 * 報酬計算はすべて service_role でサーバー権威に閉じる（不正対策・企画書13.6）。
 */
import { dive, staminaRecover } from '../_engine/dive.ts';
import { gainXp } from '../_engine/growth.ts';
import { CONFIG, maxHP, maxMP } from '../_engine/formulas.ts';
import type { CharacterBuild, DiveResult, DropRef, DungeonDef } from '../_engine/schema.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// ★デバッグ機能の有効フラグ。ローカル/開発だけ DEBUG_TOOLS=true を渡す（例: functions serve --env-file）。
//   本番ではこの env を設定しない＝debug_* エンドポイントは常に 403（クライアントを細工しても実行不可）。
const DEBUG_TOOLS = Deno.env.get('DEBUG_TOOLS') === 'true';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

interface CharacterRow {
  id: string;
  player_id: string;
  level: number;
  xp: number;
  current_hp: number | null;
  hp_updated_at: string;
  current_mp: number | null; // null=満タン（HP と同じ管理資源）
  mp_updated_at: string; // MP 自然回復の起点（HP と独立クロック）
  dispatch_ends_at: string | null; // null=未派遣
  dispatch_pending: PendingDispatch | null; // 派遣中に退避した確定用データ
  stats: CharacterBuild['stats'];
  spell_lines: CharacterBuild['spellLines'];
  equipment: CharacterBuild['equipment'];
}

/** enemy_catalog 行（完全DB管理の敵マスタ。build へ組み替えて dive の遭遇表に載せる）。 */
interface EnemyRow {
  id: string;
  name: string;
  level: number;
  stats: CharacterBuild['stats'];
  spell_lines: CharacterBuild['spellLines'];
  equipment: CharacterBuild['equipment'];
}

/** 派遣開始時に退避し、帰還（collect）で適用する確定データ。dive は決定論なので開始時に一度だけ回す。 */
interface PendingDispatch {
  seed: number;
  dungeonId: string;
  dungeonName: string;
  minutes: number; // 指定した潜航時間（分）
  startHp: number;
  startMp: number;
  startedAt: string; // ISO
  endsAt: string; // ISO（体力0の強制帰還なら指定より早い）
  result: DiveResult; // 退避した明細（受け取りで DB へ）
  newXpTotal: number;
  level: number;
  leveledUp: number;
}

function toBuild(row: CharacterRow): CharacterBuild {
  return {
    characterId: row.id,
    level: row.level,
    stats: row.stats,
    spellLines: row.spell_lines,
    equipment: row.equipment,
  };
}

// service_role 用の共通ヘッダ（RLS を越えて書き込む）
function svcHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** 呼び出し元トークンで自分のキャラを読む（RLS が所有者確認） */
async function readOwnedCharacter(
  authHeader: string,
  characterId: string,
): Promise<CharacterRow | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/characters?id=eq.${characterId}&select=*`,
    { headers: { apikey: ANON_KEY, Authorization: authHeader } },
  );
  const rows = await res.json();
  if (!res.ok || !Array.isArray(rows) || rows.length === 0) return null;
  return rows[0] as CharacterRow;
}

/** 現在の実効体力＝保存 current_hp に自然回復を反映（null=満タン扱い） */
function effectiveHp(row: CharacterRow, maxHp: number, now: number): number {
  const stored = row.current_hp ?? maxHp;
  const elapsedMin = (now - Date.parse(row.hp_updated_at)) / 60000;
  return staminaRecover(stored, maxHp, elapsedMin);
}

/** 現在の実効MP＝保存 current_mp に自然回復を反映（null=満タン扱い・HP と同じ仕組み・同レート） */
function effectiveMp(row: CharacterRow, maxMp: number, now: number): number {
  const stored = row.current_mp ?? maxMp;
  const elapsedMin = (now - Date.parse(row.mp_updated_at)) / 60000;
  return staminaRecover(stored, maxMp, elapsedMin);
}

/** ダンジョン定義＋表示名を取得（共有コンテンツ＝anon で読める）。 */
async function fetchDungeon(
  authHeader: string,
  dungeonId: string,
): Promise<{ def: DungeonDef; name: string } | null> {
  const dRes = await fetch(
    `${SUPABASE_URL}/rest/v1/dungeons?id=eq.${dungeonId}&select=*`,
    { headers: { apikey: ANON_KEY, Authorization: authHeader } },
  );
  const dRows = await dRes.json();
  if (!dRes.ok || !Array.isArray(dRows) || dRows.length === 0) return null;
  const drow = dRows[0] as {
    name: string;
    slug: string;
    difficulty: number;
    // 新形式: { kind, id, weight }。旧形式 { equipment_id, weight } も一応受ける（移行前データ保険）。
    drop_table: { kind?: string; id?: string; equipment_id?: string; weight: number }[];
    encounter_table: { enemy_id: string; weight: number }[];
  };

  // 遭遇表の enemy_id を enemy_catalog（完全DB管理）から解決し、敵ビルドを組む。
  const encRaw = drow.encounter_table ?? [];
  const enemyIds = [...new Set(encRaw.map((e) => e.enemy_id))];
  const enemyById: Record<string, EnemyRow> = {};
  if (enemyIds.length > 0) {
    const eRes = await fetch(
      `${SUPABASE_URL}/rest/v1/enemy_catalog?id=in.(${enemyIds.join(',')})&select=*`,
      { headers: { apikey: ANON_KEY, Authorization: authHeader } },
    );
    const eRows = await eRes.json();
    if (Array.isArray(eRows)) for (const r of eRows as EnemyRow[]) enemyById[r.id] = r;
  }
  const encounterTable = encRaw.flatMap((e) => {
    const er = enemyById[e.enemy_id];
    if (!er) return []; // カタログに無い id はスキップ（編成ミスで潜航全体を落とさない）
    return [{
      build: {
        characterId: er.id,
        level: er.level,
        stats: er.stats,
        spellLines: er.spell_lines,
        equipment: er.equipment,
      },
      weight: e.weight,
    }];
  });

  return {
    name: drow.name,
    def: {
      slug: drow.slug,
      difficulty: drow.difficulty,
      dropTable: (drow.drop_table ?? []).map((e) => ({
        kind: (e.kind ?? 'equipment') as 'equipment' | 'item',
        id: e.id ?? e.equipment_id ?? '',
        weight: e.weight,
      })),
      encounterTable,
    },
  };
}

/** プレイヤーに消耗アイテムを count 個付与（player_items.quantity を read-modify-write で加算）。 */
async function grantItem(playerId: string, itemId: string, count: number): Promise<void> {
  const getRes = await fetch(
    `${SUPABASE_URL}/rest/v1/player_items?player_id=eq.${playerId}&item_id=eq.${itemId}&select=quantity`,
    { headers: svcHeaders() },
  );
  const rows = await getRes.json();
  const existing = Array.isArray(rows) && rows.length > 0 ? Number(rows[0].quantity) : null;
  if (existing === null) {
    await fetch(`${SUPABASE_URL}/rest/v1/player_items`, {
      method: 'POST',
      headers: svcHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ player_id: playerId, item_id: itemId, quantity: count }),
    });
  } else {
    await fetch(
      `${SUPABASE_URL}/rest/v1/player_items?player_id=eq.${playerId}&item_id=eq.${itemId}`,
      {
        method: 'PATCH',
        headers: svcHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ quantity: existing + count }),
      },
    );
  }
}

/** dive の帰結を DB に反映（char 更新＋ゴールド＋ドロップ＋履歴）。dispatch_* もここでクリアする。 */
async function applyRewards(
  row: CharacterRow,
  p: PendingDispatch,
  returnedAtIso: string,
): Promise<{ dispatchId: string } | { error: unknown }> {
  const r = p.result;
  const charPatch = await fetch(`${SUPABASE_URL}/rest/v1/characters?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: svcHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({
      xp: p.newXpTotal,
      level: p.level,
      current_hp: r.hpRemaining,
      hp_updated_at: returnedAtIso, // 帰還時刻＝HP 自然回復の起点
      current_mp: r.mpRemaining,
      mp_updated_at: returnedAtIso, // 帰還時刻＝MP 自然回復の起点
      dispatch_ends_at: null, // 留守を解除
      dispatch_pending: null,
    }),
  });
  if (!charPatch.ok) return { error: await charPatch.json() };

  if (r.totalGold > 0) {
    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}&select=gold`,
      { headers: svcHeaders() },
    );
    const pRows = await pRes.json();
    const curGold = Number(pRows?.[0]?.gold ?? 0);
    await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}`, {
      method: 'PATCH',
      headers: svcHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ gold: curGold + r.totalGold }),
    });
  }

  // ドロップを kind で振り分け（装備＝所持有無 / アイテム＝個数）。
  const equipDrops = r.drops.filter((d) => d.kind === 'equipment');
  const itemDrops = r.drops.filter((d) => d.kind === 'item');

  for (const d of equipDrops) {
    await fetch(`${SUPABASE_URL}/rest/v1/player_equipment`, {
      method: 'POST',
      headers: svcHeaders({ Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify({ player_id: row.player_id, equipment_id: d.id }),
    });
  }

  // アイテムは同一 id をまとめて数量加算（player_items.quantity へ read-modify-write）。
  const itemCounts: Record<string, number> = {};
  for (const d of itemDrops) itemCounts[d.id] = (itemCounts[d.id] ?? 0) + 1;
  for (const [itemId, count] of Object.entries(itemCounts)) {
    await grantItem(row.player_id, itemId, count);
  }

  const dispInsert = await fetch(`${SUPABASE_URL}/rest/v1/dispatches`, {
    method: 'POST',
    headers: svcHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({
      player_id: row.player_id,
      character_id: row.id,
      dungeon_id: p.dungeonId,
      minutes: p.minutes,
      seed: p.seed,
      start_hp: p.startHp,
      end_reason: r.endReason,
      xp_gained: r.totalXp,
      gold_gained: r.totalGold,
      hp_remaining: r.hpRemaining,
      result: r,
    }),
  });
  const disp = await dispInsert.json();
  if (!dispInsert.ok) return { error: disp };
  return { dispatchId: disp[0].id };
}

/** 帰還サマリ（アプリの DispatchResult 契約）。 */
function buildReport(p: PendingDispatch, dispatchId: string): Record<string, unknown> {
  const r = p.result;
  return {
    dispatchId,
    battles: r.battles.length,
    endReason: r.endReason,
    xpGained: r.totalXp,
    goldGained: r.totalGold,
    drops: r.drops,
    level: p.level,
    leveledUp: p.leveledUp,
    hpRemaining: r.hpRemaining,
    mpRemaining: r.mpRemaining,
    startHp: p.startHp,
  };
}

/**
 * 共通の派遣シミュ: 実効体力から dive() を回し、退避用 PendingDispatch を組む（DBへの適用はしない）。
 * 帰還予定時刻 endsAt は実際に潜った時間（minutesElapsed）＝体力0の強制帰還なら指定より早い。
 */
function simulateDispatch(
  row: CharacterRow,
  dungeon: { def: DungeonDef; name: string },
  dungeonId: string,
  minutes: number,
  now: number,
): { pending: PendingDispatch; startHp: number } | null {
  const maxHp = maxHP(row.stats.vit);
  const maxMp = maxMP(row.stats.mag);
  const startHp = effectiveHp(row, maxHp, now);
  if (startHp <= 0) return null; // 体力切れ
  const startMp = effectiveMp(row, maxMp, now); // MP は 0 でも派遣可（魔法が撃てず物理で戦う）

  const seed = Math.floor(Math.random() * 0x7fffffff);
  const result = dive(toBuild(row), dungeon.def, seed, minutes, { startHp, startMp });
  const prog = gainXp(row.xp, result.totalXp);
  const endsAt = now + minutes * 60000; // 指定した派遣時間ぶん留守にする（早期KOでも帰還は指定時刻）

  return {
    startHp,
    pending: {
      seed,
      dungeonId,
      dungeonName: dungeon.name,
      minutes,
      startHp,
      startMp,
      startedAt: new Date(now).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      result,
      newXpTotal: Number(row.xp) + result.totalXp,
      level: prog.progress.level,
      leveledUp: prog.leveledUp,
    },
  };
}

/** 派遣を「開始」する（実時間・非同期）。結果は退避し、帰還予定時刻まで留守にする。 */
async function handleDispatch(authHeader: string, body: Record<string, unknown>): Promise<Response> {
  const characterId = body.characterId as string | undefined;
  const dungeonId = body.dungeonId as string | undefined;
  const minutes = Number(body.minutes);
  if (!characterId || !dungeonId) return json({ error: 'characterId と dungeonId が必要' }, 400);
  if (!Number.isFinite(minutes) || minutes <= 0) return json({ error: 'minutes は正の数' }, 400);

  const row = await readOwnedCharacter(authHeader, characterId);
  if (!row) return json({ error: 'character not found or not owned' }, 404);
  if (row.dispatch_ends_at) return json({ error: 'すでに派遣中（帰還を待つ）' }, 409);

  const dungeon = await fetchDungeon(authHeader, dungeonId);
  if (!dungeon) return json({ error: 'dungeon not found' }, 404);

  const now = Date.now();
  const sim = simulateDispatch(row, dungeon, dungeonId, minutes, now);
  if (!sim) return json({ error: 'resting: 体力が尽きている（回復薬か自然回復を待つ）' }, 409);

  // 退避＋留守フラグをセット（報酬はまだ渡さない）。
  const patch = await fetch(`${SUPABASE_URL}/rest/v1/characters?id=eq.${characterId}`, {
    method: 'PATCH',
    headers: svcHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({
      dispatch_ends_at: sim.pending.endsAt,
      dispatch_pending: sim.pending,
    }),
  });
  if (!patch.ok) return json({ error: 'dispatch 開始失敗', detail: await patch.json() }, 502);

  const minutesRemaining = Math.max(1, Math.ceil((Date.parse(sim.pending.endsAt) - now) / 60000));
  return json({
    status: 'dispatched',
    dungeonName: dungeon.name,
    endsAt: sim.pending.endsAt,
    minutesRemaining,
  });
}

/** ★デバッグ用: 旧挙動。押した瞬間に解決して即報酬まで反映（留守にしない）。 */
async function handleDispatchInstant(authHeader: string, body: Record<string, unknown>): Promise<Response> {
  const characterId = body.characterId as string | undefined;
  const dungeonId = body.dungeonId as string | undefined;
  const minutes = Number(body.minutes);
  if (!characterId || !dungeonId) return json({ error: 'characterId と dungeonId が必要' }, 400);
  if (!Number.isFinite(minutes) || minutes <= 0) return json({ error: 'minutes は正の数' }, 400);

  const row = await readOwnedCharacter(authHeader, characterId);
  if (!row) return json({ error: 'character not found or not owned' }, 404);
  if (row.dispatch_ends_at) return json({ error: 'すでに派遣中（先に帰還を受け取る）' }, 409);

  const dungeon = await fetchDungeon(authHeader, dungeonId);
  if (!dungeon) return json({ error: 'dungeon not found' }, 404);

  const now = Date.now();
  const sim = simulateDispatch(row, dungeon, dungeonId, minutes, now);
  if (!sim) return json({ error: 'resting: 体力が尽きている（回復薬か自然回復を待つ）' }, 409);

  const applied = await applyRewards(row, sim.pending, new Date(now).toISOString());
  if ('error' in applied) return json({ error: 'dispatch 保存失敗', detail: applied.error }, 502);
  return json(buildReport(sim.pending, applied.dispatchId));
}

/** 帰還予定時刻を過ぎていれば、退避した結果を確定して受け取る。 */
async function handleCollect(authHeader: string, body: Record<string, unknown>): Promise<Response> {
  const characterId = body.characterId as string | undefined;
  if (!characterId) return json({ error: 'characterId が必要' }, 400);

  const row = await readOwnedCharacter(authHeader, characterId);
  if (!row) return json({ error: 'character not found or not owned' }, 404);
  const pending = row.dispatch_pending;
  if (!row.dispatch_ends_at || !pending) return json({ error: '派遣していない' }, 409);

  const now = Date.now();
  const endsMs = Date.parse(row.dispatch_ends_at);
  if (now < endsMs) {
    return json({ error: 'まだ帰還していない', minutesRemaining: Math.ceil((endsMs - now) / 60000) }, 409);
  }

  const applied = await applyRewards(row, pending, row.dispatch_ends_at);
  if ('error' in applied) return json({ error: 'dispatch 受け取り失敗', detail: applied.error }, 502);
  return json(buildReport(pending, applied.dispatchId));
}

/**
 * 現在の実効体力（自然回復を反映）と回復ETAを返す（ホーム表示用）。
 * 回復式の正本は engine staminaRecover。表示のためだけの ETA もここ（サーバー）で算出し、
 * クライアントに式を持たせない（企画書13.1「戦闘/成長の計算はサーバー権威」）。
 */
async function handleStatus(authHeader: string, body: Record<string, unknown>): Promise<Response> {
  const characterId = body.characterId as string | undefined;
  if (!characterId) return json({ error: 'characterId が必要' }, 400);

  const row = await readOwnedCharacter(authHeader, characterId);
  if (!row) return json({ error: 'character not found or not owned' }, 404);

  const now = Date.now();
  const maxHp = maxHP(row.stats.vit);
  const maxMp = maxMP(row.stats.mag);

  // 派遣中は「留守」＝自然回復もETAも出さず、帰還までの残り分と受け取り可否だけ返す。
  if (row.dispatch_ends_at) {
    const endsMs = Date.parse(row.dispatch_ends_at);
    const frozenHp = Math.min(maxHp, Math.max(0, row.current_hp ?? maxHp)); // 出発時点のHP（回復させない）
    const frozenMp = Math.min(maxMp, Math.max(0, row.current_mp ?? maxMp)); // 出発時点のMP（回復させない）
    return json({
      hp: frozenHp,
      maxHp,
      mp: frozenMp,
      maxMp,
      resting: false,
      minutesToFull: 0,
      mpMinutesToFull: 0,
      minutesToReady: 0,
      dispatching: true,
      canCollect: now >= endsMs,
      minutesRemaining: Math.max(0, Math.ceil((endsMs - now) / 60000)),
      dungeonName: row.dispatch_pending?.dungeonName ?? '',
    });
  }

  const hp = effectiveHp(row, maxHp, now);
  const mp = effectiveMp(row, maxMp, now);

  // ETA: 保存値 + 経過分×perMin が目標 T に達するまでの残り分（floor(値)>=T ⇔ 値>=T）。
  const elapsedMin = (now - Date.parse(row.hp_updated_at)) / 60000;
  const storedHp = row.current_hp ?? maxHp;
  const perMinHp = CONFIG.dive.regenPctPerMinute * maxHp; // 最大HPの%/分 → HP/分
  const minutesToHp = (target: number): number =>
    perMinHp > 0 ? Math.max(0, Math.ceil((target - storedHp) / perMinHp - elapsedMin)) : 0;

  const elapsedMinMp = (now - Date.parse(row.mp_updated_at)) / 60000;
  const storedMp = row.current_mp ?? maxMp;
  const perMinMp = CONFIG.dive.regenPctPerMinute * maxMp; // 最大MPの%/分 → MP/分（HPと同レート）
  const mpMinutesToFull = mp >= maxMp
    ? 0
    : (perMinMp > 0 ? Math.max(0, Math.ceil((maxMp - storedMp) / perMinMp - elapsedMinMp)) : 0);

  return json({
    hp,
    maxHp,
    mp,
    maxMp,
    resting: hp <= 0,
    minutesToFull: hp >= maxHp ? 0 : minutesToHp(maxHp), // HP 満タンまで
    mpMinutesToFull, // MP 満タンまで
    minutesToReady: hp >= 1 ? 0 : minutesToHp(1), // 派遣可能（HP 1以上）まで
    dispatching: false,
    canCollect: false,
    minutesRemaining: 0,
    dungeonName: '',
  });
}

/**
 * 所持アイテム（回復薬）を1つ使う。効果の正本は DB item_catalog（effect_kind/effect_pct）。
 * 回復は「自然回復込みの実効HP/MP」から加算し、最大値で頭打ち（例: 10%薬は現在値+最大の10%）。
 * 消費後 player_items.quantity を減算（0 なら行を削除）。
 */
async function handleUseItem(authHeader: string, body: Record<string, unknown>): Promise<Response> {
  const characterId = body.characterId as string | undefined;
  const itemId = body.itemId as string | undefined;
  if (!characterId || !itemId) return json({ error: 'characterId と itemId が必要' }, 400);

  // 効果の正本は DB item_catalog（マスタ）。service_role で読む。
  const catRes = await fetch(
    `${SUPABASE_URL}/rest/v1/item_catalog?id=eq.${itemId}&select=effect_kind,effect_pct`,
    { headers: svcHeaders() },
  );
  const catRows = await catRes.json();
  if (!Array.isArray(catRows) || catRows.length === 0) return json({ error: `未知のアイテム: ${itemId}` }, 400);
  const effectKind = catRows[0].effect_kind as 'hp' | 'mp' | 'both';
  const effectPct = Number(catRows[0].effect_pct);

  const row = await readOwnedCharacter(authHeader, characterId);
  if (!row) return json({ error: 'character not found or not owned' }, 404);
  if (row.dispatch_ends_at) return json({ error: '派遣中は使えない（帰還を待つ）' }, 409);

  // 所持数を service_role で確認
  const iRes = await fetch(
    `${SUPABASE_URL}/rest/v1/player_items?player_id=eq.${row.player_id}&item_id=eq.${itemId}&select=quantity`,
    { headers: svcHeaders() },
  );
  const iRows = await iRes.json();
  const quantity = Array.isArray(iRows) && iRows.length > 0 ? Number(iRows[0].quantity) : 0;
  if (quantity <= 0) return json({ error: 'そのアイテムを持っていない' }, 409);

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const maxHp = maxHP(row.stats.vit);
  const maxMp = maxMP(row.stats.mag);

  // 実効値（自然回復込み）から加算。HP/MP それぞれ触った側だけ回復クロック(now)を打ち直す。
  const patch: Record<string, unknown> = {};
  let newHp = effectiveHp(row, maxHp, now);
  let newMp = effectiveMp(row, maxMp, now);
  if (effectKind === 'hp' || effectKind === 'both') {
    newHp = Math.min(maxHp, newHp + Math.floor(maxHp * effectPct));
    patch.current_hp = newHp;
    patch.hp_updated_at = nowIso;
  }
  if (effectKind === 'mp' || effectKind === 'both') {
    newMp = Math.min(maxMp, newMp + Math.floor(maxMp * effectPct));
    patch.current_mp = newMp;
    patch.mp_updated_at = nowIso;
  }

  await fetch(`${SUPABASE_URL}/rest/v1/characters?id=eq.${characterId}`, {
    method: 'PATCH',
    headers: svcHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(patch),
  });

  // 数量を減算（0 になったら行を削除＝インベントリを綺麗に保つ）。
  const left = quantity - 1;
  const itemFilter = `player_id=eq.${row.player_id}&item_id=eq.${itemId}`;
  if (left <= 0) {
    await fetch(`${SUPABASE_URL}/rest/v1/player_items?${itemFilter}`, {
      method: 'DELETE',
      headers: svcHeaders({ Prefer: 'return=minimal' }),
    });
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/player_items?${itemFilter}`, {
      method: 'PATCH',
      headers: svcHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ quantity: left }),
    });
  }

  return json({ itemId, hp: newHp, maxHp, mp: newMp, maxMp, quantityLeft: left });
}

interface ShopListingRow {
  id: string;
  product_type: 'equipment' | 'item';
  equipment_id: string | null;
  item_id: string | null;
  name: string;
  price: number;
  starts_at: string | null; // null = 販売開始の制限なし
  ends_at: string | null; // null = 無期限
  active: boolean;
}

/** 販売リスト（ショップマスタ）の1行が「今」買えるか＝有効か＋期間内か。now はサーバー時刻。 */
function listingSaleableNow(l: ShopListingRow, now: number): boolean {
  if (!l.active) return false;
  if (l.starts_at && now < Date.parse(l.starts_at)) return false; // まだ販売前
  if (l.ends_at && now >= Date.parse(l.ends_at)) return false; // 販売終了
  return true;
}

/**
 * ショップ購入（ゴールドの出口・企画書3.6「店＝ゴールドで狙い撃ち」／3.3 回復薬）。
 * 「何を・いくらで・いつ売るか」の正本は DB のショップマスタ shop_listings（listingId で指定）。
 *   → 価格も販売期間も、マスタ行を service_role で読んでサーバー権威に検証（クライアント申告は信じない・企画書13.6）。
 * gold 減算 → 所持付与の順で実行（M4/M5 と同水準の逐次 REST。厳密なトランザクションは後日）。
 *   ・equipment: 「型」＝所持有無。既に持っていれば 409（重複所持しない）。付与は player_equipment 1行。
 *   ・item     : 消耗品。quantity 個（既定1）を grantItem で加算。
 */
async function handleBuy(authHeader: string, body: Record<string, unknown>): Promise<Response> {
  const characterId = body.characterId as string | undefined;
  const listingId = body.listingId as string | undefined;
  if (!characterId || !listingId) return json({ error: 'characterId と listingId が必要' }, 400);

  // 認証＋所有者解決（run-dispatch の他アクションと同じく characterId から player_id を得る）。
  const row = await readOwnedCharacter(authHeader, characterId);
  if (!row) return json({ error: 'character not found or not owned' }, 404);

  // ショップマスタから該当の販売行を service_role で読む（RLS 越し＝クライアントには隠れていてよい）。
  const lRes = await fetch(
    `${SUPABASE_URL}/rest/v1/shop_listings?id=eq.${listingId}` +
      `&select=id,product_type,equipment_id,item_id,name,price,starts_at,ends_at,active`,
    { headers: svcHeaders() },
  );
  const lRows = await lRes.json();
  const listing = Array.isArray(lRows) && lRows.length > 0 ? lRows[0] as ShopListingRow : null;
  if (!listing) return json({ error: 'その商品は存在しない' }, 404);

  // 販売期間の権威的チェック（サーバー時刻）。
  const now = Date.now();
  if (!listingSaleableNow(listing, now)) return json({ error: '現在は販売していない（販売期間外）' }, 409);

  const kind = listing.product_type;
  const refId = kind === 'equipment' ? listing.equipment_id : listing.item_id;
  if (!refId) return json({ error: '商品データが不正（参照先なし）' }, 500);

  // 数量：装備は常に1（型＝所持有無）。アイテムのみ複数可。
  const qty = kind === 'item' ? Math.max(1, Math.floor(Number(body.quantity ?? 1))) : 1;
  const total = listing.price * qty;

  // 装備は先に「既に所持していないか」を確認（gold を減らす前に弾く）。
  if (kind === 'equipment') {
    const ownRes = await fetch(
      `${SUPABASE_URL}/rest/v1/player_equipment?player_id=eq.${row.player_id}&equipment_id=eq.${refId}&select=id`,
      { headers: svcHeaders() },
    );
    const owned = await ownRes.json();
    if (Array.isArray(owned) && owned.length > 0) return json({ error: 'その装備は既に所持している' }, 409);
  }

  // 所持ゴールドを service_role で読み、価格と照合。
  const pRes = await fetch(
    `${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}&select=gold`,
    { headers: svcHeaders() },
  );
  const pRows = await pRes.json();
  const gold = Array.isArray(pRows) && pRows.length > 0 ? Number(pRows[0].gold) : 0;
  if (gold < total) return json({ error: 'ゴールドが足りない', price: total, gold }, 409);

  // gold 減算 → 付与。
  const dec = await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}`, {
    method: 'PATCH',
    headers: svcHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ gold: gold - total }),
  });
  if (!dec.ok) return json({ error: '購入失敗（gold 減算）', detail: await dec.json() }, 502);

  let quantityLeft: number | undefined;
  if (kind === 'equipment') {
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/player_equipment`, {
      method: 'POST',
      headers: svcHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ player_id: row.player_id, equipment_id: refId }),
    });
    if (!ins.ok) {
      // 付与に失敗したら gold を戻す（ベストエフォートの補償）。
      await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}`, {
        method: 'PATCH',
        headers: svcHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify({ gold }),
      });
      return json({ error: '購入失敗（装備付与）', detail: await ins.json() }, 502);
    }
  } else {
    await grantItem(row.player_id, refId, qty);
    const qRes = await fetch(
      `${SUPABASE_URL}/rest/v1/player_items?player_id=eq.${row.player_id}&item_id=eq.${refId}&select=quantity`,
      { headers: svcHeaders() },
    );
    const qRows = await qRes.json();
    quantityLeft = Array.isArray(qRows) && qRows.length > 0 ? Number(qRows[0].quantity) : qty;
  }

  return json({
    listingId,
    kind,
    id: refId,
    name: listing.name,
    quantity: qty,
    goldSpent: total,
    goldLeft: gold - total,
    quantityLeft,
  });
}

/** カタログの売却価格を service_role で引く（正本＝DB マスタ。null=売却不可）。 */
async function sellPriceOf(kind: 'equipment' | 'item', id: string): Promise<number | null | undefined> {
  const table = kind === 'equipment' ? 'equipment_catalog' : 'item_catalog';
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&select=sell_price`, { headers: svcHeaders() });
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return undefined; // カタログに無い＝未知
  return rows[0].sell_price === null ? null : Number(rows[0].sell_price); // null=売却不可
}

/**
 * ショップでの売却（不要な装備/アイテムをゴールドに換える）。
 * 売却価格の正本は catalog.sell_price（DB マスタ）＝クライアント申告は信じない（企画書13.6）。
 *   ・equipment: 所持（player_equipment）を1つ手放して gold 加算。装備中のものは売れない（409）。
 *   ・item     : player_items.quantity を quantity 個（既定1）減らして gold 加算。
 * 所持減 → gold 加算の順で実行（M4/M5 と同水準の逐次 REST）。
 */
async function handleSell(authHeader: string, body: Record<string, unknown>): Promise<Response> {
  const characterId = body.characterId as string | undefined;
  const kind = body.kind as string | undefined;
  const id = body.id as string | undefined;
  if (!characterId || !id || (kind !== 'equipment' && kind !== 'item')) {
    return json({ error: "characterId・id・kind('equipment'|'item') が必要" }, 400);
  }

  const row = await readOwnedCharacter(authHeader, characterId);
  if (!row) return json({ error: 'character not found or not owned' }, 404);
  if (row.dispatch_ends_at) return json({ error: '派遣中は売れない（帰還を待つ）' }, 409);

  const unit = await sellPriceOf(kind, id);
  if (unit === undefined) return json({ error: `未知の${kind === 'equipment' ? '装備' : 'アイテム'}: ${id}` }, 400);
  if (unit === null) return json({ error: 'これは売却できない' }, 409);

  const qty = kind === 'item' ? Math.max(1, Math.floor(Number(body.quantity ?? 1))) : 1;

  // 所持ゴールドを読む（加算のため）。
  const pRes = await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}&select=gold`, { headers: svcHeaders() });
  const pRows = await pRes.json();
  const gold = Array.isArray(pRows) && pRows.length > 0 ? Number(pRows[0].gold) : 0;

  let quantityLeft: number | undefined;

  if (kind === 'equipment') {
    // 装備中（キャラが今つけている）ものは売らせない。
    const eq = row.equipment;
    if (eq && (eq.weapon === id || eq.armor === id || eq.shield === id)) {
      return json({ error: '装備中のものは売れない（外してから）' }, 409);
    }
    // 所持を確認 → 削除。
    const ownRes = await fetch(
      `${SUPABASE_URL}/rest/v1/player_equipment?player_id=eq.${row.player_id}&equipment_id=eq.${id}&select=id`,
      { headers: svcHeaders() },
    );
    const owned = await ownRes.json();
    if (!Array.isArray(owned) || owned.length === 0) return json({ error: 'その装備を持っていない' }, 409);
    const del = await fetch(
      `${SUPABASE_URL}/rest/v1/player_equipment?player_id=eq.${row.player_id}&equipment_id=eq.${id}`,
      { method: 'DELETE', headers: svcHeaders({ Prefer: 'return=minimal' }) },
    );
    if (!del.ok) return json({ error: '売却失敗（装備削除）', detail: await del.json() }, 502);
  } else {
    // 所持数を確認 → quantity 個 減算（0 で行削除）。
    const iRes = await fetch(
      `${SUPABASE_URL}/rest/v1/player_items?player_id=eq.${row.player_id}&item_id=eq.${id}&select=quantity`,
      { headers: svcHeaders() },
    );
    const iRows = await iRes.json();
    const have = Array.isArray(iRows) && iRows.length > 0 ? Number(iRows[0].quantity) : 0;
    if (have < qty) return json({ error: '売る個数が足りない', have }, 409);
    const left = have - qty;
    const filter = `player_id=eq.${row.player_id}&item_id=eq.${id}`;
    if (left <= 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/player_items?${filter}`, {
        method: 'DELETE', headers: svcHeaders({ Prefer: 'return=minimal' }),
      });
    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/player_items?${filter}`, {
        method: 'PATCH', headers: svcHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ quantity: left }),
      });
    }
    quantityLeft = left;
  }

  // gold 加算。
  const total = unit * qty;
  const inc = await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}`, {
    method: 'PATCH', headers: svcHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ gold: gold + total }),
  });
  if (!inc.ok) return json({ error: '売却失敗（gold 加算）', detail: await inc.json() }, 502);

  return json({ kind, id, quantity: qty, goldGained: total, goldLeft: gold + total, quantityLeft });
}

/**
 * ★デバッグ専用：コインを付与する（ショップ購入などを試すため）。
 * 二重ガード：① env `DEBUG_TOOLS=true`（本番は未設定＝ここで 403）／② クライアント側は kDebugMode でボタン非表示。
 * 本番でこの env を設定しないこと（デプロイの secrets に DEBUG_TOOLS を入れない）＝機能そのものが存在しなくなる。
 */
async function handleDebugGrantGold(authHeader: string, body: Record<string, unknown>): Promise<Response> {
  if (!DEBUG_TOOLS) return json({ error: 'デバッグ機能は無効（本番では使えません）' }, 403);

  const characterId = body.characterId as string | undefined;
  if (!characterId) return json({ error: 'characterId が必要' }, 400);
  const amount = Math.floor(Number(body.amount ?? 1000));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    return json({ error: 'amount は 1〜1000000' }, 400);
  }

  const row = await readOwnedCharacter(authHeader, characterId);
  if (!row) return json({ error: 'character not found or not owned' }, 404);

  const pRes = await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}&select=gold`, { headers: svcHeaders() });
  const pRows = await pRes.json();
  const gold = Array.isArray(pRows) && pRows.length > 0 ? Number(pRows[0].gold) : 0;

  const inc = await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}`, {
    method: 'PATCH', headers: svcHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ gold: gold + amount }),
  });
  if (!inc.ok) return json({ error: 'コイン付与失敗', detail: await inc.json() }, 502);

  return json({ granted: amount, goldLeft: gold + amount });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing Authorization' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  switch (body.action) {
    case 'dispatch':
      return await handleDispatch(authHeader, body);
    case 'dispatch_instant':
      return await handleDispatchInstant(authHeader, body);
    case 'collect':
      return await handleCollect(authHeader, body);
    case 'use_item':
      return await handleUseItem(authHeader, body);
    case 'buy':
      return await handleBuy(authHeader, body);
    case 'sell':
      return await handleSell(authHeader, body);
    case 'debug_grant_gold':
      return await handleDebugGrantGold(authHeader, body);
    case 'status':
      return await handleStatus(authHeader, body);
    default:
      return json({
        error: "action は 'dispatch' | 'dispatch_instant' | 'collect' | 'use_item' | 'buy' | 'sell' | 'status'",
      }, 400);
  }
});
