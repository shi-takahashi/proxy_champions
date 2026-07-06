// 継ぎ目②: engine/src/schema.ts の BattleEvent(discriminated union・12種) を Dart にミラー。
// 再生に必要な情報のみ typed で取り出し、表示行(describe)と演出フラグ(causesShake/isKo)を持つ。
// 正本は TS 側。線を越えるのは JSON。

/// battle_start が運ぶ各戦闘者の初期情報（HP バーの分母＝maxHp）。
class Fighter {
  final String id;
  final String side; // 'A' | 'B'
  final int maxHp;

  const Fighter({required this.id, required this.side, required this.maxHp});

  factory Fighter.fromJson(Map<String, dynamic> j) => Fighter(
        id: j['id'] as String,
        side: j['side'] as String,
        maxHp: (j['maxHp'] as num).toInt(),
      );
}

class BattleEvent {
  final String type;
  final int t;
  final Map<String, dynamic> raw;

  const BattleEvent({required this.type, required this.t, required this.raw});

  factory BattleEvent.fromJson(Map<String, dynamic> j) => BattleEvent(
        type: j['type'] as String,
        t: (j['t'] as num).toInt(),
        raw: j,
      );

  // ── 共通アクセサ（存在しない種別では null）
  String? get actor => raw['actor'] as String?;
  String? get target => raw['target'] as String?;
  int? get hpAfter => (raw['hpAfter'] as num?)?.toInt();
  bool get crit => raw['crit'] == true;

  /// 対象の HP を変化させる量（attack.damage / damage.amount / heal.amount）。回復は正の heal。
  int get damage => (raw['damage'] as num?)?.toInt() ?? (raw['amount'] as num?)?.toInt() ?? 0;
  int get heal => (raw['amount'] as num?)?.toInt() ?? 0;

  String? get winner => raw['winner'] as String?;
  List<Fighter> get fighters => ((raw['fighters'] as List?) ?? const [])
      .map((e) => Fighter.fromJson(e as Map<String, dynamic>))
      .toList();

  /// 被弾＝画面シェイク（物理命中 or 魔法ダメージ）。
  bool get causesShake =>
      (type == 'attack' && damage > 0) || type == 'damage';

  bool get isKo => type == 'ko';
  bool get isEnd => type == 'battle_end';

  /// クラシックRPG風のログ1行。names[id] で表示名解決（無ければ id）。
  String describe(String Function(String id) name) {
    switch (type) {
      case 'battle_start':
        return '⚔  戦闘開始';
      case 'gauge_ready':
        return '${name(actor!)} のターン';
      case 'attack':
        final a = name(actor!);
        final tgt = name(target!);
        if (damage <= 0) return '$a の攻撃 … しかし外れた';
        final c = crit ? '  会心の一撃！' : '';
        return '$a の攻撃！ $tgt に $damage ダメージ$c';
      case 'miss':
        return '${name(actor!)} の攻撃を ${name(target!)} は回避した';
      case 'cast':
        final spell = _spellName(raw['spell'] as String?);
        return '${name(actor!)} は $spell をとなえた';
      case 'damage':
        final c = crit ? '  会心！' : '';
        return '${name(target!)} に $damage の魔法ダメージ$c';
      case 'heal':
        return '${name(target!)} の HP が $heal 回復した';
      case 'buff':
        return '${name(target!)} の ${raw['stat']} が上がった';
      case 'status_apply':
        final ok = raw['success'] == true;
        final st = _statusName(raw['status'] as String?);
        return ok
            ? '${name(target!)} は $st におちいった'
            : '${name(target!)} に $st は効かなかった';
      case 'status_wake':
        final st = _statusName(raw['status'] as String?);
        final r = raw['reason'] == 'hit' ? '（攻撃で）' : '';
        return '${name(target!)} は $st から目を覚ました$r';
      case 'ko':
        return '${name(target!)} は たおれた';
      case 'battle_end':
        if (winner == 'draw') return '── 引き分け ──';
        return '── 勝者: 側 $winner ──';
      default:
        return type;
    }
  }

  static String _spellName(String? s) {
    switch (s) {
      case 'fire':
        return 'ファイア';
      case 'cure':
        return 'ケアル';
      case 'sleep':
        return 'スリプル';
      case 'strength':
        return 'バフ';
      default:
        return s ?? '呪文';
    }
  }

  static String _statusName(String? s) => s == 'sleep' ? '睡眠' : (s ?? '状態異常');
}
