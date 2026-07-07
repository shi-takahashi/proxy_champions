import 'package:flutter/material.dart';

import 'features/create/create_screen.dart';
import 'features/home/home_screen.dart';
import 'services/battle_api.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await BattleApi.init();
  runApp(const ProxyChampionsApp());
}

class ProxyChampionsApp extends StatelessWidget {
  const ProxyChampionsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PROXY CHAMPIONS',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.indigo,
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
      ),
      home: const _Boot(),
    );
  }
}

/// 匿名サインイン（M3）→ 自分のキャラ有無で分岐:
///   キャラあり → ホーム（育成ループ） / なし → 作成画面 → 作成後ホーム。
class _Boot extends StatefulWidget {
  const _Boot();

  @override
  State<_Boot> createState() => _BootState();
}

class _BootState extends State<_Boot> {
  final _api = BattleApi();
  Future<bool>? _ready; // true = キャラあり

  @override
  void initState() {
    super.initState();
    _ready = _boot();
  }

  Future<bool> _boot() async {
    await _api.signIn();
    final char = await _api.fetchMyCharacter();
    return char != null;
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<bool>(
      future: _ready,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        if (snap.hasError) {
          return Scaffold(
            body: Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text('起動失敗:\n${snap.error}',
                    textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
              ),
            ),
          );
        }
        if (snap.data == true) {
          return HomeScreen(api: _api);
        }
        return CreateScreen(
          api: _api,
          onCreated: () => setState(() => _ready = Future.value(true)),
        );
      },
    );
  }
}
