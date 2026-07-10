/**
 * M5.3: 派遣ダンジョン（育成ループのサーバー層・実装プラン M5.3 / 継ぎ目①）。
 *
 *   POST /functions/v1/run-dispatch   header: Authorization: Bearer <jwt>
 *   body:
 *     { action: 'dispatch', characterId, dungeonId, minutes }
 *        → 現在の体力（自然回復を反映）から dive() を回し、XP/ゴールド/体力/ドロップを DB に反映
 *          ・xp→level は engine growth(gainXp) が正本（level 列を materialize）
 *          ・体力ループ: 帰還時 hpRemaining を current_hp に保存（次の派遣へ持ち越す）
 *     { action: 'use_potion', characterId }
 *        → 回復薬を1つ消費して体力を満タンに（players.potions を減算）
 *     { action: 'status', characterId }
 *        → 現在の実効体力（自然回復込み）と回復ETA（満タン/派遣可能まで）を返す（ホーム表示用）
 *
 * engine は同一ソースを相対 import（"戦闘エンジンは1回だけ実装"／企画書13.1）。
 * engine を変更したら engine/ で `deno task sync-edge` を再実行して _engine を更新する。
 * 報酬計算はすべて service_role でサーバー権威に閉じる（不正対策・企画書13.6）。
 */
import { dive, staminaRecover } from '../_engine/dive.ts';
import { gainXp } from '../_engine/growth.ts';
import { CONFIG, maxHP } from '../_engine/formulas.ts';
import type { CharacterBuild, DungeonDef } from '../_engine/schema.ts';

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
  stats: CharacterBuild['stats'];
  spell_lines: CharacterBuild['spellLines'];
  equipment: CharacterBuild['equipment'];
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

async function handleDispatch(authHeader: string, body: Record<string, unknown>): Promise<Response> {
  const characterId = body.characterId as string | undefined;
  const dungeonId = body.dungeonId as string | undefined;
  const minutes = Number(body.minutes);
  if (!characterId || !dungeonId) return json({ error: 'characterId と dungeonId が必要' }, 400);
  if (!Number.isFinite(minutes) || minutes <= 0) return json({ error: 'minutes は正の数' }, 400);

  // 1. 自分のキャラ
  const row = await readOwnedCharacter(authHeader, characterId);
  if (!row) return json({ error: 'character not found or not owned' }, 404);

  // 2. ダンジョン（共有コンテンツ＝anon で読める）
  const dRes = await fetch(
    `${SUPABASE_URL}/rest/v1/dungeons?id=eq.${dungeonId}&select=*`,
    { headers: { apikey: ANON_KEY, Authorization: authHeader } },
  );
  const dRows = await dRes.json();
  if (!dRes.ok || !Array.isArray(dRows) || dRows.length === 0) {
    return json({ error: 'dungeon not found' }, 404);
  }
  const drow = dRows[0] as { slug: string; difficulty: number; drop_table: { equipment_id: string; weight: number }[] };
  const dungeon: DungeonDef = {
    slug: drow.slug,
    difficulty: drow.difficulty,
    dropTable: (drow.drop_table ?? []).map((e) => ({ equipmentId: e.equipment_id, weight: e.weight })),
  };

  // 3. 実効体力（自然回復込み）から派遣。体力0 は派遣不可（要回復／企画書3.3「体力1以上なら再派遣」）
  const now = Date.now();
  const maxHp = maxHP(row.stats.vit);
  const startHp = effectiveHp(row, maxHp, now);
  if (startHp <= 0) return json({ error: 'resting: 体力が尽きている（回復薬か自然回復を待つ）' }, 409);

  const hero = toBuild(row);
  const seed = Math.floor(Math.random() * 0x7fffffff);
  const result = dive(hero, dungeon, seed, minutes, { startHp });

  // 4. 報酬適用（xp→level は gainXp が正本／体力ループ: hpRemaining を保存）
  const newXpTotal = Number(row.xp) + result.totalXp;
  const prog = gainXp(row.xp, result.totalXp);
  const nowIso = new Date(now).toISOString();

  const charPatch = await fetch(`${SUPABASE_URL}/rest/v1/characters?id=eq.${characterId}`, {
    method: 'PATCH',
    headers: svcHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({
      xp: newXpTotal,
      level: prog.progress.level,
      current_hp: result.hpRemaining,
      hp_updated_at: nowIso,
    }),
  });
  if (!charPatch.ok) {
    return json({ error: 'character 更新失敗', detail: await charPatch.json() }, 502);
  }

  // ゴールドは players に加算（現在値を service_role で読んで足す）
  if (result.totalGold > 0) {
    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}&select=gold`,
      { headers: svcHeaders() },
    );
    const pRows = await pRes.json();
    const curGold = Number(pRows?.[0]?.gold ?? 0);
    await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${row.player_id}`, {
      method: 'PATCH',
      headers: svcHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ gold: curGold + result.totalGold }),
    });
  }

  // ドロップ装備を所持に反映（型は所持有無＝重複は無視）
  for (const equipmentId of result.drops) {
    await fetch(`${SUPABASE_URL}/rest/v1/player_equipment`, {
      method: 'POST',
      headers: svcHeaders({ Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify({ player_id: row.player_id, equipment_id: equipmentId }),
    });
  }

  // 5. 派遣履歴（DiveResult）を保存
  const dispInsert = await fetch(`${SUPABASE_URL}/rest/v1/dispatches`, {
    method: 'POST',
    headers: svcHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({
      player_id: row.player_id,
      character_id: characterId,
      dungeon_id: dungeonId,
      minutes,
      seed,
      start_hp: startHp,
      end_reason: result.endReason,
      xp_gained: result.totalXp,
      gold_gained: result.totalGold,
      hp_remaining: result.hpRemaining,
      result,
    }),
  });
  const disp = await dispInsert.json();
  if (!dispInsert.ok) return json({ error: 'dispatch 保存失敗', detail: disp }, 502);

  return json({
    dispatchId: disp[0].id,
    battles: result.battles.length,
    endReason: result.endReason,
    xpGained: result.totalXp,
    goldGained: result.totalGold,
    drops: result.drops,
    level: prog.progress.level,
    leveledUp: prog.leveledUp,
    hpRemaining: result.hpRemaining,
    startHp,
  });
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
    case 'use_potion':
      return await handleUsePotion(authHeader, body);
    case 'status':
      return await handleStatus(authHeader, body);
    default:
      return json({ error: "action は 'dispatch' | 'use_potion' | 'status'" }, 400);
  }
});
