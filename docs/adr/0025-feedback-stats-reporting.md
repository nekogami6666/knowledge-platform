# ADR-0025: Q&A 利用状況・👍👎 有用率の集計を /stats + 週次 VM timer レポートで実装する

- **ステータス**: proposed(2026-07-24 起票。design.md §1.4/§7.3 転記 + 採択は人間)
- **日付**: 2026-07-24
- **関連**: design.md §1.4(成功指標 KPI)・§7.3(週次サマリを #stratum-ops へ)・§4.6(queries)・§10(評価戦略) /
  [ADR-0016](0016-execution-forms.md) D4(実行形態)/ [ADR-0014](0014-gap-tracker-on-vm.md)(bot.db を読むバッチ = VM timer)

## 背景

design.md §1.4 の KPI「**Q&A Bot 利用数**(クエリログ・週 15 件以上)」「**回答有用率** = 👍/(👍+👎)・70% 以上」は
**目標値だけが定義され、算出する担当コンポーネントがどこにも割り当てられていない**。§10(評価戦略)は golden-qa の
出典一致率・回答妥当性のみを扱い、フィードバック率・利用状況の集計には触れない。👍👎 は `queries.feedback`(§4.6)に
記録済みだが**集計する仕組みが無く、確認は手動 SQL のみ**。

一方 §7.3 に「(バッチのコスト)週次サマリを #stratum-ops へ」という**週次 ops レポートの運用前例が明文化**されている。
本 ADR はこの KPI 計測の空白を、既存イディオムの踏襲で埋める。

## 決定

### D1. 集計ロジックは discord-bot 内の純関数に一元化し、入口を2つ持つ

`apps/discord-bot/src/stats.ts` に `aggregateStats` / `formatStatsMessage`(純関数)を置き、2つの薄い入口から使う:
- **bot 内 `/stats`**(SlashCommand・ephemeral・リアルタイム): 叩いた本人だけに直近7日+累計を表示。
- **週次 VM timer バッチ**(`stats-cli.ts` → #stratum-ops): 定期投稿。

ロジックを共有し二重実装しない。メトリクスは §1.4 の 2 指標に加え、利用状況(/ask 件数・回答率・平均応答時間・
error/delivery_failed の分離)を含む(全て `queries` テーブルにあるデータ)。

### D2. 週次レポートは VM systemd user timer(月 09:00 JST)

bot.db を **read-only 集計**する。bot.db に触るバッチは **GitHub Actions 不可・VM systemd timer 必須**
(§4.6 の「Actions はステートレスで SQLite を持たない」制約・ADR-0016 D4)。gap-tracker(平日10:00)/
freshness(平日11:00)と同じ VM timer の例外に属し、時間帯をずらして週初の月 09:00 に前週分を報告する。

### D3. bot 本体に webhook 配線を足さない(#stratum-ops POST は CLI 側だけ)

bot の外向き I/O は Discord Gateway 限定という現状を維持する。#stratum-ops への投稿は `stats-cli.ts` が
`fetch` で行い(gap-tracker `index.ts` の `postWebhook` インライン helper と同形)、bot プロセスには
`DISCORD_OPS_WEBHOOK` の env も fetch も追加しない。→ 常駐 bot の責務・攻撃面を増やさない。リアルタイムの
`/stats` は Gateway の interaction 応答で完結するため webhook を要しない。

### D4. /stats は ephemeral・ゲート無し

集計値(件数・率)は機微でなく LLM 非使用の read-only なので、`/ask` のようなチャンネル allowlist・rate-limit・
管理者ゲートは掛けない。応答は ephemeral(本人のみ・チャンネルを汚さない)。org 内部の利用状況は誰が見ても害がない。

### D5. KPI 目標は定数・未達に ⚠️

`WEEKLY_ASKS_TARGET = 15` / `USEFUL_RATE_TARGET = 0.7` を `stats.ts` の定数で持ち、未達に ⚠️ を付ける
(§1.4 が唯一の出典)。これはチャンネルID・リポ名・モデルID のハードコード禁止対象ではない(KPI 閾値は設計値)。

## 影響・トレードオフ

- **利点**: §1.4 KPI の計測空白が埋まる。SlashCommand 追加・gap-tracker 型 timer バッチという既存イディオムの
  踏襲で新規面が小さい。webhook 通知が CLI に閉じ、bot は無改変の Gateway 限定を保つ。
- 新 systemd unit 1 つ(`stratum-stats`)。`install-timers.sh` に read-only(REAL ゲート無し)分岐を追加。
- **コスト換算(円)は含めない**(§7.3 の単価確認待ち。`queries` にトークン列はあるが単価が未定)。
- **dry-run 相当**: `DISCORD_OPS_WEBHOOK` 未設定なら投稿せずログのみ(初回検証で安全)。

## 却下した代替案

- **bot 内 `setInterval` で週次投稿**: bot に webhook 配線(env + fetch)を新設する必要があり Gateway 限定を崩す
  (D3 に反する)。定期投稿は CLI に分離し、bot にはリアルタイムの `/stats` だけを置く。
- **GitHub Actions で集計**: bot.db が VM にあり Actions から読めない(§4.6)。却下。
- **独立アプリ `apps/stats` 新設**: 1 レポートに 1 app は過剰。集計ロジックも消費データ(queries)も discord-bot に
  あるため、同 app 内 CLI(`stats-cli.js`)で足りる。
- **`listQueries` に `since` を足してウィンドウだけ取得**: 累計(total)集計に全行が必要なので since フィルタは
  本機能では無益。年数百行規模なので全行メモリ集計で十分。store API を増やさない。

## 検証

- ユニット([stats.test.ts](../../apps/discord-bot/src/stats.test.ts)・memory store): 7日境界(+09:00 文字列比較)/
  評価ゼロ → usefulRate null / KPI 未達で ⚠️ / error・delivery_failed の分離 / format 主要行 /
  `runStatsReport`(fake post で投稿内容)。[discord.test.ts](../../apps/discord-bot/src/discord.test.ts) に
  `statsCommand` の name と `handleStats`(ephemeral・fake store)。
- E2E: VM で `systemctl --user start stratum-stats.service` → #stratum-ops に 📊 レポート投稿。
  `/stats` を Discord で叩き ephemeral 表示。`DISCORD_OPS_WEBHOOK` 未設定時はログのみ(投稿されない)を確認。
