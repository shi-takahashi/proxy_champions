import 'package:flutter/material.dart';

import '../../models/game_models.dart';
import '../../services/battle_api.dart';

/// ショップ（ゴールドの出口・企画書3.6 店＝狙い撃ち／3.3 回復薬）。買う／売るの2モード。
///   ・買う：販売リスト shop_listings が正本（運用がテーブルで管理・期間限定/セール対応）。
///   ・売る：不要な装備/回復薬をゴールドに換える。売却価格の正本は catalog.sell_price（DB マスタ）。
///   ・購入/売却の価格照合・ゴールド増減・所持更新はすべてサーバー権威（run-dispatch: buy/sell）。
/// ※ 買った装備を「装備し替える」UI は別タスク（今は所持＝倉庫に入るだけ）。
class ShopScreen extends StatefulWidget {
  final BattleApi api;
  final Character character;
  final int initialGold;
  const ShopScreen({
    super.key,
    required this.api,
    required this.character,
    required this.initialGold,
  });

  @override
  State<ShopScreen> createState() => _ShopScreenState();
}

class _ShopScreenState extends State<ShopScreen> {
  List<ShopListing>? _listings;
  List<SellEntry>? _sellables;
  late int _gold = widget.initialGold;
  bool _selling = false; // false=買う / true=売る
  bool _changed = false; // ゴールド/所持が変わったか（ホームの再読込に使う）
  String? _busyId; // 処理中の行ID（多重タップ防止）
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final listings = await widget.api.fetchShopListings();
      final sellables = await widget.api.fetchSellables();
      final p = await widget.api.fetchPlayerState();
      if (!mounted) return;
      setState(() {
        _listings = listings;
        _sellables = sellables;
        _gold = p.gold;
      });
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  bool _isEquipped(String equipmentId) {
    final e = widget.character.build.equipment;
    return e.weapon == equipmentId || e.armor == equipmentId || e.shield == equipmentId;
  }

