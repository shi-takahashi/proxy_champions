import 'package:supabase_flutter/supabase_flutter.dart';

import '../config.dart';
import '../models/battle_event.dart';
import '../models/character_build.dart';
import '../models/game_models.dart';
import '../models/tournament_models.dart';

/// M4 の縦スライスをサーバーとつなぐ薄い API 層。
/// 匿名Auth → キャラ作成(DB) → run-battle(Edge Function) → matches 読み戻し。
class BattleApi {
  SupabaseClient get _c => Supabase.instance.client;

  static Future<void> init() async {
    await Supabase.initialize(
      url: AppConfig.supabaseUrl,
      // 新 API 名。ローカル/従来の anon key をそのまま publishable key として渡せる。
      publishableKey: AppConfig.supabaseAnonKey,
    );
  }

  /// 匿名サインイン（未サインインなら）。players 行は DB トリガが自動生成（M3）。
  /// 既存セッションが実在 players に紐づかない場合（例: ローカル DB reset 後の孤児セッション）は
  /// 一度サインアウトして新規に取り直す（本番では初回のみ signInAnonymously が走る）。
  Future<String> signIn() async {
    final existing = _c.auth.currentUser;
    if (existing != null && await _playerExists(existing.id)) return existing.id;
    if (existing != null) await _c.auth.signOut();
    final res = await _c.auth.signInAnonymously();
    return res.user!.id;
  }

  Future<bool> _playerExists(String id) async {
    try {
      final row = await _c.from('players').select('id').eq('id', id).maybeSingle();
      return row != null;
    } catch (_) {
      return false;
    }
  }

  /// キャラを DB 保存（RLS: player_id = auth.uid()）。作成した character の id を返す。
  Future<String> createCharacter(String name, CharacterBuild build) async {
    final userId = _c.auth.currentUser!.id;
    final row = await _c
        .from('characters')
        .insert({'player_id': userId, ...build.toRow(name)})
        .select('id')
        .single();
    return row['id'] as String;
  }

  /// Edge Function で即時オート1戦を実行し、保存された matchId を得る。
  Future<String> runBattle(String characterId) async {
    final res = await _c.functions.invoke(
      'run-battle',
      body: {'characterId': characterId},
    );
    final data = res.data as Map<String, dynamic>;
    final matchId = data['matchId'];
    if (matchId == null) {
      throw Exception('run-battle 失敗: ${res.data}');
    }
    return matchId as String;
  }

  /// matches から eventLog を取得（観戦の契約・全員参照可）。
  Future<List<BattleEvent>> fetchEventLog(String matchId) async {
    final row = await _c
        .from('matches')
        .select('event_log')
        .eq('id', matchId)
        .single();
    final log = (row['event_log'] as List)
        .map((e) => BattleEvent.fromJson(e as Map<String, dynamic>))
        .toList();
    return log;
  }

  // ── M5.4: 育成ループ ──────────────────────────────────────

  /// 自分のキャラ（1ユーザー1キャラ）。未作成なら null。
  Future<Character?> fetchMyCharacter() async {
    final userId = _c.auth.currentUser!.id;
    final row = await _c
        .from('characters')
        .select('*')
        .eq('player_id', userId)
        .order('created_at')
        .limit(1)
        .maybeSingle();
    return row == null ? null : Character.fromRow(row);
  }

  /// キャラ状態（実効体力＋回復ETA＋派遣中かどうか）。サーバーが算出。
  Future<CharacterStatus> fetchStatus(String characterId) async {
    final data = await _invokeDispatch('状態取得', {
      'action': 'status',
      'characterId': characterId,
    });
    return CharacterStatus.fromJson(data);
  }

  /// プレイヤー資源（ゴールド）。
  Future<PlayerState> fetchPlayerState() async {
    final userId = _c.auth.currentUser!.id;
    final row = await _c
        .from('players')
        .select('gold')
        .eq('id', userId)
        .single();
    return PlayerState.fromRow(row);
  }

  /// 所持アイテム一覧（player_items ＋ item_catalog を埋め込み）。数量>0 のみ・種別順。
  Future<List<InventoryItem>> fetchInventory() async {
    final userId = _c.auth.currentUser!.id;
    final rows = await _c
        .from('player_items')
        .select('quantity, item_catalog(id, name, effect_kind, effect_pct)')
        .eq('player_id', userId)
        .gt('quantity', 0)
        .order('item_id');
    return (rows as List)
        .map((e) => InventoryItem.fromRow(e as Map<String, dynamic>))
        .toList();
  }

  /// 派遣先ダンジョン一覧（共有コンテンツ）。
  Future<List<Dungeon>> fetchDungeons() async {
    final rows = await _c.from('dungeons').select('*').order('difficulty');
    return (rows as List)
        .map((e) => Dungeon.fromRow(e as Map<String, dynamic>))
        .toList();
  }

  /// 派遣を開始（run-dispatch: dispatch）。実時間・非同期＝指定時間は留守にし、後で受け取る。
  /// 帰還までの残り分を返す（体力0の強制帰還なら指定より短い）。
  Future<int> startDispatch(String characterId, String dungeonId, int minutes) async {
    final data = await _invokeDispatch('派遣', {
      'action': 'dispatch',
      'characterId': characterId,
      'dungeonId': dungeonId,
      'minutes': minutes,
    });
    return (data['minutesRemaining'] as num).toInt();
  }

