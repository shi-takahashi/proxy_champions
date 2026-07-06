import 'package:flutter/material.dart';

import 'features/create/create_screen.dart';
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

/// 匿名サインイン（M3 基盤）を済ませてから作成画面へ。
class _Boot extends StatefulWidget {
  const _Boot();

  @override
  State<_Boot> createState() => _BootState();
}

class _BootState extends State<_Boot> {
  final _api = BattleApi();
  late final Future<void> _ready = _api.signIn();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder(
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
                child: Text('サインイン失敗:\n${snap.error}',
                    textAlign: TextAlign.center, style: const TextStyle(color: Colors.red)),
              ),
            ),
          );
        }
        return CreateScreen(api: _api);
      },
    );
  }
}
