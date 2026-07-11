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
 *     { action: 'dispatch_instant', characterId, dungeonId, minutes }   ★デバッグ用
 *        → 旧挙動: 押した瞬間に全連戦を解決して即座に報酬まで反映（動作確認を速くするため温存）。
 *     { action: 'use_potion', characterId }
 *        → 回復薬を1つ消費して体力を満タンに（players.potions を減算）
 *     { action: 'status', characterId }
 *        → 実効体力（自然回復込み）＋回復ETA、および派遣中かどうか/帰還までの残り分を返す（ホーム表示用）
 *
 * engine は同一ソースを相対 import（"戦闘エンジンは1回だけ実装"／企画書13.1）。
 * engine を変更したら engine/ で `deno task sync-edge` を再実行して _engine を更新する。
 * 報酬計算はすべて service_role でサーバー権威に閉じる（不正対策・企画書13.6）。
 */
import { dive, staminaRecover } from '../_engine/dive.ts';
import { gainXp } from '../_engine/growth.ts';
import { CONFIG, maxHP } from '../_engine/formulas.ts';
import type { CharacterBuild, DiveResult, DungeonDef } from '../_engine/schema.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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
  dispatch_ends_at: string | null; // null=未派遣
  dispatch_pending: PendingDispatch | null; // 派遣中に退避した確定用データ
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
    drop_table: { equipment_id: string; weight: number }[];
  };
  return {
    name: drow.name,
    def: {
      slug: drow.slug,
      difficulty: drow.difficulty,
      dropTable: (drow.drop_table ?? []).map((e) => ({ equipmentId: e.equipment_id, weight: e.weight })),
    },
  };
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
      hp_updated_at: returnedAtIso, // 帰還時刻＝自然回復の起点
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

  for (const equipmentId of r.drops) {
    await fetch(`${SUPABASE_URL}/rest/v1/player_equipment`, {
      method: 'POST',
      headers: svcHeaders({ Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify({ player_id: row.player_id, equipment_id: equipmentId }),
    });
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
  const startHp = effectiveHp(row, maxHp, now);
  if (startHp <= 0) return null; // 体力切れ

  const seed = Math.floor(Math.random() * 0x7fffffff);
  const result = dive(toBuild(row), dungeon.def, seed, minutes, { startHp });
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

  // 派遣中は「留守」＝自然回復もETAも出さず、帰還までの残り分と受け取り可否だけ返す。
  if (row.dispatch_ends_at) {
    const endsMs = Date.parse(row.dispatch_ends_at);
    const frozenHp = Math.min(maxHp, Math.max(0, row.current_hp ?? maxHp)); // 出発時点の体力（回復させない）
    return json({
      hp: frozenHp,
      maxHp,
      resting: false,
      minutesToFull: 0,
      minutesToReady: 0,
      dispatching: true,
      canCollect: now >= endsMs,
      minutesRemaining: Math.max(0, Math.ceil((endsMs - now) / 60000)),
      dungeonName: row.dispatch_pending?.dungeonName ?? '',
    });
  }

  const hp = effectiveHp(row, maxHp, now);

  // ETA: 保存 HP + 経過分×perMin が目標 T に達するまでの残り分（floor(値)>=T ⇔ 値>=T）。
  const stored = row.current_hp ?? maxHp;
  const elapsedMin = (now - Date.parse(row.hp_updated_at)) / 60000;
  const perMin = CONFIG.dive.regenPctPerMinute * maxHp; // 最大HPの%/分 → HP/分
  const minutesTo = (target: number): number =>
    perMin > 0 ? Math.max(0, Math.ceil((target - stored) / perMin - elapsedMin)) : 0;

  return json({
    hp,
    maxHp,
    resting: hp <= 0,
    minutesToFull: hp >= maxHp ? 0 : minutesTo(maxHp), // 満タンまで
    minutesToReady: hp >= 1 ? 0 : minutesTo(1), // 派遣可能（1以上）まで
    dispatching: false,
    canCollect: false,
    minutesRemaining: 0,
    dungeonName: '',
  });
}

async function handleUsePotion(authHeader: string, body: Record<string, unknown>): Promise<Response> {
  const characterId = body.characterId as string | undefined;
  if (!characterId) return json({ error: 'characterId が必要' }, 400);

  const row = await readOwnedCharacter(authHeader, characterId);
  if (!row) return json({ error: 'character not found or not owned' }, 404);

  // 所持数を service_role で確認
  const pRes = await fetch(
    `${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}&select=potions`,
    { headers: svcHeaders() },
  );
  const potions = Number((await pRes.json())?.[0]?.potions ?? 0);
  if (potions <= 0) return json({ error: '回復薬を持っていない' }, 409);

  const maxHp = maxHP(row.stats.vit);
  const nowIso = new Date().toISOString();

  await fetch(`${SUPABASE_URL}/rest/v1/characters?id=eq.${characterId}`, {
    method: 'PATCH',
    headers: svcHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ current_hp: maxHp, hp_updated_at: nowIso }),
  });
  await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}`, {
    method: 'PATCH',
    headers: svcHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ potions: potions - 1 }),
  });

  return json({ healedTo: maxHp, potionsLeft: potions - 1 });
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
    case 'use_potion':
      return await handleUsePotion(authHeader, body);
    case 'status':
      return await handleStatus(authHeader, body);
    default:
      return json({
        error: "action は 'dispatch' | 'dispatch_instant' | 'collect' | 'use_potion' | 'status'",
      }, 400);
  }
});
