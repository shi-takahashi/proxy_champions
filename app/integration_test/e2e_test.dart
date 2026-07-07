// M5.4 UI DoD: 育成ループを実 UI でライブの Supabase スタックに対して駆動する E2E。
//   起動（匿名Auth）→ 作成（初回のみ）→ ホーム →「派遣する」→ ダンジョン選択 →
//   run-dispatch(dispatch) → 帰還サマリ（獲得XP）→ ホームへ戻る
// 前提: supabase start ＋ `supabase functions serve`（run-dispatch / run-battle）が稼働中。
//
// 実行: cd app && flutter test integration_test/e2e_test.dart -d macos
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:proxy_champions/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('作成→ホーム→派遣→帰還サマリ が一気通貫で動く', (tester) async {
    app.main();

    // 起動完了: 作成画面（初回）か、既存キャラのホームのどちらかが出るまで待つ
    await _settleUntil(
      tester,
      () =>
          find.text('この分身ではじめる ▶').evaluate().isNotEmpty ||
          find.text('派遣する ▶').evaluate().isNotEmpty,
      timeout: const Duration(seconds: 25),
    );

    // 初回なら作成 → ホームへ
    if (find.text('この分身ではじめる ▶').evaluate().isNotEmpty) {
      await tester.tap(find.text('この分身ではじめる ▶'));
      await _settleUntil(tester, () => find.text('派遣する ▶').evaluate().isNotEmpty,
          timeout: const Duration(seconds: 20));
    }
    expect(find.text('派遣する ▶'), findsOneWidget);

    // ホーム →「派遣する」→ 派遣画面
    await tester.tap(find.text('派遣する ▶'));
    await _settleUntil(tester, () => find.text('この設定で派遣 ▶').evaluate().isNotEmpty,
        timeout: const Duration(seconds: 15));

    // 派遣実行 → 帰還サマリ（獲得XP 行）が出る
    await tester.tap(find.text('この設定で派遣 ▶'));
    await _settleUntil(tester, () => find.text('獲得XP').evaluate().isNotEmpty,
        timeout: const Duration(seconds: 30));
    expect(find.text('獲得XP'), findsOneWidget);

    // ホームへ戻れる
    await tester.tap(find.text('ホームへ戻る'));
    await _settleUntil(tester, () => find.text('派遣する ▶').evaluate().isNotEmpty,
        timeout: const Duration(seconds: 15));
    expect(find.text('派遣する ▶'), findsOneWidget);
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
