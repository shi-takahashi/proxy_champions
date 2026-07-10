import 'package:flutter/material.dart';

import '../../models/game_models.dart';
import '../../services/battle_api.dart';
import '../allocate/allocate_screen.dart';
import '../dispatch/dispatch_screen.dart';
import '../replay/replay_screen.dart';
import '../tournament/tournament_screen.dart';

/// M5.4: 育成ループのホーム（1ユーザー1キャラのダッシュボード）。
/// Lv/XP・体力・ゴールド・回復薬を表示し、派遣／回復／ステ振り／練習試合へ。
class HomeScreen extends StatefulWidget {
  final BattleApi api;
  const HomeScreen({super.key, required this.api});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Character? _char;
  PlayerState? _player;
  HpStatus? _hp; // 実効体力（サーバー算出）。取得失敗時は null → 保存値にフォールバック。
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
      final char = await widget.api.fetchMyCharacter();
      final player = await widget.api.fetchPlayerState();
      // 実効体力はサーバー算出。落ちても本体表示は止めない（保存値へフォールバック）。
      HpStatus? hp;
      if (char != null) {
        try {
          hp = await widget.api.fetchHpStatus(char.id);
        } catch (_) {
          hp = null;
        }
      }
      if (!mounted) return;
      setState(() {
        _char = char;
        _player = player;
        _hp = hp;
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

  Future<void> _openDispatch() async {
    final result = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => DispatchScreen(api: widget.api, character: _char!)),
    );
    if (result == true) await _reload();
  }

  Future<void> _openAllocate() async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => AllocateScreen(api: widget.api, character: _char!)),
    );
    if (changed == true) await _reload();
  }

  Future<void> _openTournament() async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => TournamentScreen(api: widget.api)),
    );
  }

  Future<void> _usePotion() async {
    setState(() => _busy = true);
    try {
      await widget.api.usePotion(_char!.id);
      await _reload();
    } catch (e) {
      if (mounted) _snack('$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _practice() async {
    setState(() => _busy = true);
    try {
      final api = widget.api;
      final matchId = await api.runBattle(_char!.id);
      final log = await api.fetchEventLog(matchId);
      final start = log.firstWhere((e) => e.type == 'battle_start');
      final nameOf = <String, String>{};
      for (final f in start.fighters) {
        nameOf[f.id] = f.side == 'A' ? _char!.name : 'スパーリングダミー';
      }
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => ReplayScreen(eventLog: log, nameOf: nameOf)),
      );
    } catch (e) {
      if (mounted) _snack('$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  /// 体力バーの補足文（自然回復のETA）。サーバー未取得(null)なら従来文言。
  String? _hpNote(HpStatus? hs) {
    if (hs == null) return null;
    if (hs.resting) {
      return '力尽きている — ${_fmtMin(hs.minutesToReady)}で派遣可能（回復薬なら即満タン）';
    }
    if (hs.minutesToFull > 0) {
      return '満タンまで${_fmtMin(hs.minutesToFull)}（毎分 最大HPの1%回復）';
    }
    return null; // 満タン
  }

  /// 分を「約N分 / 約N時間M分」に整形。
  String _fmtMin(int m) {
    if (m <= 0) return 'まもなく';
    if (m < 60) return '約$m分';
    final h = m ~/ 60, mm = m % 60;
    return mm == 0 ? '約$h時間' : '約$h時間$mm分';
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final c = _char, p = _player;
    if (c == null || p == null) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text('読み込み失敗:\n${_error ?? '不明'}',
                textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
          ),
        ),
      );
    }

    final xp = c.xpProgress;
    // 実効体力はサーバー算出（自然回復込み）。取得できなければ保存値にフォールバック。
    final hs = _hp;
    final hp = hs?.hp ?? c.hpValue;
    final mhp = hs?.maxHp ?? c.maxHpValue;
    final resting = hs?.resting ?? (hp <= 0);
    final hpNote = _hpNote(hs);

    return Scaffold(
      appBar: AppBar(
        title: Text('${c.name}  Lv${c.level}'),
        actions: [IconButton(onPressed: _busy ? null : _reload, icon: const Icon(Icons.refresh))],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              _bar('XP', xp.intoLevel, xp.toNext, Colors.amber, '次のLvまであとXP ${xp.toNext - xp.intoLevel}'),
              const SizedBox(height: 14),
              _bar('体力', hp, mhp, resting ? Colors.grey : Colors.redAccent, hpNote),
              const SizedBox(height: 20),
              Row(
                children: [
                  _chip(Icons.monetization_on, '${p.gold} G'),
                  const SizedBox(width: 12),
                  _chip(Icons.local_drink, '回復薬 ${p.potions}'),
                ],
              ),
              const SizedBox(height: 8),
              _equipLine(c),
              const Divider(height: 40),
              FilledButton.icon(
                onPressed: _busy ? null : _openDispatch,
                icon: const Icon(Icons.explore),
                style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
                label: const Text('派遣する ▶'),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: (_busy || p.potions <= 0 || hp >= mhp) ? null : _usePotion,
                icon: const Icon(Icons.local_drink),
                label: Text(p.potions <= 0
                    ? '回復薬がない'
                    : hp >= mhp
                        ? '体力は満タン'
                        : '回復薬を使う（体力を満タンに）'),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _busy ? null : _openAllocate,
                icon: const Icon(Icons.tune),
                label: const Text('ステ振り / 育成'),
              ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: _busy ? null : _openTournament,
                icon: const Icon(Icons.emoji_events),
                label: const Text('大会を観る 🏆'),
              ),
              const SizedBox(height: 12),
              TextButton.icon(
                onPressed: _busy ? null : _practice,
                icon: const Icon(Icons.sports_kabaddi),
                label: const Text('練習試合（スパーリング1戦）'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _bar(String label, int value, int max, Color color, String? note) {
    final frac = max <= 0 ? 0.0 : (value / max).clamp(0.0, 1.0);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(label, style: const TextStyle(fontWeight: FontWeight.bold)),
            Text('$value / $max'),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: LinearProgressIndicator(value: frac, minHeight: 12, color: color),
        ),
        if (note != null) ...[
          const SizedBox(height: 4),
          Text(note, style: const TextStyle(fontSize: 11, color: Colors.white54)),
        ],
      ],
    );
  }

  Widget _chip(IconData icon, String text) {
    return Chip(avatar: Icon(icon, size: 18), label: Text(text));
  }

  Widget _equipLine(Character c) {
    final e = c.build.equipment;
    final parts = [e.weapon, e.armor, e.shield].where((x) => x != null).join(' / ');
    return Text('装備: ${parts.isEmpty ? 'なし' : parts}',
        style: const TextStyle(fontSize: 12, color: Colors.white54));
  }
}