  Future<void> _buy(ShopListing l) async {
    setState(() {
      _busyId = l.listingId;
      _error = null;
    });
    try {
      final left = await widget.api.buyListing(widget.character.id, l.listingId);
      if (!mounted) return;
      setState(() {
        _gold = left;
        _changed = true;
      });
      await _load();
      _toast('${l.name} を購入しました');
    } catch (err) {
      if (mounted) setState(() => _error = '$err');
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _sell(SellEntry s) async {
    // 装備は「型」を手放す＝取り返しがつくが確認する。回復薬は1個ずつ確認なしで売る。
    if (s.isEquipment) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
          title: const Text('売却の確認'),
          content: Text('${s.name} を ${s.sellPrice} コインで売りますか？'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('やめる')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('売る')),
          ],
        ),
      );
      if (ok != true) return;
    }
    setState(() {
      _busyId = '${s.kind}:${s.id}';
      _error = null;
    });
    try {
      final left = await widget.api.sell(widget.character.id, s.kind, s.id);
      if (!mounted) return;
      setState(() {
        _gold = left;
        _changed = true;
      });
      await _load();
      _toast('${s.name} を売りました');
    } catch (err) {
      if (mounted) setState(() => _error = '$err');
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), duration: const Duration(seconds: 2)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
        appBar: AppBar(
          title: const Text('ショップ'),
          actions: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(children: [
                const Icon(Icons.monetization_on, size: 18, color: Colors.amber),
                const SizedBox(width: 6),
                Text('$_gold', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              ]),
            ),
          ],
        ),
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                  child: SegmentedButton<bool>(
                    segments: const [
                      ButtonSegment(value: false, label: Text('買う'), icon: Icon(Icons.shopping_cart)),
                      ButtonSegment(value: true, label: Text('売る'), icon: Icon(Icons.sell)),
                    ],
                    selected: {_selling},
                    onSelectionChanged: _busyId != null
                        ? null
                        : (s) => setState(() {
                              _selling = s.first;
                              _error = null;
                            }),
                  ),
                ),
                Expanded(child: _selling ? _sellBody() : _buyBody()),
              ],
            ),
          ),
        ),
      ),
    );
  }

  // ── 買う ────────────────────────────────────────────
  Widget _buyBody() {
    final listings = _listings;
    if (listings == null) return _loadingOrError();
    if (listings.isEmpty) {
      return _empty('今は販売中の商品がありません。');
    }
    final equipment = listings.where((l) => l.isEquipment).toList();
    final items = listings.where((l) => !l.isEquipment).toList();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text('ゴールドで装備（型）と回復薬を買えます。装備は同じ型を1つだけ所持できます。',
            style: TextStyle(fontSize: 12, color: Colors.white54)),
        const SizedBox(height: 12),
        if (_error != null) _errorLine(),
        if (equipment.isNotEmpty) ...[_sectionHeader('装備'), ...equipment.map(_listingTile)],
        if (items.isNotEmpty) ...[_sectionHeader('回復薬'), ...items.map(_listingTile)],
        const SizedBox(height: 24),
        const Text('※ 買った装備は倉庫に入ります（装備の付け替えは今後のアップデートで）。',
            style: TextStyle(fontSize: 11, color: Colors.white38)),
      ],
    );
  }

  Widget _listingTile(ShopListing l) {
    final busy = _busyId == l.listingId;
    final canBuy = !l.owned && _gold >= l.price && _busyId == null;
    final subtitleLines = <String>[
      if (l.description != null && l.description!.isNotEmpty) l.description!,
      if (l.isLimited) '期間限定 〜${_fmtDate(l.endsAt!)}まで',
    ];
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(
        title: Row(children: [
          Flexible(child: Text(l.name)),
          if (l.isLimited) ...[const SizedBox(width: 8), _badge('限定', Colors.deepOrange)],
        ]),
        subtitle: subtitleLines.isEmpty ? null : Text(subtitleLines.join('\n'), style: const TextStyle(fontSize: 12)),
        isThreeLine: subtitleLines.length > 1,
        trailing: l.owned
            ? const Text('所持済み', style: TextStyle(color: Colors.white38, fontSize: 13))
            : _priceButton(price: l.price, busy: busy, enabled: canBuy, label: '買う', onTap: () => _buy(l)),
      ),
    );
  }

  // ── 売る ────────────────────────────────────────────
  Widget _sellBody() {
    final sellables = _sellables;
    if (sellables == null) return _loadingOrError();
    if (sellables.isEmpty) {
      return _empty('売れる所持品がありません。');
    }
    final equipment = sellables.where((s) => s.isEquipment).toList();
    final items = sellables.where((s) => !s.isEquipment).toList();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text('不要な装備・回復薬をゴールドに換えます。装備中のものは外すまで売れません。',
            style: TextStyle(fontSize: 12, color: Colors.white54)),
        const SizedBox(height: 12),
        if (_error != null) _errorLine(),
        if (equipment.isNotEmpty) ...[_sectionHeader('装備'), ...equipment.map(_sellTile)],
        if (items.isNotEmpty) ...[_sectionHeader('回復薬'), ...items.map(_sellTile)],
      ],
    );
  }

  Widget _sellTile(SellEntry s) {
    final busy = _busyId == '${s.kind}:${s.id}';
    final equipped = s.isEquipment && _isEquipped(s.id);
    final canSell = s.sellable && !equipped && _busyId == null;
    final title = s.isEquipment ? s.name : '${s.name} ×${s.quantity}';
    final trailing = !s.sellable
        ? const Text('売却不可', style: TextStyle(color: Colors.white38, fontSize: 13))
        : equipped
            ? const Text('装備中', style: TextStyle(color: Colors.white38, fontSize: 13))
            : _priceButton(price: s.sellPrice!, busy: busy, enabled: canSell, label: '売る', onTap: () => _sell(s));
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(title: Text(title), trailing: trailing),
    );
  }

  // ── 共通パーツ ────────────────────────────────────────
  Widget _loadingOrError() => _error != null
      ? Padding(padding: const EdgeInsets.all(24), child: Text(_error!, style: const TextStyle(color: Colors.red)))
      : const Center(child: CircularProgressIndicator());

  Widget _empty(String msg) => Padding(
        padding: const EdgeInsets.all(24),
        child: Center(child: Text(msg, style: const TextStyle(color: Colors.white54))),
      );

  Widget _errorLine() => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
      );

  Widget _sectionHeader(String label) => Padding(
        padding: const EdgeInsets.only(top: 16, bottom: 8),
        child: Text(label, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
      );

  Widget _badge(String text, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(color: color.withValues(alpha: 0.85), borderRadius: BorderRadius.circular(4)),
        child: Text(text, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold)),
      );

  Widget _priceButton({
    required int price,
    required bool busy,
    required bool enabled,
    required String label,
    required VoidCallback onTap,
  }) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(children: [
          const Icon(Icons.monetization_on, size: 15, color: Colors.amber),
          const SizedBox(width: 4),
          Text('$price', style: const TextStyle(fontWeight: FontWeight.bold)),
        ]),
        const SizedBox(width: 12),
        SizedBox(
          width: 72,
          child: FilledButton(
            onPressed: enabled ? onTap : null,
            style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 8)),
            child: busy
                ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(label),
          ),
        ),
      ],
    );
  }

  String _fmtDate(DateTime d) => '${d.month}/${d.day}';
}
