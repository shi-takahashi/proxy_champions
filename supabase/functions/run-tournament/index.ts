/**
 * M6.2: 個人戦バッチ大会のサーバー層（企画書5章 / 13.5 / 実装プラン M6.2 / 継ぎ目①）。
 *
 *   POST /functions/v1/run-tournament   header: Authorization: Bearer <SERVICE_ROLE_KEY>
 *   body:
 *     { action: 'open', characterIds:[…], divisionId?, name?, season? }
 *        → エントリー確定: 出場者ビルドを snapshot → リーグ全カードを pending で materialize
 *          （各カードの seed は deriveSeed で確定して matches.seed に保存＝冪等の源）
 *     { action: 'tick', tournamentId? }
 *        → 未処理の最小ラウンドを battle() 一斉 → done＋eventLog 保存 → 順位再計算
 *          リーグ完走 → 決勝トーナメント＋昇降格を確定 → status=finished
 *          （pending の行だけ done に倒す＝再実行しても二重処理しない／企画書13.5「冪等」）
 *
 * 管理エンドポイント（cron / 運用が service_role で叩く）。verify_jwt=false・内部で
 * service role key を検証する（ユーザー JWT では動かさない）。進行ロジックの正本は engine
 * tournament.ts（"1回だけ実装"／企画書13.1）。engine 変更後は engine/ で `deno task sync-edge`。
 */
import {
  promotionRelegation,
  roundRobinRounds,
  runBracket,
  tallyStandings,
} from '../_engine/tournament.ts';
import { deriveSeed } from '../_engine/rng.ts';
import { battle1v1 } from '../_engine/battle.ts';
import type { CharacterBuild, MatchOutcome, Standing } from '../_engine/schema.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
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

function svcHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function svcGet<T = Record<string, unknown>>(path: string): Promise<T[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: svcHeaders() });
  const body = await res.json();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body as T[];
}

