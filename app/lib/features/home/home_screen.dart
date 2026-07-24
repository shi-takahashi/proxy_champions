import 'dart:async';

import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';

import '../../models/game_models.dart';
import '../../models/stat_labels.dart';
import '../../services/battle_api.dart';
import '../../widgets/build_preview.dart';
import '../allocate/allocate_screen.dart';
import '../dispatch/dispatch_screen.dart';
import '../replay/replay_screen.dart';
import '../shop/shop_screen.dart';
import '../tournament/tournament_screen.dart';

/// M5.4: 育成ループのホーム（1ユーザー1キャラのダッシュボード）。
/// Lv/経験値・HP/MP・コイン・回復薬を表示し、派遣／回復／ステ振り／練習試合へ。
class HomeScreen extends StatefulWidget {
  final BattleApi api;
  const HomeScreen({super.key, required this.api});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Character? _char;
  PlayerState? _player;
  List<InventoryItem> _inventory = const []; // 所持アイテム（回復薬）
  CharacterStatus? _status; // 実効体力＋派遣状態（サーバー算出）。取得失敗時は null → 保存値にフォールバック。
  bool _loading = true;
  bool _busy = false;
  String? _error;
  Timer? _countdown; // 派遣中に帰還までをポーリングして表示更新＋自動受け取り

  @override
  void initState() {
    super.initState();
    _reload();
  }

