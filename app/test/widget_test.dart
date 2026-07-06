// M4: engine 契約ミラー（models）の健全性テスト。
// Supabase/ネットワークに依存しない純粋な JSON 往復・再生行生成のみを検証する。
import 'package:flutter_test/flutter_test.dart';
import 'package:proxy_champions/models/battle_event.dart';
import 'package:proxy_champions/models/character_build.dart';

void main() {
  test('CharacterBuild.toRow が characters テーブルの形（列 + JSONB）になる', () {
    const build = CharacterBuild(
      level: 12,
      stats: Stats(vit: 14, mag: 2, pow: 16, spd: 8, men: 5),
      spellLines: SpellLines(fire: 3),
      equipment: EquipmentLoadout(weapon: 'axe_battle', armor: 'mail_iron', shield: 'shield_iron'),
    );
    final row = build.toRow('脳筋戦士');
    expect(row['name'], '脳筋戦士');
    expect(row['level'], 12);
    expect((row['stats'] as Map)['pow'], 16);
    expect((row['spell_lines'] as Map)['fire'], 3);
    expect((row['equipment'] as Map)['weapon'], 'axe_battle');
  });

  test('BattleEvent が eventLog を再生行に変換できる', () {
    final start = BattleEvent.fromJson({
      'type': 'battle_start',
      't': 0,
      'teamA': ['a'],
      'teamB': ['b'],
      'fighters': [
        {'id': 'a', 'side': 'A', 'maxHp': 140},
        {'id': 'b', 'side': 'B', 'maxHp': 100},
      ],
      'seed': 1,
    });
    expect(start.fighters.length, 2);
    expect(start.fighters.first.maxHp, 140);

    final atk = BattleEvent.fromJson({
      'type': 'attack',
      't': 3,
      'actor': 'a',
      'target': 'b',
      'weapon': 'axe_battle',
      'damage': 42,
      'crit': false,
      'hpAfter': 58,
    });
    expect(atk.causesShake, true);
    expect(atk.hpAfter, 58);
    expect(atk.describe((id) => id == 'a' ? '勇者' : '敵'), contains('42 ダメージ'));

    final end = BattleEvent.fromJson({'type': 'battle_end', 't': 20, 'winner': 'A', 'seed': 1});
    expect(end.isEnd, true);
    expect(end.winner, 'A');
  });
}