async function svcWrite(
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  prefer = 'return=minimal',
): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: svcHeaders({ Prefer: prefer }),
    body: JSON.stringify(body),
  });
  const out = res.headers.get('content-length') === '0' ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(out)}`);
  return out;
}

// ── DB 行（snake_case）→ engine の CharacterBuild（camelCase 契約）
interface CharacterRow {
  id: string;
  level: number;
  stats: CharacterBuild['stats'];
  spell_lines: CharacterBuild['spellLines'];
  equipment: CharacterBuild['equipment'];
}
function rowToBuild(row: CharacterRow): CharacterBuild {
  return {
    characterId: row.id,
    level: row.level,
    stats: row.stats,
    spellLines: row.spell_lines,
    equipment: row.equipment,
  };
}
function snapshotToBuild(characterId: string, snap: Omit<CharacterBuild, 'characterId'>): CharacterBuild {
  return { characterId, level: snap.level, stats: snap.stats, spellLines: snap.spellLines, equipment: snap.equipment };
}

// ────────────────────────────────────────────────────────────
// open: エントリー確定 → 出場者 snapshot → リーグ全カードを pending で materialize
// ────────────────────────────────────────────────────────────
async function handleOpen(body: Record<string, unknown>): Promise<Response> {
  const characterIds = body.characterIds as string[] | undefined;
  if (!Array.isArray(characterIds) || characterIds.length < 2) {
    return json({ error: 'characterIds は2人以上必要' }, 400);
  }
  const divisionId = (body.divisionId as string | undefined) ?? null;
  const name = (body.name as string | undefined) ?? 'シーズン';
  const season = (body.season as number | undefined) ?? null;

  // 1. 出場者ビルドを service_role で読む（entrants に snapshot する正本）
  const idList = characterIds.map((id) => `"${id}"`).join(',');
  const chars = await svcGet<CharacterRow>(
    `characters?id=in.(${idList})&select=id,level,stats,spell_lines,equipment`,
  );
  if (chars.length !== characterIds.length) {
    return json({ error: '存在しない characterId が含まれる', found: chars.length, requested: characterIds.length }, 400);
  }
  const byId = new Map(chars.map((c) => [c.id, c]));

  // 2. シーズンシード（全カードの seed 源・決定論の記録）
  const seasonSeed = Math.floor(Math.random() * 0x7fffffff);

  // 3. tournament 作成（running / league）
  const [tournament] = await svcWrite(
    'POST',
    'tournaments',
    { division_id: divisionId, name, season, status: 'running', phase: 'league', season_seed: seasonSeed },
    'return=representation',
  ) as { id: string }[];
  const tournamentId = tournament.id;

  // 4. entrants を snapshot（エントリー順 = 対戦表生成の決定論的順序）
  const entrantRows = characterIds.map((cid, i) => ({
    tournament_id: tournamentId,
    character_id: cid,
    seed_order: i,
    build: rowToBuild(byId.get(cid)!),
  }));
  await svcWrite('POST', 'tournament_entrants', entrantRows);

  // 5. リーグ全カードを pending で materialize（seed は deriveSeed で確定＝冪等の源）
  const schedule = roundRobinRounds(characterIds);
  const matchRows: Record<string, unknown>[] = [];
  schedule.forEach((pairings, round) => {
    pairings.forEach((p, i) => {
      matchRows.push({
        tournament_id: tournamentId,
        round,
        phase: 'league',
        character_a: p.a,
        character_b: p.b,
        seed: deriveSeed(seasonSeed, `L${round}`, i),
        status: 'pending',
      });
    });
  });
  if (matchRows.length > 0) await svcWrite('POST', 'matches', matchRows);

  return json({
    tournamentId,
    entrants: characterIds.length,
    rounds: schedule.length,
    matches: matchRows.length,
    seasonSeed,
  });
}

// ────────────────────────────────────────────────────────────
// tick: 1ステップ進める（未処理の最小ラウンド → 決着 → 順位。リーグ完走で決勝＋昇降格）
// ────────────────────────────────────────────────────────────
interface TournamentRow {
  id: string;
  status: string;
  phase: string;
  season_seed: number;
}
interface EntrantRow {
  character_id: string;
  build: Omit<CharacterBuild, 'characterId'>;
}
interface MatchRow {
  id: string;
  round: number;
  character_a: string;
  character_b: string;
  seed: number;
  winner: 'A' | 'B' | 'draw' | null;
}

async function entrantBuilds(tournamentId: string): Promise<Map<string, CharacterBuild>> {
  const rows = await svcGet<EntrantRow>(
    `tournament_entrants?tournament_id=eq.${tournamentId}&select=character_id,build`,
  );
  return new Map(rows.map((r) => [r.character_id, snapshotToBuild(r.character_id, r.build)]));
}

/** 完了済みリーグ戦から順位表を全再計算して standings に upsert（冪等・毎 tick フル再計算）。 */
async function recomputeStandings(
  tournamentId: string,
  seasonSeed: number,
): Promise<Standing[]> {
  const ids = (await svcGet<{ character_id: string }>(
    `tournament_entrants?tournament_id=eq.${tournamentId}&select=character_id`,
  )).map((r) => r.character_id);
  const done = await svcGet<MatchRow>(
    `matches?tournament_id=eq.${tournamentId}&phase=eq.league&status=eq.done&select=character_a,character_b,winner`,
  );
  // tallyStandings は a/b/winner しか読まない（他フィールドはダミー）
  const outcomes = done.map((m): MatchOutcome => ({
    a: m.character_a,
    b: m.character_b,
    seed: 0,
    winner: m.winner ?? 'draw',
    winnerId: null,
    turns: 0,
    eventLog: [],
  }));
  const standings = tallyStandings(ids, outcomes, seasonSeed);

  await svcWrite(
    'POST',
    'standings?on_conflict=tournament_id,character_id',
    standings.map((s) => ({
      tournament_id: tournamentId,
      character_id: s.id,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      points: s.points,
      rank: s.rank,
    })),
    'resolution=merge-duplicates,return=minimal',
  );
  return standings;
}

async function tickOne(t: TournamentRow): Promise<Record<string, unknown>> {
  if (t.status === 'finished') return { tournamentId: t.id, noop: 'finished' };
  const seasonSeed = Number(t.season_seed);

  // 未処理の最小ラウンド（1ラウンド/tick で進める＝企画書13.5「定時に一斉確定」）
  const pending = await svcGet<MatchRow>(
    `matches?tournament_id=eq.${t.id}&phase=eq.league&status=eq.pending` +
      `&select=id,round,character_a,character_b,seed&order=round.asc`,
  );

  if (pending.length > 0) {
    const round = pending[0].round;
    const roundMatches = pending.filter((m) => m.round === round);
    const builds = await entrantBuilds(t.id);

    for (const m of roundMatches) {
      const a = builds.get(m.character_a);
      const b = builds.get(m.character_b);
      if (!a || !b) throw new Error(`entrant build 欠落: ${m.character_a}/${m.character_b}`);
      const result = battle1v1(a, b, Number(m.seed));
      // status='pending' の行だけ done に倒す＝二重処理しない（冪等）
      await svcWrite(
        'PATCH',
        `matches?id=eq.${m.id}&status=eq.pending`,
        {
          winner: result.winner,
          turns: result.turns,
          event_log: result.eventLog,
          status: 'done',
          processed_at: new Date().toISOString(),
        },
      );
    }
    const standings = await recomputeStandings(t.id, seasonSeed);
    return { tournamentId: t.id, phase: 'league', round, processed: roundMatches.length, leader: standings[0]?.id };
  }

  // リーグ完走 → 決勝トーナメント＋昇降格を確定（既に bracket 済みなら二重生成しない）
  const existingBracket = await svcGet<{ id: string }>(
    `matches?tournament_id=eq.${t.id}&phase=eq.bracket&select=id&limit=1`,
  );
  if (existingBracket.length > 0) {
    // 稀: bracket は作られたが finished フラグ未設定 → フラグだけ整える（冪等）
    await svcWrite('PATCH', `tournaments?id=eq.${t.id}&status=neq.finished`, {
      phase: 'done',
      status: 'finished',
      finished_at: new Date().toISOString(),
    });
    return { tournamentId: t.id, noop: 'bracket already done' };
  }

  const standings = await recomputeStandings(t.id, seasonSeed);
  const seededIds = standings.map((s) => s.id); // 予選順位 = シード順
  const builds = await entrantBuilds(t.id);
  const bracket = runBracket(seededIds, builds, seasonSeed);

  // 決勝カードを done で保存（決定論に一括計算＝再生用 eventLog も揃う）
  if (bracket) {
    const bracketRows = bracket.matches.map((bm) => ({
      tournament_id: t.id,
      round: bm.round,
      phase: 'bracket',
      character_a: bm.outcome.a,
      character_b: bm.outcome.b,
      seed: bm.outcome.seed,
      winner: bm.outcome.winner,
      turns: bm.outcome.turns,
      event_log: bm.outcome.eventLog,
      status: 'done',
      processed_at: new Date().toISOString(),
    }));
    await svcWrite('POST', 'matches', bracketRows);
  }

  const promotion = promotionRelegation(standings);
  await svcWrite('PATCH', `tournaments?id=eq.${t.id}`, {
    phase: 'done',
    status: 'finished',
    champion_id: bracket ? bracket.championId : (seededIds[0] ?? null),
    promotion,
    finished_at: new Date().toISOString(),
  });

  return {
    tournamentId: t.id,
    phase: 'bracket',
    finished: true,
    champion: bracket ? bracket.championId : seededIds[0],
    promote: promotion.promote,
    relegate: promotion.relegate,
  };
}

async function handleTick(body: Record<string, unknown>): Promise<Response> {
  const tournamentId = body.tournamentId as string | undefined;
  const targets = tournamentId
    ? await svcGet<TournamentRow>(`tournaments?id=eq.${tournamentId}&select=id,status,phase,season_seed`)
    : await svcGet<TournamentRow>(`tournaments?status=eq.running&select=id,status,phase,season_seed`);

  const results = [];
  for (const t of targets) results.push(await tickOne(t));
  return json({ ticked: results.length, results });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // 管理エンドポイント: service_role key 必須（ユーザー JWT では動かさない）
  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${SERVICE_ROLE_KEY}`) return json({ error: 'service role required' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  try {
    switch (body.action) {
      case 'open':
        return await handleOpen(body);
      case 'tick':
        return await handleTick(body);
      default:
        return json({ error: "action は 'open' | 'tick'" }, 400);
    }
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