  @override
  void dispose() {
    _countdown?.cancel();
    super.dispose();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      var char = await widget.api.fetchMyCharacter();
      var player = await widget.api.fetchPlayerState();
      var inventory = await widget.api.fetchInventory();
      CharacterStatus? status;
      DispatchResult? collected;
      if (char != null) {
        try {
          status = await widget.api.fetchStatus(char.id);
          // 帰還予定時刻を過ぎていれば、開いたこのタイミングで受け取る（遅延確定）。
          if (status.canCollect) {
            collected = await widget.api.collectDispatch(char.id);
            char = await widget.api.fetchMyCharacter();
            player = await widget.api.fetchPlayerState();
            inventory = await widget.api.fetchInventory();
            status = await widget.api.fetchStatus(char!.id);
          }
        } catch (_) {
          status = null;
        }
      }
      if (!mounted) return;
      setState(() {
        _char = char;
        _player = player;
        _inventory = inventory;
        _status = status;
        _loading = false;
      });
      _syncCountdown();
      if (collected != null) await _showReport(collected);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  /// 派遣中だけ定期的に状態を取り直す（残り分の更新＋帰還したら自動受け取り）。
  void _syncCountdown() {
    _countdown?.cancel();
    final s = _status;
    if (s != null && s.dispatching) {
      _countdown = Timer.periodic(const Duration(seconds: 20), (_) => _tick());
    }
  }

  /// 軽量ポーリング（スピナーを出さずに status だけ更新）。帰還したら full reload で受け取り。
  Future<void> _tick() async {
    final c = _char;
    if (!mounted || _busy || c == null) return;
    try {
      final s = await widget.api.fetchStatus(c.id);
      if (!mounted) return;
      if (s.canCollect) {
        _countdown?.cancel();
        await _reload();
        return;
      }
      setState(() => _status = s);
    } catch (_) {
      // 一時的な失敗は無視（次のtickで回復）
    }
  }

  /// 帰還レポートをダイアログ表示。
  Future<void> _showReport(DispatchResult r) async {
    if (!mounted) return;
    final mhp = _char?.maxHpValue;
    final mmp = _char?.maxMpValue;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(r.returnedByKo ? '⚔ 力尽きて強制帰還' : '🏁 派遣から帰還'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [Text('戦った回数: ${r.battles} 戦'), Text('獲得経験値: +${r.xpGained}'), if (r.leveledUp > 0) Text('レベルアップ: Lv${r.level}（+${r.leveledUp}）'), Text('獲得コイン: +${r.goldGained}'), Text('ドロップ: ${r.drops.isEmpty ? 'なし' : r.drops.map((d) => dropName(d.kind, d.id)).join(', ')}'), Text('残りHP: ${r.hpRemaining}${mhp != null ? ' / $mhp' : ''}'), Text('残りMP: ${r.mpRemaining}${mmp != null ? ' / $mmp' : ''}')]),
        actions: [TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('OK'))],
      ),
    );
  }

  Future<void> _openDispatch() async {
    final result = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => DispatchScreen(api: widget.api, character: _char!),
      ),
    );
    if (result == true) await _reload();
  }

  Future<void> _openAllocate() async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => AllocateScreen(api: widget.api, character: _char!),
      ),
    );
    if (changed == true) await _reload();
  }

  Future<void> _openTournament() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => TournamentScreen(api: widget.api)));
  }

  Future<void> _openShop() async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => ShopScreen(api: widget.api, character: _char!, initialGold: _player!.gold),
      ),
    );
    if (changed == true) await _reload(); // ゴールド/所持が変わったら再読込
  }

  Future<void> _useItem(InventoryItem item) async {
    setState(() => _busy = true);
    try {
      await widget.api.useItem(_char!.id, item.id);
      await _reload();
    } catch (e) {
      if (mounted) _snack('$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _practice() async {
    setState(() => _busy = true);
    try {
      final api = widget.api;
      final matchId = await api.runBattle(_char!.id);
      final log = await api.fetchEventLog(matchId);
      final start = log.firstWhere((e) => e.type == 'battle_start');
      final nameOf = <String, String>{};
      for (final f in start.fighters) {
        nameOf[f.id] = f.side == 'A' ? _char!.name : 'スパーリングダミー';
      }
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(
          // 練習試合は手動送り（autoStart 既定 false）でじっくり読ませる。
          builder: (_) => ReplayScreen(eventLog: log, nameOf: nameOf),
        ),
      );
    } catch (e) {
      if (mounted) _snack('$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  /// HPバーの補足文（自然回復のETA＝完全回復まで）。サーバー未取得(null)なら文言なし。
  /// ※以前は「HP1で派遣可能まで」を出していたが、HP1派遣は無意味なので完全回復までに変更。
  String? _hpNote(CharacterStatus? hs) {
    if (hs == null) return null;
    if (hs.resting) {
      return '力尽きている — 完全回復まで${_fmtMin(hs.minutesToFull)}（回復薬で即完全回復）';
    }
    if (hs.minutesToFull > 0) {
      return '完全回復まで${_fmtMin(hs.minutesToFull)}';
    }
    return null; // 完全回復済み
  }

  /// MPバーの補足文（自然回復のETA＝完全回復まで）。派遣中・回復済み・未取得なら文言なし。
  String? _mpNote(CharacterStatus? hs) {
    if (hs == null || hs.dispatching) return null;
    if (hs.mpMinutesToFull > 0) {
      return '完全回復まで${_fmtMin(hs.mpMinutesToFull)}';
    }
    return null; // 完全回復済み
  }

  /// 分を「約N分 / 約N時間M分」に整形。
  String _fmtMin(int m) {
    if (m <= 0) return 'まもなく';
    if (m < 60) return '約$m分';
    final h = m ~/ 60, mm = m % 60;
    return mm == 0 ? '約$h時間' : '約$h時間$mm分';
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final c = _char, p = _player;
    if (c == null || p == null) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              '読み込み失敗:\n${_error ?? '不明'}',
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.red),
            ),
          ),
        ),
      );
    }

    final xp = c.xpProgress;
    // 実効体力はサーバー算出（自然回復込み）。取得できなければ保存値にフォールバック。
    final hs = _status;
    final hp = hs?.hp ?? c.hpValue;
    final mhp = hs?.maxHp ?? c.maxHpValue;
    final mp = hs?.mp ?? c.mpValue; // MP も HP と同じ管理資源
    final mmp = hs?.maxMp ?? c.maxMpValue;
    final resting = hs?.resting ?? (hp <= 0);
    final hpNote = _hpNote(hs);
    final mpNote = _mpNote(hs);
    final dispatching = hs?.dispatching ?? false; // 派遣中＝留守（キャラ操作は不可）

    return Scaffold(
      appBar: AppBar(
        title: Text('${c.name}  Lv${c.level}'),
        actions: [IconButton(onPressed: _busy ? null : _reload, icon: const Icon(Icons.refresh))],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              _bar('経験値', xp.intoLevel, xp.toNext, Colors.amber, '次のLvまであと ${xp.toNext - xp.intoLevel}'),
              const SizedBox(height: 14),
              _bar('HP', hp, mhp, resting ? Colors.grey : Colors.redAccent, hpNote),
              const SizedBox(height: 14),
              _bar('MP', mp, mmp, Colors.blueAccent, mpNote),
              const SizedBox(height: 20),
              Row(children: [_chip(Icons.monetization_on, '${p.gold} コイン')]),
              const SizedBox(height: 8),
              _equipLine(c),
              const SizedBox(height: 12),
              BuildPreview(
                stats: c.build.stats,
                lines: c.build.spellLines,
                equipment: c.build.equipment,
                includeMaxHpMp: false, // HP/MP はバーで見えるので省く
              ),
              const Divider(height: 40),
              if (dispatching) _dispatchingCard(hs!),
              if (!dispatching)
                FilledButton.icon(
                  onPressed: _busy ? null : _openDispatch,
                  icon: const Icon(Icons.explore),
                  style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
                  label: const Text('派遣する ▶'),
                ),
              const SizedBox(height: 12),
              _inventorySection(dispatching: dispatching, hp: hp, mhp: mhp, mp: mp, mmp: mmp),
              const SizedBox(height: 12),
              OutlinedButton.icon(onPressed: (_busy || dispatching) ? null : _openAllocate, icon: const Icon(Icons.tune), label: const Text('ステータス / 育成')),
              const SizedBox(height: 12),
              OutlinedButton.icon(onPressed: _busy ? null : _openShop, icon: const Icon(Icons.storefront), label: const Text('ショップ 🛒')),
              const SizedBox(height: 12),
              OutlinedButton.icon(onPressed: _busy ? null : _openTournament, icon: const Icon(Icons.emoji_events), label: const Text('大会を観る 🏆')),
              const SizedBox(height: 12),
              OutlinedButton.icon(onPressed: (_busy || dispatching) ? null : _practice, icon: const Icon(Icons.sports_kabaddi), label: const Text('練習試合')),
              // ★デバッグ機能はデバッグビルドのみ（kDebugMode はリリースで false ＝ここ自体が消える）。
              if (kDebugMode) _debugPanel(),
            ],
          ),
        ),
      ),
    );
  }

  /// ★デバッグパネル（kDebugMode 限定・リリースビルドには存在しない）。
  /// 今はコイン付与のみ。今後デバッグ機能を足すならここに追加していく。
  Widget _debugPanel() {
    return Card(
      color: Colors.deepPurple.withValues(alpha: 0.18),
      margin: const EdgeInsets.only(top: 24),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: const [
              Icon(Icons.bug_report, size: 18, color: Colors.purpleAccent),
              SizedBox(width: 6),
              Text('デバッグ（開発ビルドのみ）', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
            ]),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                for (final n in [100, 1000, 10000])
                  OutlinedButton(
                    onPressed: _busy ? null : () => _grantGold(n),
                    child: Text('コイン +$n'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _grantGold(int amount) async {
    setState(() => _busy = true);
    try {
      await widget.api.debugGrantGold(_char!.id, amount);
      await _reload();
      _snack('コインを $amount 付与しました');
    } catch (e) {
      if (mounted) _snack('$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 派遣中カード（留守・帰還までの残り時間）。アプリを閉じてよい旨を明示。
  Widget _dispatchingCard(CharacterStatus s) {
    return Card(
      color: Colors.indigo.withValues(alpha: 0.25),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.hourglass_top),
                const SizedBox(width: 8),
                Expanded(
                  child: Text('派遣中：${s.dungeonName.isEmpty ? 'ダンジョン' : s.dungeonName}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text('帰還まで ${_fmtMin(s.minutesRemaining)}', style: const TextStyle(fontSize: 14)),
            const SizedBox(height: 4),
            const Text('アプリは閉じてOK。帰還後にまた開くと結果を受け取れます。', style: TextStyle(fontSize: 11, color: Colors.white54)),
          ],
        ),
      ),
    );
  }

  /// 所持アイテム（回復薬）一覧。各アイテムに「使う」ボタン（効果が無い＝満タン等なら無効）。
  Widget _inventorySection({
    required bool dispatching,
    required int hp,
    required int mhp,
    required int mp,
    required int mmp,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('アイテム', style: TextStyle(fontWeight: FontWeight.bold)),
        const SizedBox(height: 6),
        if (_inventory.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 4),
            child: Text('所持アイテムなし（ダンジョンで入手）', style: TextStyle(fontSize: 12, color: Colors.white54)),
          )
        else
          ..._inventory.map((item) => _inventoryTile(item, dispatching, hp, mhp, mp, mmp)),
      ],
    );
  }

  Widget _inventoryTile(InventoryItem item, bool dispatching, int hp, int mhp, int mp, int mmp) {
    // 効果が発生する余地があるか（満タンなら無効化）。both は HP か MP のどちらかが減っていれば有効。
    final usefulHp = hp < mhp;
    final usefulMp = mp < mmp;
    final useful = switch (item.effectKind) {
      'hp' => usefulHp,
      'mp' => usefulMp,
      _ => usefulHp || usefulMp,
    };
    final enabled = !_busy && !dispatching && useful;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          const Icon(Icons.local_drink, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${item.name} ×${item.quantity}', style: const TextStyle(fontWeight: FontWeight.w600)),
                Text(itemEffectText(item.effectKind, item.effectPct), style: const TextStyle(fontSize: 11, color: Colors.white54)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          OutlinedButton(
            onPressed: enabled ? () => _useItem(item) : null,
            child: Text(useful ? '使う' : '満タン'),
          ),
        ],
      ),
    );
  }

  Widget _bar(String label, int value, int max, Color color, String? note) {
    final frac = max <= 0 ? 0.0 : (value / max).clamp(0.0, 1.0);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(label, style: const TextStyle(fontWeight: FontWeight.bold)),
            Text('$value / $max'),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(6),
          child: LinearProgressIndicator(value: frac, minHeight: 12, color: color),
        ),
        if (note != null) ...[const SizedBox(height: 4), Text(note, style: const TextStyle(fontSize: 11, color: Colors.white54))],
      ],
    );
  }

  Widget _chip(IconData icon, String text) {
    return Chip(avatar: Icon(icon, size: 18), label: Text(text));
  }

  Widget _equipLine(Character c) {
    final e = c.build.equipment;
    final parts = [e.weapon, e.armor, e.shield].whereType<String>().map(equipmentName).join(' / ');
    return Text('装備: ${parts.isEmpty ? 'なし' : parts}', style: const TextStyle(fontSize: 12, color: Colors.white54));
  }
}
