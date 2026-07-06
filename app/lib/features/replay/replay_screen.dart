import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../models/battle_event.dart';

/// クラシックRPG風の戦闘再生（企画書4章）。
/// 黒背景・等幅テキストのログ送り・上部に A/B の HP バー・被弾で画面シェイク。
/// eventLog を順に消化するだけ（＝サーバーが返した決定論ログの純粋な再生）。
class ReplayScreen extends StatefulWidget {
  final List<BattleEvent> eventLog;
  final Map<String, String> nameOf; // combatant id -> 表示名

  const ReplayScreen({super.key, required this.eventLog, required this.nameOf});

  @override
  State<ReplayScreen> createState() => _ReplayScreenState();
}

class _ReplayScreenState extends State<ReplayScreen> with SingleTickerProviderStateMixin {
  final List<String> _lines = [];
  final _scroll = ScrollController();
  final Map<String, int> _hp = {}; // id -> 現在HP
  final Map<String, int> _maxHp = {}; // id -> 最大HP
  final Map<String, String> _side = {}; // id -> 'A'|'B'
  int _i = 0;
  Timer? _timer;
  String? _winnerSide;

  late final AnimationController _shake = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 320),
  );

  String _name(String id) => widget.nameOf[id] ?? id;

  @override
  void initState() {
    super.initState();
    // battle_start から HP バーの分母（maxHp）を仕込む
    final start = widget.eventLog.firstWhere((e) => e.type == 'battle_start');
    for (final f in start.fighters) {
      _maxHp[f.id] = f.maxHp;
      _hp[f.id] = f.maxHp;
      _side[f.id] = f.side;
    }
    _timer = Timer.periodic(const Duration(milliseconds: 550), (_) => _step());
  }

  void _step() {
    if (_i >= widget.eventLog.length) {
      _timer?.cancel();
      return;
    }
    final e = widget.eventLog[_i++];

    // HP バー更新（対象の hpAfter を反映）
    if (e.hpAfter != null && e.target != null) {
      _hp[e.target!] = e.hpAfter!;
    }
    if (e.isEnd) _winnerSide = e.winner;
    if (e.causesShake) _shake.forward(from: 0);

    // ログ行（gauge_ready は間引かず出すと冗長なので簡素表示）
    final line = e.describe(_name);
    setState(() => _lines.add(line));

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _skipToEnd() {
    _timer?.cancel();
    while (_i < widget.eventLog.length) {
      final e = widget.eventLog[_i++];
      if (e.hpAfter != null && e.target != null) _hp[e.target!] = e.hpAfter!;
      if (e.isEnd) _winnerSide = e.winner;
      _lines.add(e.describe(_name));
    }
    setState(() {});
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    _shake.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // side -> id（1v1 前提で side ごと先頭を採用）
    String? idForSide(String s) {
      for (final entry in _side.entries) {
        if (entry.value == s) return entry.key;
      }
      return null;
    }

    final aId = idForSide('A');
    final bId = idForSide('B');

    return Scaffold(
      backgroundColor: Colors.black,
      body: AnimatedBuilder(
        animation: _shake,
        builder: (context, child) {
          final v = _shake.value;
          final dx = math.sin(v * math.pi * 4) * (1 - v) * 12;
          return Transform.translate(offset: Offset(dx, 0), child: child);
        },
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (aId != null) _hpBar(aId, Colors.lightBlueAccent),
                const SizedBox(height: 8),
                if (bId != null) _hpBar(bId, Colors.redAccent),
                const SizedBox(height: 16),
                const Divider(color: Colors.white24),
                Expanded(
                  child: ListView.builder(
                    controller: _scroll,
                    itemCount: _lines.length,
                    itemBuilder: (context, i) => Padding(
                      padding: const EdgeInsets.symmetric(vertical: 3),
                      child: Text(
                        _lines[i],
                        style: const TextStyle(
                          color: Color(0xFFE8E8E8),
                          fontFamily: 'monospace',
                          fontSize: 15,
                          height: 1.3,
                        ),
                      ),
                    ),
                  ),
                ),
                if (_winnerSide != null) _resultBanner(),
                const SizedBox(height: 8),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    TextButton(
                      onPressed: _skipToEnd,
                      child: const Text('▶▶ 最後まで', style: TextStyle(color: Colors.white70)),
                    ),
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: const Text('もう一度', style: TextStyle(color: Colors.white70)),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _hpBar(String id, Color color) {
    final max = _maxHp[id] ?? 1;
    final hp = (_hp[id] ?? 0).clamp(0, max);
    final ratio = max == 0 ? 0.0 : hp / max;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(_name(id), style: const TextStyle(color: Colors.white, fontSize: 14)),
            Text('$hp / $max', style: const TextStyle(color: Colors.white54, fontSize: 12)),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: ratio.toDouble(),
            minHeight: 12,
            backgroundColor: Colors.white12,
            valueColor: AlwaysStoppedAnimation(color),
          ),
        ),
      ],
    );
  }

  Widget _resultBanner() {
    final text = _winnerSide == 'draw'
        ? '引き分け'
        : '${_name(_sideWinnerId())} の勝利！';
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(vertical: 10),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: Colors.amber.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: Colors.amber, width: 1),
      ),
      child: Text(
        text,
        style: const TextStyle(color: Colors.amber, fontSize: 18, fontWeight: FontWeight.bold),
      ),
    );
  }

  String _sideWinnerId() {
    for (final entry in _side.entries) {
      if (entry.value == _winnerSide) return entry.key;
    }
    return _winnerSide ?? '';
  }
}
