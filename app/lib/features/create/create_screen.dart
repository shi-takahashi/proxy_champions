import 'package:flutter/material.dart';

import '../../models/character_build.dart';
import '../../services/battle_api.dart';
import '../replay/replay_screen.dart';

/// M4 の入口: 名前 + プリセットビルドを選び「作成して1戦」。
/// フルなステ振り UI は M5（育成ループ）。ここは縦スライスを通す最小フォーム。
class CreateScreen extends StatefulWidget {
  final BattleApi api;
  const CreateScreen({super.key, required this.api});

  @override
  State<CreateScreen> createState() => _CreateScreenState();
}

class _Preset {
  final String label;
  final String defaultName;
  final CharacterBuild build;
  const _Preset(this.label, this.defaultName, this.build);
}

const _presets = <_Preset>[
  _Preset(
    '脳筋戦士',
    '脳筋戦士',
    CharacterBuild(
      level: 12,
      stats: Stats(vit: 14, mag: 2, pow: 16, spd: 8, men: 5),
      spellLines: SpellLines(),
      equipment: EquipmentLoadout(weapon: 'axe_battle', armor: 'mail_iron', shield: 'shield_iron'),
    ),
  ),
  _Preset(
    '魔法使い',
    '魔法使い',
    CharacterBuild(
      level: 12,
      stats: Stats(vit: 8, mag: 18, pow: 3, spd: 9, men: 7),
      spellLines: SpellLines(fire: 30, cure: 10),
      equipment: EquipmentLoadout(weapon: 'staff_oak', armor: 'robe'),
    ),
  ),
];

class _CreateScreenState extends State<CreateScreen> {
  int _selected = 0;
  late final TextEditingController _name =
      TextEditingController(text: _presets[0].defaultName);
  bool _busy = false;
  String? _error;

  Future<void> _fight() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final preset = _presets[_selected];
      final name = _name.text.trim().isEmpty ? preset.defaultName : _name.text.trim();
      final api = widget.api;

      final characterId = await api.createCharacter(name, preset.build); // DB 保存
      final matchId = await api.runBattle(characterId); // Edge Function で battle()
      final log = await api.fetchEventLog(matchId); // eventLog 取得

      // side A = 自キャラ / side B = スパーリングダミー（B の id を fighters から解決）
      final start = log.firstWhere((e) => e.type == 'battle_start');
      final nameOf = <String, String>{};
      for (final f in start.fighters) {
        nameOf[f.id] = f.side == 'A' ? name : 'スパーリングダミー';
      }

      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => ReplayScreen(eventLog: log, nameOf: nameOf)),
      );
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
      appBar: AppBar(title: const Text('PROXY CHAMPIONS — 練習試合')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('キャラを作って、スパーリング相手と即時オート1戦。',
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
                const Text('ビルド', style: TextStyle(fontWeight: FontWeight.bold)),
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
                  onPressed: _busy ? null : _fight,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: _busy
                        ? const SizedBox(
                            height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('作成して1戦 ▶'),
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
