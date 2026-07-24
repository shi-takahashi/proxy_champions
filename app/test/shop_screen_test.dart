// ショップUI（ShopScreen）の決定論ウィジェットテスト（headless・Supabase を触らない）。
//   ・ショップマスタ（shop_listings）由来の販売行を、商品名/価格付きで描画する
//   ・所持済み装備は「所持済み」表示（＝買えない）
//   ・ゴールド不足の品は「買う」ボタンが無効
//   ・期間限定（ends_at あり）の商品は「限定」バッジ＋終了日が出る
//   ・購入すると残ゴールドが更新され、所持済みに変わる（スタブが状態を進める）
//
// サーバー側の価格照合・販売期間検証・ゴールド減算・付与の正しさは
// supabase/scripts/verify_shop.ts（ライブ green）が担保。ここは UI 描画と購入導線を固定する。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:proxy_champions/models/character_build.dart';
import 'package:proxy_champions/models/game_models.dart';
import 'package:proxy_champions/features/shop/shop_screen.dart';
import 'package:proxy_champions/services/battle_api.dart';

/// ショップ関連メソッドだけ差し替えるスタブ。購入で内部状態（所持/ゴールド）を進める。
class _StubApi extends BattleApi {
  int gold;
  final Set<String> owned = {};
  _StubApi(this.gold);

  @override
  Future<List<ShopListing>> fetchShopListings() async => [
        ShopListing(
          listingId: 'L-dagger', productType: 'equipment', equipmentId: 'dagger', itemId: null,
          name: '短剣', description: '素早さ型の武器', price: 180, endsAt: null, owned: owned.contains('dagger'),
        ),
        ShopListing(
          listingId: 'L-elixir', productType: 'item', equipmentId: null, itemId: 'elixir',
          name: 'エリクサー', description: 'HP・MPを全回復', price: 400, endsAt: null, owned: false,
        ),
        ShopListing(
          listingId: 'L-sale-axe', productType: 'equipment', equipmentId: 'axe_battle', itemId: null,
          name: '【夏セール】戦斧', description: '期間限定の特価', price: 250,
          endsAt: DateTime(2026, 8, 8), owned: owned.contains('axe_battle'),
        ),
      ];

  @override
  Future<List<SellEntry>> fetchSellables() async => [
        // 倉庫の装備（dagger は非装備＝売れる）
        SellEntry(kind: 'equipment', id: 'dagger', name: '短剣', sellPrice: 90, quantity: owned.contains('dagger') ? 1 : 1),
        // 装備中（キャラの weapon = sword_iron）＝画面側で「装備中」表示
        const SellEntry(kind: 'equipment', id: 'sword_iron', name: '鉄の剣', sellPrice: 100, quantity: 1),
        // 回復薬
        const SellEntry(kind: 'item', id: 'potion_hp_small', name: 'HP回復薬（小）', sellPrice: 15, quantity: 3),
      ];

  @override
  Future<int> sell(String characterId, String kind, String id, {int quantity = 1}) async {
    gold += id == 'dagger' ? 90 : id == 'potion_hp_small' ? 15 : 100;
    return gold;
  }

  @override
  Future<PlayerState> fetchPlayerState() async => PlayerState(gold: gold);

  @override
  Future<int> buyListing(String characterId, String listingId, {int quantity = 1}) async {
    if (listingId == 'L-dagger') {
      gold -= 180;
      owned.add('dagger');
    } else if (listingId == 'L-sale-axe') {
      gold -= 250;
      owned.add('axe_battle');
    } else {
      gold -= 400;
    }
    return gold;
  }
}

Character _char() => Character(
      id: 'hero',
      name: '見習い',
      level: 1,
      xp: 0,
      currentHp: null,
      currentMp: null,
      build: const CharacterBuild(
        level: 1,
        stats: Stats(vit: 16, mag: 4, pow: 16, spd: 10, men: 6),
        spellLines: SpellLines(),
        equipment: EquipmentLoadout(weapon: 'sword_iron', armor: 'mail_leather'),
      ),
    );