  /// 帰還を受け取る（run-dispatch: collect）。帰還予定時刻を過ぎていれば報酬を確定して返す。
  Future<DispatchResult> collectDispatch(String characterId) async {
    final data = await _invokeDispatch('帰還受け取り', {
      'action': 'collect',
      'characterId': characterId,
    });
    return DispatchResult.fromJson(data);
  }

  /// ★デバッグ用: 即時解決（run-dispatch: dispatch_instant）。押した瞬間に結果まで反映。
  Future<DispatchResult> dispatchInstant(String characterId, String dungeonId, int minutes) async {
    final data = await _invokeDispatch('即時派遣', {
      'action': 'dispatch_instant',
      'characterId': characterId,
      'dungeonId': dungeonId,
      'minutes': minutes,
    });
    return DispatchResult.fromJson(data);
  }

  /// アイテム（回復薬）を使う（run-dispatch: use_item）。効果(hp/mp/both×割合)で回復し数量を減算。
  /// 使用後の残り個数を返す。
  Future<int> useItem(String characterId, String itemId) async {
    final data = await _invokeDispatch('アイテム使用', {
      'action': 'use_item',
      'characterId': characterId,
      'itemId': itemId,
    });
    return (data['quantityLeft'] as num).toInt();
  }

  /// run-dispatch 呼び出しの共通処理（4xx はサーバーの error 文言を拾って投げ直す）。
  Future<Map<String, dynamic>> _invokeDispatch(String what, Map<String, dynamic> body) async {
    try {
      final res = await _c.functions.invoke('run-dispatch', body: body);
      final data = res.data as Map<String, dynamic>;
      if (data['error'] != null) throw Exception('$what失敗: ${data['error']}');
      return data;
    } on FunctionException catch (e) {
      final det = e.details;
      final msg = det is Map && det['error'] != null ? det['error'] : e.toString();
      throw Exception('$what失敗: $msg');
    }
  }

  /// ステ振り/ライン投資を保存（RLS: 自分のキャラのみ更新）。振り足し=無料。
  Future<void> saveAllocation(String characterId, Stats stats, SpellLines lines) async {
    await _c.from('characters').update({
      'stats': stats.toJson(),
      'spell_lines': lines.toJson(),
    }).eq('id', characterId);
  }

  /// リスペック（振り直し）: ゴールドを消費して配分を上書き（企画書3.5 ゴールドシンク）。
  /// ※MVP は RLS 内のクライアント権威（gold は本人のみ更新可）。サーバー権威化は後日。
  Future<void> respecAllocation(
      String characterId, Stats stats, SpellLines lines, int cost) async {
    final userId = _c.auth.currentUser!.id;
    final p = await _c.from('players').select('gold').eq('id', userId).single();
    final gold = (p['gold'] as num).toInt();
    if (gold < cost) throw Exception('コインが足りない（必要 $cost / 所持 $gold）');
    await _c.from('players').update({'gold': gold - cost}).eq('id', userId);
    await saveAllocation(characterId, stats, lines);
  }

  // ── M6.3: 観戦（大会）─────────────────────────────────────
  // すべて全員参照の共有コンテンツ（非同期観戦）。誰の大会でも順位/カード/ログを読める。

  /// 最新の1大会を観戦ビューとして取得（無ければ null）。
  /// MVP は「直近に開催された大会」を出す（所属ディビジョン絞り込みは後日）。
  Future<TournamentView?> fetchLatestTournamentView() async {
    final t = await _c
        .from('tournaments')
        .select('*')
        .order('created_at', ascending: false)
        .limit(1)
        .maybeSingle();
    if (t == null) return null;
    return _buildTournamentView(TournamentSummary.fromRow(t), t['promotion']);
  }

  Future<TournamentView> _buildTournamentView(
      TournamentSummary summary, dynamic promotionJson) async {
    final id = summary.id;

    // 名前 snapshot（characters.name は RLS で他人ぶんを読めないため entrants から）
    final ents = await _c
        .from('tournament_entrants')
        .select('character_id, name')
        .eq('tournament_id', id);
    final names = <String, String>{
      for (final e in ents as List)
        e['character_id'] as String: (e['name'] as String?) ?? '???',
    };

    final st = await _c
        .from('standings')
        .select('*')
        .eq('tournament_id', id)
        .order('rank');
    final standings =
        (st as List).map((e) => StandingRow.fromRow(e as Map<String, dynamic>)).toList();

    final ms = await _c
        .from('matches')
        .select('id, phase, round, character_a, character_b, winner, status')
        .eq('tournament_id', id);
    final matches =
        (ms as List).map((e) => TournamentMatch.fromRow(e as Map<String, dynamic>)).toList();
    // 予選(league)→決勝(bracket)、round 昇順で並べる
    matches.sort((a, b) {
      if (a.phase != b.phase) return a.phase == 'league' ? -1 : 1;
      return a.round.compareTo(b.round);
    });

    final promotion = promotionJson is Map
        ? Promotion.fromJson(Map<String, dynamic>.from(promotionJson))
        : null;

    return TournamentView(
      summary: summary,
      names: names,
      standings: standings,
      matches: matches,
      promotion: promotion,
    );
  }
}
