// M6.3 UI DoD: 観戦（大会）を実 UI でライブ Supabase スタックに対して駆動する E2E。
//   前段: admin(run-tournament) で 2人の小さな大会を seed → open → tick で決着まで
//   本番: 起動（匿名Auth）→（初回のみ作成）→ ホーム →「大会を観る」→ 順位表が出る →
//         対戦カードをタップ → 保存済み eventLog が replay 画面で再生される
//
// 前提: supabase start ＋ `supabase functions serve`（run-tournament ほか）が稼働中。
// 実行: cd app && flutter test integration_test/tournament_test.dart -d macos
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:proxy_champions/config.dart';
import 'package:proxy_champions/main.dart' as app;

const _serviceKey = String.fromEnvironment(
  'SERVICE_ROLE_KEY',
  defaultValue:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
);

final _base = AppConfig.supabaseUrl;
final _anon = AppConfig.supabaseAnonKey;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('大会を観る: 順位表が出て、カードをタップすると再生できる', (tester) async {
    // ── 前段: 2人の大会を seed（サーバー権威の open/tick を admin として叩く）
    final names = await _seedTournament();

    // ── 本番: アプリ起動
    app.main();
    await _settleUntil(
      tester,
      () =>
          find.text('この分身ではじめる ▶').evaluate().isNotEmpty ||
          find.text('派遣する ▶').evaluate().isNotEmpty,
      timeout: const Duration(seconds: 25),
    );
    if (find.text('この分身ではじめる ▶').evaluate().isNotEmpty) {
      await tester.tap(find.text('この分身ではじめる ▶'));
      await _settleUntil(tester, () => find.text('派遣する ▶').evaluate().isNotEmpty,
          timeout: const Duration(seconds: 20));
    }

    // ホーム →「大会を観る」
    final btn = find.text('大会を観る 🏆');
    await tester.ensureVisible(btn);
    await tester.tap(btn);

    // 順位表に seed した2人の名前が出る（entrants の name snapshot 経由＝RLS 越し観戦）
    await _settleUntil(
      tester,
      () => find.text('予選リーグ 順位表').evaluate().isNotEmpty,
      timeout: const Duration(seconds: 20),
    );
    for (final n in names) {
      expect(find.text(n), findsWidgets, reason: '$n が順位表/カードに出る');
    }

    // 優勝表示（champion が確定している）
    expect(find.textContaining('優勝:'), findsOneWidget);

    // 対戦カード（ListTile）をタップ → replay へ
    await _settleUntil(tester, () => find.byType(ListTile).evaluate().isNotEmpty,
        timeout: const Duration(seconds: 10));
    await tester.tap(find.byType(ListTile).first);

    // replay 画面（黒背景・「▶▶ 最後まで」ボタンが目印）
    await _settleUntil(tester, () => find.text('▶▶ 最後まで').evaluate().isNotEmpty,
        timeout: const Duration(seconds: 15));
    expect(find.text('▶▶ 最後まで'), findsOneWidget);
  });
}

// ── seed: run-tournament(open/tick) を service_role で叩き、2人の大会を決着まで進める ──
Future<List<String>> _seedTournament() async {
  final suffix = DateTime.now().millisecondsSinceEpoch % 100000;
  final roster = [
    ('観戦強者$suffix', {'vit': 22, 'mag': 2, 'pow': 20, 'spd': 13, 'men': 9}),
    ('観戦弱者$suffix', {'vit': 12, 'mag': 2, 'pow': 10, 'spd': 8, 'men': 5}),
  ];
  final ids = <String>[];
  for (final (name, stats) in roster) {
    final user = await _signup();
    final id = await _createCharacter(user.$1, user.$2, name, stats);
    ids.add(id);
  }

  final opened = await _admin({
    'action': 'open',
    'characterIds': ids,
    'name': '観戦検証カップ$suffix',
    'season': 1,
  });
  final tournamentId = opened['tournamentId'] as String;

  // 決着まで tick（2人 → 予選1節＋決勝1 = 2 tick。余裕を見て上限8）
  for (var i = 0; i < 8; i++) {
    final res = await _admin({'action': 'tick', 'tournamentId': tournamentId});
    final results = (res['results'] as List);
    if (results.isNotEmpty && (results.first as Map)['finished'] == true) break;
  }
  return roster.map((r) => r.$1).toList();
}

Future<(String token, String userId)> _signup() async {
  final j = await _http(
    'POST',
    '/auth/v1/signup',
    headers: {'apikey': _anon},
    body: {},
  );
  return (j['access_token'] as String, (j['user'] as Map)['id'] as String);
}

Future<String> _createCharacter(
    String token, String userId, String name, Map<String, int> stats) async {
  final j = await _http(
    'POST',
    '/rest/v1/characters',
    headers: {
      'apikey': _anon,
      'Authorization': 'Bearer $token',
      'Prefer': 'return=representation',
    },
    body: {
      'player_id': userId,
      'name': name,
      'level': 20,
      'stats': stats,
      'spell_lines': {'fire': 0, 'cure': 0, 'sleep': 0, 'strength': 0},
      'equipment': {'weapon': 'sword_iron', 'armor': 'mail_leather', 'shield': null},
    },
  );
  return (j['list'] as List).first['id'] as String;
}

Future<Map<String, dynamic>> _admin(Map<String, dynamic> body) => _http(
      'POST',
      '/functions/v1/run-tournament',
      headers: {'apikey': _serviceKey, 'Authorization': 'Bearer $_serviceKey'},
      body: body,
    );

/// dart:io の素の HTTP（配列レスポンスは {'list': [...]} に包んで返す）。
Future<Map<String, dynamic>> _http(
  String method,
  String path, {
  required Map<String, String> headers,
  required Object body,
}) async {
  final client = HttpClient();
  try {
    final req = await client.openUrl(method, Uri.parse('$_base$path'));
    headers.forEach(req.headers.set);
    req.headers.contentType = ContentType.json;
    req.add(utf8.encode(jsonEncode(body)));
    final res = await req.close();
    final text = await res.transform(utf8.decoder).join();
    if (res.statusCode >= 300) {
      throw Exception('$method $path → ${res.statusCode}: $text');
    }
    if (text.isEmpty) return {};
    final decoded = jsonDecode(text);
    return decoded is List ? {'list': decoded} : decoded as Map<String, dynamic>;
  } finally {
    client.close();
  }
}

Future<void> _settleUntil(
  WidgetTester tester,
  bool Function() cond, {
  Duration timeout = const Duration(seconds: 15),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!cond()) {
    if (DateTime.now().isAfter(deadline)) {
      throw TestFailure('条件が満たされませんでした（タイムアウト）');
    }
    await tester.pump(const Duration(milliseconds: 200));
  }
}
