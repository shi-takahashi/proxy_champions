import 'package:flutter/material.dart';

import '../../models/game_models.dart';
import '../../services/battle_api.dart';

/// M5.4: 派遣ダンジョン（ダンジョン + 潜航時間 → run-dispatch → 帰還サマリ）。
/// 体力は前回帰還時から自然回復した値を起点にサーバーが計算する（企画書3.3）。
class DispatchScreen extends StatefulWidget {
  final BattleApi api;
  final Character character;
  const DispatchScreen({super.key, required this.api, required this.character});

  @override
  State<DispatchScreen> createState() => _DispatchScreenState();
}

class _DispatchScreenState extends State<DispatchScreen> {
  List<Dungeon>? _dungeons;
  Dungeon? _selected;
  int _minutes = 30;
  bool _busy = false;
  bool _debugInstant = false; // ★デバッグ: 即時解決（本来は実時間で留守にする）
  String? _error;
  DispatchResult? _result;

  static const _minuteChoices = [15, 30, 60, 120];

  @override
  void initState() {
    super.initState();
    _loadDungeons();
  }

  Future<void> _loadDungeons() async {
    try {
      final list = await widget.api.fetchDungeons();
      if (!mounted) return;
      setState(() {
        _dungeons = list;
        _selected = list.isNotEmpty ? list.first : null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  Future<void> _dispatch() async {
    if (_selected == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_debugInstant) {
        // デバッグ: 即時解決 → 帰還サマリをその場で表示（動作確認用）
        final r = await widget.api.dispatchInstant(widget.character.id, _selected!.id, _minutes);
        if (!mounted) return;
        setState(() => _result = r);
      } else {
        // 本来の挙動: 派遣を開始して留守にする → ホームへ戻り「派遣中」表示
        await widget.api.startDispatch(widget.character.id, _selected!.id, _minutes);
        if (!mounted) return;
        Navigator.of(context).pop(true);
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('派遣ダンジョン')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: _result != null ? _summary(_result!) : _form(),
          ),
        ),
      ),
    );
  }

  Widget _form() {
    final dungeons = _dungeons;
    if (dungeons == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('どこへ、どれだけ潜る？', style: TextStyle(fontSize: 14)),
        const SizedBox(height: 16),
        const Text('ダンジョン', style: TextStyle(fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        DropdownButtonFormField<Dungeon>(
          initialValue: _selected,
          decoration: const InputDecoration(border: OutlineInputBorder()),
          items: [
            for (final d in dungeons)
              DropdownMenuItem(value: d, child: Text('${d.name}（難度${d.difficulty}・${d.type}）')),
          ],
          onChanged: _busy ? null : (v) => setState(() => _selected = v),
        ),
        const SizedBox(height: 20),
        const Text('潜航時間', style: TextStyle(fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: [
            for (final m in _minuteChoices)
              ChoiceChip(
                label: Text('$m 分'),
                selected: _minutes == m,
                onSelected: _busy ? null : (_) => setState(() => _minutes = m),
              ),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          _debugInstant
              ? '【デバッグ】押した瞬間に結果まで解決します（留守にしない）。'
              : '派遣中はキャラが留守になり、指定時間は戻りません（アプリは閉じてOK）。'
                  '長く潜るほど稼げるが、体力が尽きると強制帰還（そこまでの報酬は持ち帰る）。',
          style: const TextStyle(fontSize: 11, color: Colors.white54),
        ),
        const SizedBox(height: 16),
        CheckboxListTile(
          value: _debugInstant,
          onChanged: _busy ? null : (v) => setState(() => _debugInstant = v ?? false),
          controlAffinity: ListTileControlAffinity.leading,
          contentPadding: EdgeInsets.zero,
          dense: true,
          title: const Text('即時解決（デバッグ）', style: TextStyle(fontSize: 13)),
          subtitle: const Text('待たずに結果を確認したい時用', style: TextStyle(fontSize: 11)),
        ),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _busy || _selected == null ? null : _dispatch,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: _busy
                ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(_debugInstant ? '即時解決で派遣 ▶（デバッグ）' : 'この設定で派遣 ▶'),
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 16),
          Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
        ],
      ],
    );
  }

  Widget _summary(DispatchResult r) {
    final mhp = widget.character.maxHpValue;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          r.returnedByKo ? '⚔ 力尽きて強制帰還' : '🏁 時間まで潜って帰還',
          style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 20),
        _row('戦った回数', '${r.battles} 戦'),
        _row('獲得XP', '+${r.xpGained}'),
        if (r.leveledUp > 0) _row('レベルアップ', 'Lv${r.level} へ（+${r.leveledUp}）', highlight: true),
        _row('獲得ゴールド', '+${r.goldGained} G'),
        _row('ドロップ', r.drops.isEmpty ? 'なし' : r.drops.join(', ')),
        _row('残り体力', '${r.hpRemaining} / $mhp'),
        const SizedBox(height: 28),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Text('ホームへ戻る'),
          ),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: _busy ? null : () => setState(() => _result = null),
          child: const Text('もう一度派遣する'),
        ),
      ],
    );
  }

  Widget _row(String label, String value, {bool highlight = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: Colors.white70)),
          Text(value,
              style: TextStyle(
                fontWeight: FontWeight.bold,
                color: highlight ? Colors.amber : null,
              )),
        ],
      ),
    );
  }
}
