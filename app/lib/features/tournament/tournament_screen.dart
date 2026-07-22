import 'package:flutter/material.dart';

import '../../models/tournament_models.dart';
import '../../services/battle_api.dart';
import '../replay/replay_screen.dart';

/// M6.3: 個人戦バッチ大会の観戦画面（企画書5章・非同期観戦）。
/// 順位表（勝点・昇降格）・決勝トーナメント・対戦カード一覧を表示し、
/// 消化済みカードをタップすると保存済み eventLog を既存 replay 画面で再生する。
class TournamentScreen extends StatefulWidget {
  final BattleApi api;
  const TournamentScreen({super.key, required this.api});

  @override
  State<TournamentScreen> createState() => _TournamentScreenState();
}

class _TournamentScreenState extends State<TournamentScreen> {
  TournamentView? _view;
  bool _loading = true;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final v = await widget.api.fetchLatestTournamentView();
      if (!mounted) return;
      setState(() {
        _view = v;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  Future<void> _openReplay(TournamentMatch m) async {
    if (!m.isDone || _busy) return;
    setState(() => _busy = true);
    try {
      final log = await widget.api.fetchEventLog(m.id);
      final v = _view!;
      final nameOf = {for (final e in v.names.entries) e.key: e.value};
      if (!mounted) return;
      await Navigator.of(context).push(
        // 大会観戦は多試合を流し見するので自動再生で開始（画面内で手動送りに切替可）。
        MaterialPageRoute(
          builder: (_) => ReplayScreen(eventLog: log, nameOf: nameOf, autoStart: true),
        ),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('大会'),
        actions: [IconButton(onPressed: _loading ? null : _reload, icon: const Icon(Icons.refresh))],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? _errorBody(_error!)
              : _view == null
                  ? _emptyBody()
                  : _body(_view!),
    );
  }

  Widget _errorBody(String e) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text('読み込み失敗:\n$e',
              textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
        ),
      );

  Widget _emptyBody() => const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('まだ開催された大会がありません。\nシーズンが始まると順位表がここに出ます。',
              textAlign: TextAlign.center, style: TextStyle(color: Colors.white54)),
        ),
      );

