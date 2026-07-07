import 'package:supabase_flutter/supabase_flutter.dart';

import '../config.dart';
import '../models/battle_event.dart';
import '../models/character_build.dart';
import '../models/game_models.dart';

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

  /// プレイヤー資源（ゴールド・回復薬）。
  Future<PlayerState> fetchPlayerState() async {
    final userId = _c.auth.currentUser!.id;
    final row = await _c
        .from('players')
        .select('gold, potions')
        .eq('id', userId)
        .single();
    return PlayerState.fromRow(row);
  }

  /// 派遣先ダンジョン一覧（共有コンテンツ）。
  Future<List<Dungeon>> fetchDungeons() async {
    final rows = await _c.from('dungeons').select('*').order('difficulty');
    return (rows as List)
        .map((e) => Dungeon.fromRow(e as Map<String, dynamic>))
        .toList();
  }

  /// 派遣（run-dispatch: dispatch）。サーバーで dive() → 報酬/体力/ドロップを反映。
  Future<DispatchResult> dispatch(String characterId, String dungeonId, int minutes) async {
    final data = await _invokeDispatch('派遣', {
      'action': 'dispatch',
      'characterId': characterId,
      'dungeonId': dungeonId,
      'minutes': minutes,
    });
    return DispatchResult.fromJson(data);
  }

  /// 回復薬を使う（run-dispatch: use_potion）。体力を満タンに・potions 減算。残り回復薬数を返す。
  Future<int> usePotion(String characterId) async {
    final data = await _invokeDispatch('回復薬', {
      'action': 'use_potion',
      'characterId': characterId,
    });
    return data['potionsLeft'] as int;
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
    if (gold < cost) throw Exception('ゴールド不足（必要 $cost / 所持 $gold）');
    await _c.from('players').update({'gold': gold - cost}).eq('id', userId);
    await saveAllocation(characterId, stats, lines);
  }
}
