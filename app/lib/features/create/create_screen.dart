import 'package:flutter/material.dart';

import '../../models/character_build.dart';
import '../../services/battle_api.dart';

/// M5.4: 初回のみ。名前 + スターター（level1・配分プール内）を選んでキャラを作成。
/// 以降は 1ユーザー1キャラ＝ホーム（育成ループ）へ。ステ振りで伸ばしていく。
class CreateScreen extends StatefulWidget {
  final BattleApi api;
  final VoidCallback onCreated;
  const CreateScreen({super.key, required this.api, required this.onCreated});

  @override
  State<CreateScreen> createState() => _CreateScreenState();
}

class _Preset {
  final String label;
  final String defaultName;
  final CharacterBuild build;
  const _Preset(this.label, this.defaultName, this.build);
}

// スターターは level1・配分プール(basePool)内に収める（ステ振りで伸ばす前提の弱め）。
const _presets = <_Preset>[
  _Preset(
    '戦士',
    '戦士',
    CharacterBuild(
      level: 1,
      stats: Stats(vit: 9, mag: 1, pow: 14, spd: 7, men: 4),
      spellLines: SpellLines(),
      equipment: EquipmentLoadout(weapon: 'sword_iron', armor: 'mail_leather'),
    ),
  ),
  _Preset(
    '魔法使い',
    '魔法使い',
    CharacterBuild(
      level: 1,
      stats: Stats(vit: 6, mag: 12, pow: 2, spd: 6, men: 3),
      spellLines: SpellLines(fire: 10),
      equipment: EquipmentLoadout(weapon: 'staff_oak', armor: 'robe'),
    ),
  ),
  _Preset(
    '僧侶',
    '僧侶',
    CharacterBuild(
      level: 1,
      stats: Stats(vit: 9, mag: 9, pow: 6, spd: 6, men: 4),
      spellLines: SpellLines(cure: 10),
      equipment: EquipmentLoadout(weapon: 'sword_iron', armor: 'mail_leather'),
    ),
  ),
];

class _CreateScreenState extends State<CreateScreen> {
  int _selected = 0;
  late final TextEditingController _name =
      TextEditingController(text: _presets[0].defaultName);
  bool _busy = false;
  String? _error;

  Future<void> _create() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final preset = _presets[_selected];
      final name = _name.text.trim().isEmpty ? preset.defaultName : _name.text.trim();
      await widget.api.createCharacter(name, preset.build);
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
    return Scaffold(
      appBar: AppBar(title: const Text('PROXY CHAMPIONS — 分身をつくる')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('あなたの分身（1体）をつくる。派遣ダンジョンで育てよう。',
                    style: TextStyle(fontSize: 14)),
                const SizedBox(height: 20),
                TextField(
                  controller: _name,
                  decoration: const InputDecoration(
                    labelText: 'キャラ名',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 16),
                const Text('スターター', style: TextStyle(fontWeight: FontWeight.bold)),
                const SizedBox(height: 8),
                RadioGroup<int>(
                  groupValue: _selected,
                  onChanged: (v) {
                    if (_busy || v == null) return;
                    setState(() {
                      _selected = v;
                      _name.text = _presets[v].defaultName;
                    });
                  },
                  child: Column(
                    children: [
                      for (var i = 0; i < _presets.length; i++)
                        RadioListTile<int>(
                          value: i,
                          title: Text(_presets[i].label),
                          subtitle: Text(_statLine(_presets[i].build)),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),
                FilledButton(
                  onPressed: _busy ? null : _create,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: _busy
                        ? const SizedBox(
                            height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('この分身ではじめる ▶'),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 16),
                  Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _statLine(CharacterBuild b) {
    final s = b.stats;
    return 'VIT ${s.vit} / MAG ${s.mag} / POW ${s.pow} / SPD ${s.spd} / MEN ${s.men}';
  }
}
