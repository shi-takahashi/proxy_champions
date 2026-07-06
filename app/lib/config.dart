/// Supabase 接続情報。ローカルスタック（supabase start）の既定値を持ち、
/// 本番/別環境は --dart-define=SUPABASE_URL=... / SUPABASE_ANON_KEY=... で上書きする。
/// ローカルの anon key は supabase CLI が全インストール共通で発行するデモ鍵。
class AppConfig {
  static const supabaseUrl = String.fromEnvironment(
    'SUPABASE_URL',
    defaultValue: 'http://127.0.0.1:54321',
  );

  static const supabaseAnonKey = String.fromEnvironment(
    'SUPABASE_ANON_KEY',
    defaultValue:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  );
}
