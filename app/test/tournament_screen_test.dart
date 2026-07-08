// M6.3 UI: 観戦画面（TournamentScreen）の決定論ウィジェットテスト。
//   ネットワーク / macOS フォアグラウンドに依存せず（headless widget test）、
//   スタブ API が返す TournamentView の描画と「カード→再生」導線を検証する。
//   ・順位表（勝点・昇降格バッジ）／優勝表示／決勝トーナメント節が出る
//   ・対戦カードをタップ → 保存済み eventLog が replay 画面で再生される
//
// サーバーが返すデータの正しさは supabase/scripts/verify_m6.ts（ライブ green）が担保。
// ここは「その形のデータを UI が正しく描く」ことを速く確実に固定する。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:proxy_champions/features/tournament/tournament_screen.dart';
import 'package:proxy_champions/models/battle_event.dart';
import 'package:proxy_champions/models/tournament_models.dart';
import 'package:proxy_champions/services/battle_api.dart';

/// fetchLatestTournamentView / fetchEventLog だけ差し替えるスタブ（Supabase を触らない）。
class _StubApi extends BattleApi {
  final TournamentView view;
  final List<BattleEvent> log;
  _StubApi(this.view, this.log);

  @override
  Future<TournamentView?> fetchLatestTournamentView() async => view;

  @override
  Future<List<BattleEvent>> fetchEventLog(String matchId) async => log;
}

TournamentView _sampleView() {
  const names = {'c1': '強者', 'c2': '猛者', 'c3': '中堅', 'c4': '弱者'};
  final standings = [
    const StandingRow(characterId: 'c1', wins: 3, losses: 0, draws: 0, points: 9, rank: 1),
    const StandingRow(characterId: 'c2', wins: 2, losses: 1, draws: 0, points: 6, rank: 2),
    const StandingRow(characterId: 'c3', wins: 1, losses: 2, draws: 0, points: 3, rank: 3),
    const StandingRow(characterId: 'c4', wins: 0, losses: 3, draws: 0, points: 0, rank: 4),
  ];
  final matches = [
    // 予選（league）
    const TournamentMatch(id: 'm1', phase: 'league', round: 0, characterA: 'c1', characterB: 'c2', winner: 'A', status: 'done'),
    const TournamentMatch(id: 'm2', phase: 'league', round: 0, characterA: 'c3', characterB: 'c4', winner: 'A', status: 'done'),
    // 決勝（bracket）
    const TournamentMatch(id: 'b1', phase: 'bracket', round: 0, characterA: 'c1', characterB: 'c2', winner: 'B', status: 'done'),
  ];
  return TournamentView(
    summary: const TournamentSummary(
        id: 't1', name: 'テストカップ', status: 'finished', phase: 'done', season: 1, championId: 'c2'),
    names: names,
    standings: standings,
    matches: matches,
    promotion: const Promotion(promote: ['c1', 'c2'], relegate: ['c3', 'c4'], stay: []),
  );
}

List<BattleEvent> _sampleLog() => [
      BattleEvent.fromJson({
        'type': 'battle_start',
        't': 0,
        'teamA': ['c1'],
        'teamB': ['c2'],
        'fighters': [
          {'id': 'c1', 'side': 'A', 'maxHp': 220},
          {'id': 'c2', 'side': 'B', 'maxHp': 200},
        ],
        'seed': 1,
      }),
      BattleEvent.fromJson({
        'type': 'attack', 't': 1, 'actor': 'c2', 'target': 'c1',
        'weapon': 'sword_iron', 'damage': 30, 'crit': false, 'hpAfter': 190,
      }),
      BattleEvent.fromJson({'type': 'ko', 't': 2, 'target': 'c1'}),
      BattleEvent.fromJson({'type': 'battle_end', 't': 2, 'winner': 'B', 'seed': 1}),
    ];

void main() {
  testWidgets('観戦画面: 順位表・優勝・昇降格・決勝が描画される', (tester) async {
    await tester.pumpWidget(MaterialApp(home: TournamentScreen(api: _StubApi(_sampleView(), _sampleLog()))));
    await tester.pump(); // _reload の await を解決
    await tester.pump();

    // 順位表と出場者名（RLS 越しの entrants snapshot 名）
    expect(find.text('予選リーグ 順位表'), findsOneWidget);
    expect(find.text('強者'), findsWidgets);
    expect(find.text('弱者'), findsWidgets);

    // 優勝（bracket 勝者 c2=猛者）
    expect(find.textContaining('優勝:'), findsOneWidget);

    // 昇降格バッジ（▲昇格 / ▼降格）と凡例
    expect(find.textContaining('▲'), findsWidgets);
    expect(find.textContaining('▼'), findsWidgets);

    // 決勝トーナメント節
    expect(find.text('決勝トーナメント'), findsOneWidget);
    expect(find.text('対戦カード（タップで再生）'), findsOneWidget);
  });

  testWidgets('観戦画面: カードをタップすると replay 画面へ遷移する', (tester) async {
    await tester.pumpWidget(MaterialApp(home: TournamentScreen(api: _StubApi(_sampleView(), _sampleLog()))));
    await tester.pump();
    await tester.pump();

    // 最初の対戦カード（ListTile）をタップ → 非同期 fetchEventLog → replay push
    expect(find.byType(ListTile), findsWidgets);
    await tester.tap(find.byType(ListTile).first);
    await tester.pump(); // _openReplay の await 開始
    await tester.pump(const Duration(milliseconds: 100)); // fetchEventLog 解決 → push

    // replay 画面（「▶▶ 最後まで」が目印）。タップして skip し、走行中タイマーを止める
    expect(find.text('▶▶ 最後まで'), findsOneWidget);
    await tester.tap(find.text('▶▶ 最後まで'));
    await tester.pump();

    // 決着（side B = 猛者 の勝利）が表示される
    expect(find.textContaining('猛者 の勝利'), findsOneWidget);
  });
}
