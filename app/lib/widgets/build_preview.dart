import 'package:flutter/material.dart';

import '../models/character_build.dart';
import '../models/combat_stats.dart';
import '../models/game_math.dart';

/// ビルドの「強さの目安」パネル（物理/魔法の攻防・任意で最大HP/MP）。
/// ホーム＝現在の強さ、キャラメイク/ステ振り＝振った結果のプレビュー、で共通利用。
/// 相手なし・バフなしの静的値（[combatStats]）。
class BuildPreview extends StatelessWidget {
  final Stats stats;
  final SpellLines lines;
  final EquipmentLoadout equipment;

  /// 最大HP/最大MP も含めるか（ホームはバーで見えるので false、作成/ステ振りは true）。
  final bool includeMaxHpMp;

  const BuildPreview({super.key, required this.stats, required this.lines, required this.equipment, this.includeMaxHpMp = true});

  @override
  Widget build(BuildContext context) {
    final cs = combatStats(stats, lines, equipment);
    final rows = <(String, String)>[if (includeMaxHpMp) ('最大HP', '${maxHp(stats.vit)}'), if (includeMaxHpMp) ('最大MP', '${maxMp(stats.mag)}'), ('物理攻撃', '${cs.physAtk}'), ('物理防御', '${cs.physDef}'), ('魔法攻撃', '${cs.magAtk}'), ('魔法防御', '${cs.magDef}')];
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(8)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(height: 6),
          for (var i = 0; i < rows.length; i += 2)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  Expanded(child: _cell(rows[i])),
                  const SizedBox(width: 16),
                  Expanded(child: i + 1 < rows.length ? _cell(rows[i + 1]) : const SizedBox()),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _cell((String, String) kv) => Row(
    mainAxisAlignment: MainAxisAlignment.spaceBetween,
    children: [
      Text(kv.$1, style: const TextStyle(fontSize: 13, color: Colors.white70)),
      Text(kv.$2, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold)),
    ],
  );
}