  Widget _body(TournamentView v) {
    final promoted = v.promotion?.promote.toSet() ?? <String>{};
    final relegated = v.promotion?.relegate.toSet() ?? <String>{};

    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _header(v),
            const SizedBox(height: 16),
            _sectionTitle('予選リーグ 順位表'),
            const SizedBox(height: 8),
            _standingsHeader(),
            ...v.standings.map((s) => _standingRow(v, s, promoted, relegated)),
            if (v.promotion != null) ...[
              const SizedBox(height: 10),
              _promotionLegend(),
            ],
            const SizedBox(height: 24),
            _bracketSection(v),
            const SizedBox(height: 24),
            _sectionTitle('対戦カード（タップで再生）'),
            const SizedBox(height: 8),
            ..._leagueCards(v),
          ],
        ),
      ),
    );
  }

  Widget _header(TournamentView v) {
    final s = v.summary;
    final champName = s.championId != null ? v.nameOf(s.championId!) : null;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(s.name,
                      style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                ),
                _statusChip(s),
              ],
            ),
            if (champName != null) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  const Text('🏆 ', style: TextStyle(fontSize: 18)),
                  Text('優勝: $champName',
                      style: const TextStyle(color: Colors.amber, fontWeight: FontWeight.bold)),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _statusChip(TournamentSummary s) {
    final (label, color) = switch (s.status) {
      'finished' => ('終了', Colors.grey),
      'running' => ('開催中', Colors.lightGreen),
      _ => ('予定', Colors.blueGrey),
    };
    return Chip(
      label: Text(label, style: const TextStyle(fontSize: 12)),
      backgroundColor: color.withValues(alpha: 0.25),
      visualDensity: VisualDensity.compact,
    );
  }

  Widget _sectionTitle(String t) =>
      Text(t, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold));

  Widget _standingsHeader() => const Padding(
        padding: EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(
          children: [
            SizedBox(width: 32, child: Text('#', style: _th)),
            Expanded(child: Text('出場者', style: _th)),
            SizedBox(width: 78, child: Text('勝-分-敗', style: _th, textAlign: TextAlign.right)),
            SizedBox(width: 44, child: Text('勝点', style: _th, textAlign: TextAlign.right)),
          ],
        ),
      );

  Widget _standingRow(
      TournamentView v, StandingRow s, Set<String> promoted, Set<String> relegated) {
    final isChamp = s.characterId == v.summary.championId;
    final badge = promoted.contains(s.characterId)
        ? '▲'
        : relegated.contains(s.characterId)
            ? '▼'
            : '';
    final badgeColor = promoted.contains(s.characterId)
        ? Colors.lightGreenAccent
        : Colors.redAccent;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: Colors.white.withValues(alpha: 0.08))),
        color: isChamp ? Colors.amber.withValues(alpha: 0.08) : null,
      ),
      child: Row(
        children: [
          SizedBox(width: 32, child: Text('${s.rank}', style: const TextStyle(fontWeight: FontWeight.bold))),
          Expanded(
            child: Row(
              children: [
                Flexible(child: Text(v.nameOf(s.characterId), overflow: TextOverflow.ellipsis)),
                if (isChamp) const Text('  🏆'),
                if (badge.isNotEmpty)
                  Text('  $badge', style: TextStyle(color: badgeColor, fontWeight: FontWeight.bold)),
              ],
            ),
          ),
          SizedBox(
              width: 78,
              child: Text('${s.wins}-${s.draws}-${s.losses}',
                  textAlign: TextAlign.right, style: const TextStyle(color: Colors.white70))),
          SizedBox(
              width: 44,
              child: Text('${s.points}',
                  textAlign: TextAlign.right, style: const TextStyle(fontWeight: FontWeight.bold))),
        ],
      ),
    );
  }

  Widget _promotionLegend() => const Padding(
        padding: EdgeInsets.symmetric(horizontal: 8),
        child: Row(
          children: [
            Text('▲ ', style: TextStyle(color: Colors.lightGreenAccent)),
            Text('昇格   ', style: TextStyle(fontSize: 12, color: Colors.white54)),
            Text('▼ ', style: TextStyle(color: Colors.redAccent)),
            Text('降格', style: TextStyle(fontSize: 12, color: Colors.white54)),
          ],
        ),
      );

  Widget _bracketSection(TournamentView v) {
    final bracket = v.matches.where((m) => m.isBracket).toList();
    if (bracket.isEmpty) return const SizedBox.shrink();
    final byRound = <int, List<TournamentMatch>>{};
    for (final m in bracket) {
      byRound.putIfAbsent(m.round, () => []).add(m);
    }
    final rounds = byRound.keys.toList()..sort();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _sectionTitle('決勝トーナメント'),
        const SizedBox(height: 8),
        for (final r in rounds) ...[
          Padding(
            padding: const EdgeInsets.only(left: 4, top: 4, bottom: 2),
            child: Text(_bracketRoundLabel(r, rounds.length),
                style: const TextStyle(fontSize: 12, color: Colors.white54)),
          ),
          ...byRound[r]!.map((m) => _matchTile(v, m, decisive: true)),
        ],
      ],
    );
  }

  String _bracketRoundLabel(int round, int total) {
    // 最終ラウンド = 決勝、その1つ前 = 準決勝
    if (round == total - 1) return '決勝';
    if (round == total - 2) return '準決勝';
    return '${round + 1}回戦';
  }

  List<Widget> _leagueCards(TournamentView v) {
    final league = v.matches.where((m) => !m.isBracket).toList();
    if (league.isEmpty) return [const Text('カードはまだありません', style: TextStyle(color: Colors.white54))];
    final byRound = <int, List<TournamentMatch>>{};
    for (final m in league) {
      byRound.putIfAbsent(m.round, () => []).add(m);
    }
    final rounds = byRound.keys.toList()..sort();
    return [
      for (final r in rounds) ...[
        Padding(
          padding: const EdgeInsets.only(left: 4, top: 6, bottom: 2),
          child: Text('第${r + 1}節', style: const TextStyle(fontSize: 12, color: Colors.white54)),
        ),
        ...byRound[r]!.map((m) => _matchTile(v, m)),
      ],
    ];
  }

  Widget _matchTile(TournamentView v, TournamentMatch m, {bool decisive = false}) {
    final a = v.nameOf(m.characterA);
    final b = m.characterB != null ? v.nameOf(m.characterB!) : '???';
    final winnerId = m.winnerId;
    final aWon = winnerId == m.characterA;
    final bWon = winnerId == m.characterB;
    final pending = !m.isDone;

    TextStyle side(bool won) => TextStyle(
          fontWeight: won ? FontWeight.bold : FontWeight.normal,
          color: won ? Colors.amber : (pending ? Colors.white38 : Colors.white),
        );

    return ListTile(
      dense: true,
      enabled: m.isDone,
      leading: Icon(
        pending ? Icons.hourglass_empty : Icons.play_circle_outline,
        color: pending ? Colors.white24 : (decisive ? Colors.amber : Colors.lightBlueAccent),
        size: 20,
      ),
      title: Row(
        children: [
          Expanded(child: Text(a, style: side(aWon), overflow: TextOverflow.ellipsis, textAlign: TextAlign.right)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Text(m.winner == 'draw' ? '△' : 'vs', style: const TextStyle(color: Colors.white38)),
          ),
          Expanded(child: Text(b, style: side(bWon), overflow: TextOverflow.ellipsis)),
        ],
      ),
      trailing: pending ? const Text('未消化', style: TextStyle(fontSize: 11, color: Colors.white38)) : null,
      onTap: () => _openReplay(m),
    );
  }
}

const _th = TextStyle(fontSize: 12, color: Colors.white54, fontWeight: FontWeight.bold);
