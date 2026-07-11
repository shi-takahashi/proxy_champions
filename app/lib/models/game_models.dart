// M5.4: 育成ループ UI が扱うドメインモデル（DB 行 / run-dispatch 応答のデシリアライズ）。
// characters/players/dungeons の列は snake_case、build 本体(JSONB)は engine 契約の camelCase。

import 'character_build.dart';
import 'game_math.dart';

/// 永続キャラ（= characters 行 + 成長/体力ループ）。1ユーザー1キャラ（企画書）。
class Character {
  final String id;
  final String name;
  final int level;
  final int xp;
  final int? currentHp; // null = 満タン（maxHp は engine 派生）
  final int? currentMp; // null = 満タン（maxMp は engine 派生・HP と同じ管理資源）
  final CharacterBuild build;

  const Character({
    required this.id,
    required this.name,
    required this.level,
    required this.xp,
    required this.currentHp,
    required this.currentMp,
    required this.build,
  });

  int get maxHpValue => maxHp(build.stats.vit);
  int get hpValue => currentHp ?? maxHpValue;
  int get maxMpValue => maxMp(build.stats.mag);
  int get mpValue => currentMp ?? maxMpValue;
  XpProgress get xpProgress => progressForXp(xp);

  factory Character.fromRow(Map<String, dynamic> r) => Character(
        id: r['id'] as String,
        name: r['name'] as String,
        level: r['level'] as int,
        xp: (r['xp'] as num).toInt(),
        currentHp: r['current_hp'] as int?,
        currentMp: r['current_mp'] as int?,
        build: CharacterBuild(
          level: r['level'] as int,
          stats: Stats.fromJson(r['stats'] as Map<String, dynamic>),
          spellLines: SpellLines.fromJson(r['spell_lines'] as Map<String, dynamic>),
          equipment: EquipmentLoadout.fromJson(r['equipment'] as Map<String, dynamic>),
        ),
      );
}

/// run-dispatch(status) のキャラ状態スナップショット。
/// 実効HP（自然回復込み）・回復ETA・派遣中かどうかを、すべてサーバーが算出する。
class CharacterStatus {
  final int hp; // 実効HP（回復反映後／派遣中は出発時点で固定）
  final int maxHp;
  final int mp; // 実効MP（回復反映後／派遣中は出発時点で固定・HP と同じ管理資源）
  final int maxMp;
  final bool resting; // hp <= 0（派遣不可）
  final int minutesToFull; // HP 満タンまでの推定分（0=満タン）
  final int mpMinutesToFull; // MP 満タンまでの推定分（0=満タン）
  final int minutesToReady; // 派遣可能（HP 1以上）までの推定分（0=すでに可能）
  final bool dispatching; // 派遣中（留守）
  final bool canCollect; // 帰還予定時刻を過ぎ、受け取り可能
  final int minutesRemaining; // 帰還までの残り分（派遣中のみ）
  final String dungeonName; // 派遣先（派遣中のみ）

  const CharacterStatus({
    required this.hp,
    required this.maxHp,
    required this.mp,
    required this.maxMp,
    required this.resting,
    required this.minutesToFull,
    required this.mpMinutesToFull,
    required this.minutesToReady,
    required this.dispatching,
    required this.canCollect,
    required this.minutesRemaining,
    required this.dungeonName,
  });

  factory CharacterStatus.fromJson(Map<String, dynamic> j) => CharacterStatus(
        hp: (j['hp'] as num).toInt(),
        maxHp: (j['maxHp'] as num).toInt(),
        mp: (j['mp'] as num?)?.toInt() ?? 0,
        maxMp: (j['maxMp'] as num?)?.toInt() ?? 0,
        resting: j['resting'] as bool,
        minutesToFull: (j['minutesToFull'] as num).toInt(),
        mpMinutesToFull: (j['mpMinutesToFull'] as num?)?.toInt() ?? 0,
        minutesToReady: (j['minutesToReady'] as num).toInt(),
        dispatching: (j['dispatching'] as bool?) ?? false,
        canCollect: (j['canCollect'] as bool?) ?? false,
        minutesRemaining: (j['minutesRemaining'] as num?)?.toInt() ?? 0,
        dungeonName: (j['dungeonName'] as String?) ?? '',
      );
}

/// プレイヤー資源（= players 行）。
class PlayerState {
  final int gold;
  final int potions;
  const PlayerState({required this.gold, required this.potions});

  factory PlayerState.fromRow(Map<String, dynamic> r) => PlayerState(
        gold: (r['gold'] as num).toInt(),
        potions: r['potions'] as int,
      );
}

/// 派遣先ダンジョン（= dungeons 行・共有コンテンツ）。
class Dungeon {
  final String id;
  final String slug;
  final String name;
  final String type;
  final int difficulty;
  final int recommendedDiveMinutes;

  const Dungeon({
    required this.id,
    required this.slug,
    required this.name,
    required this.type,
    required this.difficulty,
    required this.recommendedDiveMinutes,
  });

  factory Dungeon.fromRow(Map<String, dynamic> r) => Dungeon(
        id: r['id'] as String,
        slug: r['slug'] as String,
        name: r['name'] as String,
        type: r['type'] as String,
        difficulty: r['difficulty'] as int,
        recommendedDiveMinutes: r['recommended_dive_minutes'] as int,
      );
}

/// run-dispatch(dispatch) の帰還サマリ。
class DispatchResult {
  final String dispatchId;
  final int battles;
  final String endReason; // 'time' | 'ko'
  final int xpGained;
  final int goldGained;
  final List<String> drops;
  final int level;
  final int leveledUp;
  final int hpRemaining;
  final int mpRemaining;
  final int startHp;

  const DispatchResult({
    required this.dispatchId,
    required this.battles,
    required this.endReason,
    required this.xpGained,
    required this.goldGained,
    required this.drops,
    required this.level,
    required this.leveledUp,
    required this.hpRemaining,
    required this.mpRemaining,
    required this.startHp,
  });

  bool get returnedByKo => endReason == 'ko';

  factory DispatchResult.fromJson(Map<String, dynamic> j) => DispatchResult(
        dispatchId: j['dispatchId'] as String,
        battles: j['battles'] as int,
        endReason: j['endReason'] as String,
        xpGained: (j['xpGained'] as num).toInt(),
        goldGained: (j['goldGained'] as num).toInt(),
        drops: (j['drops'] as List).map((e) => e as String).toList(),
        level: j['level'] as int,
        leveledUp: j['leveledUp'] as int,
        hpRemaining: j['hpRemaining'] as int,
        mpRemaining: (j['mpRemaining'] as num?)?.toInt() ?? 0,
        startHp: j['startHp'] as int,
      );
}
