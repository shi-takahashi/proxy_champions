import 'package:supabase_flutter/supabase_flutter.dart';

import '../config.dart';
import '../models/battle_event.dart';
import '../models/character_build.dart';

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
  Future<String> signIn() async {
    final existing = _c.auth.currentUser;
    if (existing != null) return existing.id;
    final res = await _c.auth.signInAnonymously();
    return res.user!.id;
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
}
