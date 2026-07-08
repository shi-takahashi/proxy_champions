-- M6.2: 定時バッチのスケジューラ配線（pg_cron → Edge Function・企画書13.5）。
--
-- これは「運用が環境ごとに1回流す」設定 SQL であって、reset で毎回走るマイグレーションではない
-- （URL / service key は環境依存・秘匿情報のため）。冪等な run-tournament(tick) を定時に叩くだけ。
-- 進行と冪等の正本は run-tournament / engine tournament.ts 側にあり、cron は「タイマー」に過ぎない。
--
-- verify_m6.ts が tick を日次ループで駆動して自動進行＋冪等を実証する（＝一次証拠）。
-- 本番はこの SQL でスケジューラを繋ぐ（＝二次証拠）。同じ tick を叩くので挙動は一致する。
--
-- 前提: pg_cron / pg_net 拡張（Supabase では利用可。ローカルは supabase_db に同梱）。
--       functions_url と service_role_key は環境ごとに設定する。
--
-- 使い方（例・ローカル）:
--   psql "$DB_URL" -v functions_url="http://host.docker.internal:54321" -v service_key="<SERVICE_ROLE_KEY>" \
--     -f supabase/scripts/setup_cron.sql

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 接続情報を DB パラメータに退避（cron ジョブ本体からは秘匿情報を直書きしない）
alter database postgres set app.functions_url    = :'functions_url';
alter database postgres set app.service_role_key = :'service_key';

-- 既存の同名ジョブがあれば消してから貼り直す（再実行に耐える）
select cron.unschedule(jobid)
from cron.job
where jobname = 'run-tournament-tick';

-- 毎日 21:00（企画書13.5 の例）に tick を1回叩く。tick は running な全大会を1ラウンド進める。
-- tick は冪等なので、万一多重起動しても pending → done は一度きり（二重処理しない）。
select cron.schedule(
  'run-tournament-tick',
  '0 21 * * *',
  $$
  select net.http_post(
    url     := current_setting('app.functions_url') || '/functions/v1/run-tournament',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body    := jsonb_build_object('action', 'tick')
  );
  $$
);

-- 確認:  select jobname, schedule, active from cron.job;
-- 解除:  select cron.unschedule('run-tournament-tick');
