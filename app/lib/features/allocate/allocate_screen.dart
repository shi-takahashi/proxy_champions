import 'package:flutter/material.dart';

import '../../models/character_build.dart';
import '../../models/game_math.dart';
import '../../models/game_models.dart';
import '../../services/battle_api.dart';

/// M5.4: ステ振り / 魔法ライン投資 / リスペック（企画書3.5）。
/// 1プール（poolForLevel）を基本5ステ＋4ラインで奪い合う。振り足し=無料、
/// どれかを下げる=リスペック（ゴールド消費）。engine growth をミラーで検証。
class AllocateScreen extends StatefulWidget {
  final BattleApi api;
  final Character character;
  const AllocateScreen({super.key, required this.api, required this.character});

  @override
  State<AllocateScreen> createState() => _AllocateScreenState();
}

const _statLabels = {
  'vit': '体力 VIT',
  'mag': '魔力 MAG',
  'pow': '力 POW',
  'spd': '素早さ SPD',
  'men': '精神 MEN',
};
const _lineLabels = {
  'fire': '火 FIRE',
  'cure': '回復 CURE',
  'sleep': '眠り SLEEP',
  'strength': '力up STR',
};

class _AllocateScreenState extends State<AllocateScreen> {
  late final Map<String, int> _stats;
  late final Map<String, int> _lines;
  late final Map<String, int> _origStats;
  late final Map<String, int> _origLines;

  int _gold = 0;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final s = widget.character.build.stats;
    final l = widget.character.build.spellLines;
    _stats = {'vit': s.vit, 'mag': s.mag, 'pow': s.pow, 'spd': s.spd, 'men': s.men};
    _lines = {'fire': l.fire, 'cure': l.cure, 'sleep': l.sleep, 'strength': l.strength};
    _origStats = Map.of(_stats);
    _origLines = Map.of(_lines);
    _loadGold();
  }

  Future<void> _loadGold() async {
    try {
      final p = await widget.api.fetchPlayerState();
      if (mounted) setState(() => _gold = p.gold);
    } catch (_) {/* ゴールド未取得でも編集は可（保存時に検証） */}
  }

  bool get _isRespec {
    for (final k in statKeys) {
      if (_stats[k]! < _origStats[k]!) return true;
    }
    for (final k in lineKeys) {
      if (_lines[k]! < _origLines[k]!) return true;
    }
    return false;
  }

  bool get _dirty =>
      statKeys.any((k) => _stats[k] != _origStats[k]) ||
      lineKeys.any((k) => _lines[k] != _origLines[k]);

  void _bump(Map<String, int> map, String key, int delta, int floor) {
    final next = (map[key]! + delta);
    if (next < floor) return;
    setState(() => map[key] = next);
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final stats = Stats(
          vit: _stats['vit']!, mag: _stats['mag']!, pow: _stats['pow']!,
          spd: _stats['spd']!, men: _stats['men']!);
      final lines = SpellLines(
          fire: _lines['fire']!, cure: _lines['cure']!,
          sleep: _lines['sleep']!, strength: _lines['strength']!);
      if (_isRespec) {
        await widget.api.respecAllocation(
            widget.character.id, stats, lines, respecCost(widget.character.level));
      } else {
        await widget.api.saveAllocation(widget.character.id, stats, lines);
      }
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final level = widget.character.level;
    final check = checkAllocation(level, _stats, _lines);
    final respecFee = respecCost(level);
    final canAfford = !_isRespec || _gold >= respecFee;
    final canSave = _dirty && check.ok && canAfford && !_busy;

    return Scaffold(
      appBar: AppBar(title: Text('ステ振り  Lv$level')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              _poolHeader(check),
              const SizedBox(height: 12),
              const Text('基本ステータス', style: TextStyle(fontWeight: FontWeight.bold)),
              for (final k in statKeys)
                _stepper(_statLabels[k]!, _stats[k]!, () => _bump(_stats, k, -1, statFloor),
                    () => _bump(_stats, k, 1, statFloor), check.unspent > 0),
              const SizedBox(height: 16),
              const Text('魔法ライン（10 ごとに Tier 習得）', style: TextStyle(fontWeight: FontWeight.bold)),
              for (final k in lineKeys)
                _stepper('${_lineLabels[k]!}  (T${_lines[k]! ~/ 10})', _lines[k]!,
                    () => _bump(_lines, k, -1, 0), () => _bump(_lines, k, 1, 0), check.unspent > 0),
              const SizedBox(height: 20),
              if (_isRespec)
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    border: Border.all(color: Colors.orangeAccent),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    'リスペック（振り直し）: $respecFee コイン 消費  /  所持 $_gold コイン'
                    '${canAfford ? '' : ' … コインが足りない'}',
                    style: TextStyle(
                        fontSize: 12, color: canAfford ? Colors.orangeAccent : Colors.red),
                  ),
                ),
              if (!check.ok) ...[
                const SizedBox(height: 8),
                Text('⚠ ${check.reason}', style: const TextStyle(color: Colors.red, fontSize: 12)),
              ],
              const SizedBox(height: 16),
              FilledButton(
                onPressed: canSave ? _save : null,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: _busy
                      ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                      : Text(_isRespec ? '振り直して保存（$respecFee G）' : '保存'),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _poolHeader(AllocationCheck check) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white10,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _poolStat('プール', '${check.pool}'),
          _poolStat('使用', '${check.spent}'),
          _poolStat('残り', '${check.unspent}',
              color: check.unspent < 0 ? Colors.red : Colors.greenAccent),
        ],
      ),
    );
  }

  Widget _poolStat(String label, String value, {Color? color}) {
    return Column(
      children: [
        Text(label, style: const TextStyle(fontSize: 11, color: Colors.white54)),
        const SizedBox(height: 2),
        Text(value, style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: color)),
      ],
    );
  }

  Widget _stepper(String label, int value, VoidCallback onMinus, VoidCallback onPlus, bool canAdd) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(child: Text(label)),
          IconButton(
            onPressed: _busy ? null : onMinus,
            icon: const Icon(Icons.remove_circle_outline),
            visualDensity: VisualDensity.compact,
          ),
          SizedBox(width: 32, child: Text('$value', textAlign: TextAlign.center)),
          IconButton(
            onPressed: (_busy || !canAdd) ? null : onPlus,
            icon: const Icon(Icons.add_circle_outline),
            visualDensity: VisualDensity.compact,
          ),
        ],
      ),
    );
  }
}
