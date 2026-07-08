// M6.3: 観戦 UI が扱う大会ドメインモデル（tournaments/standings/matches/tournament_entrants 行）。
// すべて全員参照の共有コンテンツ（非同期観戦）。名前は entrants の snapshot から解決する
// （characters.name は RLS で本人しか読めないため・実装プラン M6.3）。

/// 大会サマリ（= tournaments 行）。
class TournamentSummary {
  final String id;
  final String name;
  final String status; // scheduled | running | finished
  final String phase; // league | bracket | done
  final int? season;
  final String? championId;

  const TournamentSummary({
    required this.id,
    required this.name,
    required this.status,
    required this.phase,
    required this.season,
    required this.championId,
  });

  bool get isFinished => status == 'finished';

  factory TournamentSummary.fromRow(Map<String, dynamic> r) => TournamentSummary(
        id: r['id'] as String,
        name: r['name'] as String,
        status: r['status'] as String,
        phase: r['phase'] as String,
        season: r['season'] as int?,
        championId: r['champion_id'] as String?,
      );
}

/// 順位表の1行（= standings 行）。
class StandingRow {
  final String characterId;
  final int wins;
  final int losses;
  final int draws;
  final int points;
  final int rank;

  const StandingRow({
    required this.characterId,
    required this.wins,
    required this.losses,
    required this.draws,
    required this.points,
    required this.rank,
  });

  factory StandingRow.fromRow(Map<String, dynamic> r) => StandingRow(
        characterId: r['character_id'] as String,
        wins: r['wins'] as int,
        losses: r['losses'] as int,
        draws: r['draws'] as int,
        points: r['points'] as int,
        rank: r['rank'] as int,
      );
}

/// 対戦カード1件（= matches 行）。done なら eventLog をタップ再生できる。
class TournamentMatch {
  final String id;
  final String phase; // league | bracket
  final int round;
  final String characterA;
  final String? characterB;
  final String? winner; // 'A' | 'B' | 'draw' | null(未消化)
  final String status; // pending | done

  const TournamentMatch({
    required this.id,
    required this.phase,
    required this.round,
    required this.characterA,
    required this.characterB,
    required this.winner,
    required this.status,
  });

  bool get isDone => status == 'done';
  bool get isBracket => phase == 'bracket';

  /// 勝者の character_id（引き分け/未消化は null）。
  String? get winnerId => winner == 'A'
      ? characterA
      : winner == 'B'
          ? characterB
          : null;

  factory TournamentMatch.fromRow(Map<String, dynamic> r) => TournamentMatch(
        id: r['id'] as String,
        phase: r['phase'] as String,
        round: r['round'] as int,
        characterA: r['character_a'] as String,
        characterB: r['character_b'] as String?,
        winner: r['winner'] as String?,
        status: r['status'] as String,
      );
}

/// 昇降格（= tournaments.promotion JSONB / engine PromotionResult）。
class Promotion {
  final List<String> promote;
  final List<String> relegate;
  final List<String> stay;

  const Promotion({required this.promote, required this.relegate, required this.stay});

  static List<String> _list(dynamic v) =>
      (v as List?)?.map((e) => e as String).toList() ?? const [];

  factory Promotion.fromJson(Map<String, dynamic> j) => Promotion(
        promote: _list(j['promote']),
        relegate: _list(j['relegate']),
        stay: _list(j['stay']),
      );
}

/// 観戦画面が必要とする1大会ぶんの集約ビュー。
class TournamentView {
  final TournamentSummary summary;
  final Map<String, String> names; // character_id -> 表示名（entrants snapshot）
  final List<StandingRow> standings; // rank 昇順
  final List<TournamentMatch> matches; // 予選→決勝, round 昇順
  final Promotion? promotion;

  const TournamentView({
    required this.summary,
    required this.names,
    required this.standings,
    required this.matches,
    required this.promotion,
  });

  String nameOf(String id) => names[id] ?? id.substring(0, id.length < 6 ? id.length : 6);
}
