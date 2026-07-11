import 'package:flutter/material.dart';

import '../../models/character_build.dart';
import '../../models/game_math.dart';
import '../../models/stat_labels.dart';
import '../../services/battle_api.dart';

/// M5.4: 初回のみ。名前をつけ、Lv1 の配分プール（basePool）を自分好みに振ってキャラを作成。
/// 職業（クラス）は無い。近接寄り・魔法寄りなど、ステと魔法ラインの振り方で個性を出す。
/// 以降は 1ユーザー1キャラ＝ホーム（育成ループ）へ。ステ振りで伸ばしていく。
class CreateScreen extends StatefulWidget {
  final BattleApi api;
  final VoidCallback onCreated;
  const CreateScreen({super.key, required this.api, required this.onCreated});

  @override
  State<CreateScreen> createState() => _CreateScreenState();
}

class _CreateScreenState extends State<CreateScreen> {
  final TextEditingController _name = TextEditingController();

  // 全ステを下限(1)・全ラインを0 から開始。プール(40) をまっさらに振り分ける。
  final Map<String, int> _stats = {for (final k in statKeys) k: statFloor};
  final Map<String, int> _lines = {for (final k in lineKeys) k: 0};

  bool _busy = false;
  String? _error;

  void _bump(Map<String, int> map, String key, int delta, int floor) {
    final next = map[key]! + delta;
    if (next < floor) return;
    setState(() => map[key] = next);
  }

  Future<void> _create() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final name = _name.text.trim();
      final build = CharacterBuild(
        level: 1,
        stats: Stats(vit: _stats['vit']!, mag: _stats['mag']!, pow: _stats['pow']!, spd: _stats['spd']!, men: _stats['men']!),
        spellLines: SpellLines(fire: _lines['fire']!, cure: _lines['cure']!, sleep: _lines['sleep']!, strength: _lines['strength']!),
        // 初期装備は共通の基本セット（装備の切り替えは今後の育成で）。
        equipment: const EquipmentLoadout(weapon: 'sword_iron', armor: 'mail_leather'),
      );
      await widget.api.createCharacter(name, build);
      if (!mounted) return;
      widget.onCreated();
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final check = checkAllocation(1, _stats, _lines);
    final hasName = _name.text.trim().isNotEmpty;
    final canCreate = hasName && check.ok && !_busy;

    return Scaffold(
      appBar: AppBar(title: const Text('PROXY CHAMPIONS — 分身をつくる')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              const Text('ポイントを好きに振って、あなたの分身をつくってください。', style: TextStyle(fontSize: 14)),
              const SizedBox(height: 20),
              TextField(
                controller: _name,
                onChanged: (_) => setState(() {}), // 名前の有無でボタン活性を更新
                decoration: const InputDecoration(labelText: 'キャラ名', hintText: '名前を入力', border: OutlineInputBorder()),
              ),
              const SizedBox(height: 16),
              _poolHeader(check),
              const SizedBox(height: 12),
              const Text('基本ステータス', style: TextStyle(fontWeight: FontWeight.bold)),
              const SizedBox(height: 4),
              for (final k in statKeys) _row(statInfo[k]!.$1, statInfo[k]!.$2, _stats[k]!, () => _bump(_stats, k, -1, statFloor), () => _bump(_stats, k, 1, statFloor), check.unspent > 0),
              const SizedBox(height: 16),
              const Text('魔法（覚えたい呪文に振る）', style: TextStyle(fontWeight: FontWeight.bold)),
              const Text('10 ポイントごとに 1 段階強くなる。0 のままなら覚えない。', style: TextStyle(fontSize: 11, color: Colors.white54)),
              const SizedBox(height: 4),
              for (final k in lineKeys) _row(_lineTitle(k), lineInfo[k]!.$2, _lines[k]!, () => _bump(_lines, k, -1, 0), () => _bump(_lines, k, 1, 0), check.unspent > 0),
              const SizedBox(height: 20),
              if (check.unspent > 0) Text('残り ${check.unspent} ポイントは今振らなくてもOK（あとで振れます）', style: const TextStyle(fontSize: 12, color: Colors.white54)),
              const SizedBox(height: 12),
              FilledButton(
                onPressed: canCreate ? _create : null,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: _busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('この分身ではじめる ▶'),
                ),
              ),
              if (!hasName) ...[const SizedBox(height: 8), const Text('※ 名前を入力してください', style: TextStyle(color: Colors.white54, fontSize: 12))],
              if (_error != null) ...[const SizedBox(height: 16), Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12))],
            ],
          ),
        ),
      ),
    );
  }

  // 魔法ライン名に習得段階を併記（振っている時のみ）。
  String _lineTitle(String k) {
    final tier = _lines[k]! ~/ 10;
    return tier > 0 ? '${lineInfo[k]!.$1}（段階$tier）' : lineInfo[k]!.$1;
  }

  Widget _poolHeader(AllocationCheck check) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(8)),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _poolStat('もち点', '${check.pool}'),
          _poolStat('使った', '${check.spent}'),
          _poolStat('残り', '${check.unspent}', color: check.unspent < 0 ? Colors.red : Colors.greenAccent),
        ],
      ),
    );
  }

  Widget _poolStat(String label, String value, {Color? color}) {
    return Column(
      children: [
        Text(label, style: const TextStyle(fontSize: 11, color: Colors.white54)),
        const SizedBox(height: 2),
        Text(
          value,
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: color),
        ),
      ],
    );
  }

  // 名前＋説明（左） / − 値 ＋（右）の1行。
  Widget _row(String title, String desc, int value, VoidCallback onMinus, VoidCallback onPlus, bool canAdd) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
                Text(desc, style: const TextStyle(fontSize: 11, color: Colors.white54)),
              ],
            ),
          ),
          IconButton(onPressed: _busy ? null : onMinus, icon: const Icon(Icons.remove_circle_outline), visualDensity: VisualDensity.compact),
          SizedBox(width: 32, child: Text('$value', textAlign: TextAlign.center)),
          IconButton(onPressed: (_busy || !canAdd) ? null : onPlus, icon: const Icon(Icons.add_circle_outline), visualDensity: VisualDensity.compact),
        ],
      ),
    );
  }
}
