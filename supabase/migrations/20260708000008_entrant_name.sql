-- M6.3: 観戦 UI 用に出場者の表示名を entrants に snapshot（企画書5章 / 実装プラン M6.3）。
--
-- なぜ必要か: characters.name は RLS で本人しか select できない（M3「他人のキャラは見えない」）。
-- 一方 tournament_entrants は全員参照（非同期観戦）。観戦者が対戦相手の名前を順位表/カードに
-- 出せるよう、エントリー時点の name を公開テーブル側へ複製する（ビルド snapshot と同じ発想・
-- シーズン途中の改名が過去の大会を遡らない）。run-tournament(open) が populate する。

alter table public.tournament_entrants
  add column name text; -- エントリー時点の表示名（null=旧データ／UI は id 先頭で代替）
