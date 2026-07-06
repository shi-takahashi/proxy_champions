/**
 * M4: 即時オート1戦（薄い縦スライスのサーバー層・実装プラン M4 / 継ぎ目①）。
 *
 *   POST /functions/v1/run-battle   body: { characterId }   header: Authorization: Bearer <jwt>
 *   → 呼び出し元のキャラ vs 固定スパーリングダミーを battle() で決定論計算
 *   → matches に結果＋eventLog を保存（書き込みは service_role が RLS を越えて実行）
 *   → { matchId } を返す
 *
 * engine（依存ゼロTS）を同一ソースで相対 import＝「戦闘エンジンは1回だけ実装」（企画書13.1）。
 * ローカル `supabase functions serve` は Deno なので関数フォルダ外の相対 import が解決できる。
 */
// engine の正本は engine/src。edge runtime は functions ディレクトリ外を import できないため、
// `deno task sync-edge`（engine/）で functions/_engine/ に実ファイルとして vendor し、ここから import する。
// _engine は生成物（.gitignore 済）＝ engine を変更したら sync-edge を再実行する。
import { battle1v1 } from '../_engine/battle.ts';
import type { CharacterBuild } from '../_engine/schema.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// 固定スパーリング相手（企画書5.3 練習試合）。M4 では DB に seed せず関数内定数で持つ。
// 再生の正本は eventLog（seed＋この定数ビルドで完全再現可能・実装プラン M4）。
const SPARRING_DUMMY: CharacterBuild = {
  characterId: 'sparring-dummy',
  level: 10,
  stats: { vit: 10, mag: 5, pow: 10, spd: 8, men: 6 },
  spellLines: { fire: 0, cure: 0, sleep: 0, strength: 0 },
  equipment: { weapon: 'sword_iron', armor: 'mail_leather', shield: 'shield_wood' },
};

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

// DB 行（snake_case）→ engine の CharacterBuild（camelCase 契約）
function toBuild(row: {
  id: string;
  level: number;
  stats: CharacterBuild['stats'];
  spell_lines: CharacterBuild['spellLines'];
  equipment: CharacterBuild['equipment'];
}): CharacterBuild {
  return {
    characterId: row.id,
    level: row.level,
    stats: row.stats,
    spellLines: row.spell_lines,
    equipment: row.equipment,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing Authorization' }, 401);

  let characterId: string | undefined;
  try {
    ({ characterId } = await req.json());
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!characterId) return json({ error: 'characterId required' }, 400);

  // 1. 呼び出し元トークンで自分のキャラを読む（RLS が所有者確認）
  const readRes = await fetch(
    `${SUPABASE_URL}/rest/v1/characters?id=eq.${characterId}&select=*`,
    { headers: { apikey: ANON_KEY, Authorization: authHeader } },
  );
  const rows = await readRes.json();
  if (!readRes.ok) return json({ error: 'character read failed', detail: rows }, 502);
  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ error: 'character not found or not owned' }, 404);
  }
  const player = toBuild(rows[0]);

  // 2. 決定論計算（毎試合新規シード＝記録すれば再現・企画書13.4）
  const seed = Math.floor(Math.random() * 0x7fffffff);
  const result = battle1v1(player, SPARRING_DUMMY, seed);

  // 3. service_role で matches へ保存（書き込みは service_role のみ＝RLS insert ポリシー無し）
  //    即時オート1戦なので tournament_id / character_b / round は null。
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/matches`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      tournament_id: null,
      round: null,
      character_a: player.characterId,
      character_b: null,
      seed: result.seed,
      winner: result.winner,
      turns: result.turns,
      event_log: result.eventLog,
      status: 'done',
      processed_at: new Date().toISOString(),
    }),
  });
  const inserted = await insertRes.json();
  if (!insertRes.ok) return json({ error: 'match insert failed', detail: inserted }, 502);

  return json({ matchId: inserted[0].id, winner: result.winner, turns: result.turns });
});
