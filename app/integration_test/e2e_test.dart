// M4 UI DoD: 実 UI をライブのローカル Supabase スタックで駆動する E2E。
//   起動（匿名Auth）→ 作成画面 →「作成して1戦」タップ →
//   Edge Function で battle() → matches 保存 → eventLog 取得 → 再生画面が描画される
// 前提: supabase start ＋ `supabase functions serve run-battle` が稼働中。
//
// 実行: cd app && flutter test integration_test/e2e_test.dart -d macos
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:proxy_champions/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('作成→1戦→再生 が一気通貫で動く', (tester) async {
    app.main();
    // 起動 + 匿名サインイン完了（作成画面が出る）まで待つ
    await _settleUntil(tester, () => find.text('作成して1戦 ▶').evaluate().isNotEmpty);
    expect(find.text('作成して1戦 ▶'), findsOneWidget);

    // 「作成して1戦」タップ → サーバー往復（作成→battle→保存→取得）
    await tester.tap(find.text('作成して1戦 ▶'));
    await tester.pump();

    // 再生画面に遷移し、スパーリング相手が HP バーに現れる
    await _settleUntil(tester, () => find.text('スパーリングダミー').evaluate().isNotEmpty,
        timeout: const Duration(seconds: 25));
    expect(find.text('スパーリングダミー'), findsOneWidget);

    // 「最後まで」で再生を送り、勝敗バナー（勝利/引き分け）が出ることを確認
    await tester.tap(find.text('▶▶ 最後まで'));
    await tester.pump(const Duration(milliseconds: 300));
    final banner = find.byWidgetPredicate((w) =>
        w is Text &&
        (w.data?.contains('勝利') == true || w.data?.contains('引き分け') == true));
    expect(banner, findsWidgets);
  });
}

/// cond が true になるまで（またはタイムアウトまで）pump し続ける。
/// ネットワーク待ちがあるので pumpAndSettle ではなく手動ポーリング。
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
