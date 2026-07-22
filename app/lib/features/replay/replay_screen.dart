import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../models/battle_event.dart';

/// クラシックRPG風の戦闘再生（企画書4章）。
/// 黒背景・等幅テキストのログ送り・上部に A/B の HP バー・被弾で画面シェイク。
/// eventLog を順に消化するだけ（＝サーバーが返した決定論ログの純粋な再生）。
///
/// 送りは「意味のある1ビート」単位（gauge_ready などの繋ぎイベントは、次の
/// 攻撃/魔法/回復/撃破まで一緒に消化する）。手動送り（[次へ]）と自動再生を
/// 画面内トグルで切り替えられる。[autoStart] で初期モードを決める
/// （練習試合＝手動でじっくり、大会観戦＝自動で流し見）。
class ReplayScreen extends StatefulWidget {
  final List<BattleEvent> eventLog;
  final Map<String, String> nameOf; // combatant id -> 表示名
  final bool autoStart; // true=最初から自動再生 / false=手動送り

  const ReplayScreen({
    super.key,
    required this.eventLog,
    required this.nameOf,
    this.autoStart = false,
  });

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
  bool _auto = false;
  String? _winnerSide;

  late final AnimationController _shake = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 320),
  );

  String _name(String id) => widget.nameOf[id] ?? id;
  bool get _finished => _i >= widget.eventLog.length;

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
    if (widget.autoStart) _startAuto();
  }

  /// 1イベント分の状態反映（HPバー・勝敗・シェイク・ログ行）。setState はしない。
  void _applyEvent(BattleEvent e) {
    if (e.hpAfter != null && e.target != null) _hp[e.target!] = e.hpAfter!;
    if (e.isEnd) _winnerSide = e.winner;
    if (e.causesShake) _shake.forward(from: 0);
    _lines.add(e.describe(_name));
  }

  /// 「意味のある1ビート」進める＝繋ぎイベント（gauge_ready 等）を消化してから、
  /// 最初の意味あるイベント（攻撃/魔法/撃破/決着…）を1つ出したところで止める。
  void _advanceBeat() {
    if (_finished) return;
    var emittedMeaningful = false;
    while (_i < widget.eventLog.length && !emittedMeaningful) {
      final e = widget.eventLog[_i++];
      _applyEvent(e);
      if (!e.isConnective) emittedMeaningful = true;
    }
    setState(() {});
    _scrollToEnd(animate: true);
    if (_finished) _stopAuto();
  }

  void _startAuto() {
    if (_finished) return;
    _timer?.cancel();
    _auto = true;
    _timer = Timer.periodic(const Duration(milliseconds: 650), (_) => _advanceBeat());
  }

  void _stopAuto() {
    _timer?.cancel();
    _timer = null;
    if (_auto && mounted) {
      setState(() => _auto = false);
    } else {
      _auto = false;
    }
  }

  void _toggleAuto() {
    if (_auto) {
      _stopAuto();
    } else {
      setState(_startAuto);
    }
  }

  void _skipToEnd() {
    _stopAuto();
    while (_i < widget.eventLog.length) {
      _applyEvent(widget.eventLog[_i++]);
    }
    setState(() {});
    _scrollToEnd(animate: false);
  }

  void _scrollToEnd({required bool animate}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      if (animate) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      } else {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
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
                _controls(),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _controls() {
    // 決着後は送り系を隠し、[もう一度] だけ残す。
    if (_finished) {
      return Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('もう一度', style: TextStyle(color: Colors.white70)),
          ),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // 手動送りの主役ボタン。自動再生中は無効化（自動が進めているため）。
        ElevatedButton.icon(
          onPressed: _auto ? null : _advanceBeat,
          icon: const Icon(Icons.play_arrow),
          label: const Text('次へ'),
          style: ElevatedButton.styleFrom(
            backgroundColor: Colors.lightBlueAccent,
            foregroundColor: Colors.black,
            disabledBackgroundColor: Colors.white12,
            disabledForegroundColor: Colors.white38,
            padding: const EdgeInsets.symmetric(vertical: 14),
            textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
          ),
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            TextButton.icon(
              onPressed: _toggleAuto,
              icon: Icon(_auto ? Icons.pause : Icons.fast_forward, size: 18, color: Colors.white70),
              label: Text(_auto ? '一時停止' : '自動再生', style: const TextStyle(color: Colors.white70)),
            ),
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