Future<void> _pumpShop(WidgetTester tester, _StubApi api) async {
  // ListView は画面外の項目を遅延生成するため、全品が描画されるよう縦長のサーフェスにする。
  tester.view.physicalSize = const Size(1200, 3000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(MaterialApp(home: ShopScreen(api: api, character: _char(), initialGold: api.gold)));
  await tester.pump(); // _load の await を解決
  await tester.pump();
}

void main() {
  testWidgets('ショップ: マスタ由来の商品が商品名・価格付きで描画される', (tester) async {
    await _pumpShop(tester, _StubApi(500));

    expect(find.text('装備'), findsOneWidget);
    expect(find.text('回復薬'), findsOneWidget);

    expect(find.text('短剣'), findsOneWidget);
    expect(find.text('エリクサー'), findsOneWidget);
    expect(find.text('【夏セール】戦斧'), findsOneWidget);
    // 価格表示
    expect(find.text('180'), findsOneWidget);
    expect(find.text('400'), findsOneWidget);
    expect(find.text('250'), findsOneWidget);
  });

  testWidgets('ショップ: 期間限定商品は「限定」バッジと終了日が出る', (tester) async {
    await _pumpShop(tester, _StubApi(500));

    expect(find.text('限定'), findsOneWidget); // 夏セール戦斧のみ
    expect(find.textContaining('期間限定 〜8/8まで'), findsOneWidget);
  });

  testWidgets('ショップ: ゴールド不足だとエリクサー(400)の買うボタンが無効', (tester) async {
    await _pumpShop(tester, _StubApi(200)); // 200G＝エリクサー不可、短剣(180)は可

    final elixirTile = find.ancestor(of: find.text('エリクサー'), matching: find.byType(ListTile));
    final elixirBtn = find.descendant(of: elixirTile, matching: find.byType(FilledButton));
    expect(tester.widget<FilledButton>(elixirBtn).onPressed, isNull);

    final daggerTile = find.ancestor(of: find.text('短剣'), matching: find.byType(ListTile));
    final daggerBtn = find.descendant(of: daggerTile, matching: find.byType(FilledButton));
    expect(tester.widget<FilledButton>(daggerBtn).onPressed, isNotNull);
  });

  testWidgets('ショップ: 装備を買うと残ゴールドが減り「所持済み」になる', (tester) async {
    await _pumpShop(tester, _StubApi(500));

    final daggerTile = find.ancestor(of: find.text('短剣'), matching: find.byType(ListTile));
    final daggerBtn = find.descendant(of: daggerTile, matching: find.byType(FilledButton));
    await tester.tap(daggerBtn);
    await tester.pump(); // buyListing の await
    await tester.pump(); // _load の await
    await tester.pump();

    // 残ゴールド 320（AppBar 等に出る）
    expect(find.text('320'), findsWidgets);
    // 短剣は所持済みに変わる
    final daggerTile2 = find.ancestor(of: find.text('短剣'), matching: find.byType(ListTile));
    expect(find.descendant(of: daggerTile2, matching: find.text('所持済み')), findsOneWidget);
  });

  testWidgets('ショップ: 売るモードで所持品が売却価格付きで並び、装備中は売れない', (tester) async {
    await _pumpShop(tester, _StubApi(500));

    // 「売る」へ切り替え
    await tester.tap(find.text('売る'));
    await tester.pump();
    await tester.pump();

    // 倉庫の短剣（売価90）は売れる
    final daggerTile = find.ancestor(of: find.text('短剣'), matching: find.byType(ListTile));
    expect(find.descendant(of: daggerTile, matching: find.text('90')), findsOneWidget);
    final daggerBtn = find.descendant(of: daggerTile, matching: find.byType(FilledButton));
    expect(tester.widget<FilledButton>(daggerBtn).onPressed, isNotNull);

    // 鉄の剣は装備中 → 「装備中」表示（ボタンなし）
    final swordTile = find.ancestor(of: find.text('鉄の剣'), matching: find.byType(ListTile));
    expect(find.descendant(of: swordTile, matching: find.text('装備中')), findsOneWidget);

    // 回復薬は個数付きで並ぶ
    expect(find.text('HP回復薬（小） ×3'), findsOneWidget);
  });

  testWidgets('ショップ: 回復薬を売るとゴールドが増える', (tester) async {
    await _pumpShop(tester, _StubApi(500));
    await tester.tap(find.text('売る'));
    await tester.pump();
    await tester.pump();

    // 回復薬（売価15）を売る（アイテムは確認ダイアログなし）
    final potionTile = find.ancestor(of: find.text('HP回復薬（小） ×3'), matching: find.byType(ListTile));
    await tester.tap(find.descendant(of: potionTile, matching: find.byType(FilledButton)));
    await tester.pump(); // sell の await
    await tester.pump(); // _load
    await tester.pump();

    // 515 に増える
    expect(find.text('515'), findsWidgets);
  });
}
