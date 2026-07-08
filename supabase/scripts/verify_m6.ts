/**
 * M6.2 DoD 検証（個人戦バッチ大会の永続化＋定時バッチを UI 抜きで一気通貫・実装プラン M6.2）:
 *   1. 6人（強→弱・別プレイヤー）を匿名Authで作成
 *   2. run-tournament(open)  → リーグ全カード(6人総当たり=15)を pending で materialize
 *   3. run-tournament(tick) を日次 cron のように反復 → 1ラウンド/tick で自動進行
 *        ・各 tick で done が増え、standings が更新される（定時バッチで自動進行＝DoD①）
 *   4. 再現性: done 試合を engine battle1v1(builds, storedSeed) で再計算 → winner 一致
 *        （＝eventLog/勝敗は seed から再現できる＝非同期観戦の再生契約・企画書13.4）
 *   5. リーグ完走 → 決勝トーナメント＋昇降格が確定（champion / promotion 保存）
 *   6. 冪等: finished 後に tick を追撃 → done 数・champion・standings が不変（二重処理しない＝DoD②）
 *   7. 観戦: 出場者でない第三者(匿名)から standings/matches/entrants が見える（後から順位/ログ確認＝DoD③）
 *
 * 実行（supabase start ＋ functions serve run-tournament が動いている前提）:
 *   ANON_KEY=... SERVICE_ROLE_KEY=... deno run -A supabase/scripts/verify_m6.ts
 */
import type { CharacterBuild } from '../../engine/src/schema.ts';
import { battle1v1 } from '../../engine/src/battle.ts';

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

