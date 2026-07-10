-- M5.5: 派遣の実時間・非同期化（企画書3.3.1「アプリは閉じてよい・非同期・拘束しない」）。
--   これまでの「押した瞬間に全連戦を解決して即返す」を、
--   「派遣開始 → 指定時間は留守 → 帰還予定時刻を過ぎたら受け取り」へ変更する。
--
--   決定論シミュ（dive）は開始時に一度だけ回して結果を dispatch_pending に退避し、
--   ends_at を過ぎてから受け取り（collect）で適用して消す。アプリを開いた時に遅延確定するので
--   定時バッチは不要（企画書450行目「定時バッチ + DB読み取り」の軽量版）。
--   ※即時解決はデバッグ用に Edge Function 側で action='dispatch_instant' として温存。
alter table public.characters
  add column dispatch_ends_at timestamptz,   -- null=未派遣。派遣中の帰還予定時刻（体力0の強制帰還なら早まる）
  add column dispatch_pending jsonb;         -- 退避した確定用データ（受け取りで適用してクリア）