/** run-tournament を service_role で叩く（管理エンドポイント） */
async function admin(body: unknown) {
  const res = await fetch(`${URL}/functions/v1/run-tournament`, {
    method: 'POST',
    headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE!}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

async function read(token: string, path: string) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    headers: { apikey: ANON!, Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  assert(res.ok, `読み出し失敗(${path}): ${res.status} ${JSON.stringify(body)}`);
  return body;
}

function mk(
  stats: { vit: number; mag: number; pow: number; spd: number; men: number },
): Omit<CharacterBuild, 'characterId'> {
  return {
    level: 20,
    stats,
    spellLines: { fire: 0, cure: 0, sleep: 0, strength: 0 },
    equipment: { weapon: 'sword_iron', armor: 'mail_leather', shield: null },
  };
}

// ── run ─────────────────────────────────────────────────────
console.log('▶ 1. 6人（強→弱・別プレイヤー）を作成');
const roster: { name: string; build: Omit<CharacterBuild, 'characterId'> }[] = [
  { name: '強兵', build: mk({ vit: 24, mag: 2, pow: 22, spd: 14, men: 10 }) },
  { name: '猛者', build: mk({ vit: 22, mag: 2, pow: 20, spd: 13, men: 9 }) },
  { name: '中堅', build: mk({ vit: 20, mag: 2, pow: 18, spd: 12, men: 8 }) },
  { name: '並兵', build: mk({ vit: 18, mag: 2, pow: 16, spd: 11, men: 7 }) },
  { name: '新兵', build: mk({ vit: 15, mag: 2, pow: 13, spd: 9, men: 6 }) },
  { name: '弱兵', build: mk({ vit: 11, mag: 2, pow: 9, spd: 7, men: 5 }) },
];
const characterIds: string[] = [];
const buildById = new Map<string, CharacterBuild>();
for (const r of roster) {
  const { token, userId } = await signInAnonymously();
  const id = await createCharacter(token, userId, r.name, r.build);
  characterIds.push(id);
  buildById.set(id, { characterId: id, ...r.build });
}
console.log(`   ok ${characterIds.length}人（${roster.map((r) => r.name).join('/')}）`);

console.log('▶ 2. open（リーグ全カードを pending で materialize）');
const opened = await admin({ action: 'open', characterIds, name: 'M6検証シーズン', season: 1 });
assert(opened.ok, `open 失敗: ${opened.status} ${JSON.stringify(opened.json)}`);
const tournamentId = opened.json.tournamentId as string;
assert(opened.json.rounds === 5, `6人 → 5ラウンドのはず: ${opened.json.rounds}`);
assert(opened.json.matches === 15, `6人総当たり = 15カードのはず: ${opened.json.matches}`);
console.log(`   ok tournamentId=${tournamentId.slice(0, 8)}… rounds=${opened.json.rounds} matches=${opened.json.matches} seed=${opened.json.seasonSeed}`);

// 出場者不在の第三者（観戦者）を1人用意（DoD③ 用）
const spectator = await signInAnonymously();

console.log('▶ 3. tick を日次 cron のように反復（1ラウンド/tick で自動進行）');
let ticks = 0;
let finished = false;
let lastChampion: string | null = null;
let promote: string[] = [];
let relegate: string[] = [];
while (!finished && ticks < 20) {
  const t = await admin({ action: 'tick', tournamentId });
  assert(t.ok, `tick 失敗: ${t.status} ${JSON.stringify(t.json)}`);
  const r = t.json.results[0];
  ticks++;
  if (r.finished) {
    finished = true;
    lastChampion = r.champion;
    promote = r.promote;
    relegate = r.relegate;
    console.log(`   tick#${ticks} [決勝確定] champion=${r.champion?.slice(0, 8)}… promote=${r.promote.length} relegate=${r.relegate.length}`);
  } else if (r.phase === 'league') {
    // 各リーグ tick 後: done 数がラウンド×3 に増えている
    const done = await read(spectator.token, `matches?tournament_id=eq.${tournamentId}&phase=eq.league&status=eq.done&select=id`);
    assert(done.length === (r.round + 1) * 3, `round${r.round} 後の done 数不整合: ${done.length}`);
    console.log(`   tick#${ticks} [予選 round ${r.round}] processed=${r.processed} done累計=${done.length}/15 leader=${String(r.leader).slice(0, 8)}…`);
  }
}
assert(finished, `20 tick 以内に終了しなかった（ticks=${ticks}）`);
assert(ticks === 6, `6人リーグ(5R)+決勝(1) = 6 tick で終わるはず: ${ticks}`);

console.log('▶ 4. 再現性: done 試合を engine で再計算 → winner 一致（seed から再生可能）');
const someMatch = (await read(
  spectator.token,
  `matches?tournament_id=eq.${tournamentId}&phase=eq.league&status=eq.done&select=character_a,character_b,seed,winner,event_log&limit=1`,
))[0];
const bA = buildById.get(someMatch.character_a)!;
const bB = buildById.get(someMatch.character_b)!;
const replay = battle1v1(bA, bB, Number(someMatch.seed));
assert(replay.winner === someMatch.winner, `再計算 winner 不一致: ${replay.winner} != ${someMatch.winner}`);
assert(Array.isArray(someMatch.event_log) && someMatch.event_log.length > 0, 'eventLog が保存されている（再生の正本）');
assert(replay.eventLog.length === someMatch.event_log.length, 'eventLog も再現一致');
console.log(`   ok seed=${someMatch.seed} winner=${someMatch.winner} eventLog=${someMatch.event_log.length}件 が engine と一致`);

console.log('▶ 5. 決勝＋昇降格の確定（champion / promotion 保存）');
const tour = (await read(spectator.token, `tournaments?id=eq.${tournamentId}&select=status,phase,champion_id,promotion`))[0];
assert(tour.status === 'finished' && tour.phase === 'done', `終了状態でない: ${tour.status}/${tour.phase}`);
assert(tour.champion_id === lastChampion, `champion 保存不一致: ${tour.champion_id} != ${lastChampion}`);
assert(tour.promotion && tour.promotion.promote.length === 2 && tour.promotion.relegate.length === 2, `昇降格枠が2/2でない: ${JSON.stringify(tour.promotion)}`);
const bracketMatches = await read(spectator.token, `matches?tournament_id=eq.${tournamentId}&phase=eq.bracket&status=eq.done&select=id`);
assert(bracketMatches.length === 3, `4シード決勝 = 3試合のはず: ${bracketMatches.length}`);
console.log(`   ok champion=${String(tour.champion_id).slice(0, 8)}… 決勝${bracketMatches.length}試合 promote=${promote.length} relegate=${relegate.length}`);

console.log('▶ 6. 冪等: finished 後に tick 追撃 → done 数/champion/standings が不変');
const beforeDone = (await read(spectator.token, `matches?tournament_id=eq.${tournamentId}&status=eq.done&select=id`)).length;
const beforeStandings = await read(spectator.token, `standings?tournament_id=eq.${tournamentId}&select=character_id,points,rank&order=rank.asc`);
for (let i = 0; i < 3; i++) {
  const again = await admin({ action: 'tick', tournamentId });
  assert(again.ok, `追撃 tick 失敗: ${again.status}`);
}
const afterDone = (await read(spectator.token, `matches?tournament_id=eq.${tournamentId}&status=eq.done&select=id`)).length;
const afterTour = (await read(spectator.token, `tournaments?id=eq.${tournamentId}&select=champion_id`))[0];
const afterStandings = await read(spectator.token, `standings?tournament_id=eq.${tournamentId}&select=character_id,points,rank&order=rank.asc`);
assert(afterDone === beforeDone, `追撃で done 数が増えた（二重処理）: ${beforeDone} → ${afterDone}`);
assert(afterTour.champion_id === lastChampion, `追撃で champion が変わった: ${afterTour.champion_id}`);
assert(JSON.stringify(afterStandings) === JSON.stringify(beforeStandings), '追撃で standings が変わった');
console.log(`   ok done=${afterDone}（不変）champion 不変 standings 不変 ＝二重処理しない`);

console.log('▶ 7. 観戦: 第三者(匿名)から順位表/カード/出場者が見える（後から確認できる）');
const st = await read(spectator.token, `standings?tournament_id=eq.${tournamentId}&select=character_id,wins,losses,draws,points,rank&order=rank.asc`);
assert(st.length === 6, `standings が6人でない: ${st.length}`);
assert(st[0].rank === 1 && st[5].rank === 6, 'rank が 1..6 で並ぶ');
for (const s of st) assert(s.wins + s.losses + s.draws === 5, `${s.character_id} の総試合数が5でない`);
const ent = await read(spectator.token, `tournament_entrants?tournament_id=eq.${tournamentId}&select=character_id`);
assert(ent.length === 6, `entrants が6人でない: ${ent.length}`);
console.log('   順位表:');
for (const s of st) {
  const nm = roster[characterIds.indexOf(s.character_id)]?.name ?? s.character_id.slice(0, 6);
  const champ = s.character_id === lastChampion ? ' 🏆' : '';
  console.log(`     ${s.rank}位 ${nm}  ${s.wins}-${s.draws}-${s.losses}  ${s.points}pt${champ}`);
}

console.log('\n✅ M6.2 DoD: open→(daily tick)自動進行→再現性→決勝/昇降格確定→冪等(二重処理なし)→観戦 全通過');
