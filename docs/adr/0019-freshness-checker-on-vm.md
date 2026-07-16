# ADR-0019: freshness-checker は VM systemd timer + bot リアクション UI の分担で実行する

- **ステータス**: accepted(2026-07-16。#52〜#55 マージ済み・§3.2 C8 転記・本 PR のレビューをもって採択)
- **日付**: 2026-07-15
- **関連**: design.md §6.7(C8 要件・AC)・§4.2(last_verified / review_interval_days)・§4.6
  (pending_actions)・§13(確認疲れ防止)/
  ADR-0014(実行基盤の判断基準: bot ローカル状態に触るバッチ = VM)・ADR-0016 D4(実行形態 3 系統)・
  ADR-0017 D3(owner→Discord の写像 = KB `_meta/members.yaml`)・F1(#46: /ask の stale 注記は実装済み)
- **備考**: 採択(`accepted`)および design.md への転記(§3.2 C8 行の実行基盤確定)は人間レビューで行う。

## 背景

§6.7 は C8 を「日次 cron(平日 11:00 JST)。`last_verified + review_interval_days` を過ぎた active を
owner にワンタップ確認(1 人 1 日 2 件)、14 日無反応で自動 stale。stale は /ask で注記付き引用」と定める。
§3.2 の表は C8 を「GitHub Actions cron」とするが、確認依頼の状態(送信済み・応答待ち)は
**bot.db の pending_actions**(§4.6)に載る必要があり、Actions からは touch できない —
gap-tracker(ADR-0014)とまったく同じ構図。/ask 側の注記(AC の半分)は F1(#46)で実装済み。

## 決定

### D1. checker(判定・依頼投入・自動 stale)は VM の systemd user timer

- gap-tracker と同型の oneshot(ADR-0016 D4 の「bot ローカル状態に触るバッチ = VM・ホスト node」)。
  `stratum-freshness.{service,timer}`(gap-tracker unit のテンプレ流用)、**OnCalendar = 平日 11:00 JST**(§6.7)。
- 処理: KB clone 同期 → `active` かつ `last_verified + review_interval_days < today` を列挙
  (kb-core `safeParseEntry`。decision は `review_interval_days: null` で対象外)→ owner 別に
  **1 日 2 件**まで選定(`BotStore.hitRateLimit` の日次バケット・capture/voice と同じ写像)→
  `pending_actions(type:"freshness", state:"pending")` に投入 → bot が DM を送る(D2)。
- **14 日無反応の自動 stale** も checker が担う: pending の `createdAt` から 14 日超の freshness
  アクションを対象に `status: stale` へ一括降格 commit + `markActionDone` + ops 通知。

### D2. 確認 UI は bot からの DM + 👍✏️🗑 リアクション

- bot(常駐)が pending(state:"pending")を消費して owner へ **DM** を送る:
  エントリタイトル + 要約 + 「まだ正しい? 👍 正しい / ✏️ 直す / 🗑 もう古い」。送信後 state:"sent" 相当へ
  前進(pending_actions の payload で管理)。
- 応答は **DM のリアクション**を ReactionAdd で捕捉(ボタンでなくリアクション — 💡 capture・👍 代理マージと
  同じ既存流儀。ワンタップ・P3)。
  - **👍** → 当該エントリの `last_verified` を今日に更新して main 直 commit
  - **✏️** → 編集用 PR の雛形(`createPullRequest`: 本文に現エントリ全文)を作り、リンクを DM
  - **🗑** → `status: stale` に更新して main 直 commit + 矛盾検出キュー(pending_actions)へ積む
- **owner → Discord ID は KB `_meta/members.yaml`**(ADR-0017 D3・kb-core `discordForGithub` +
  M2 の都度読みローダ)。未登載 owner の確認依頼は **warn + スキップ**(依頼できないだけで壊さない。
  レートも消費しない)。

### D3. commit 経路は commitFiles で main 直(gap-tracker ADR-0014 D4 と同型)

`last_verified` 更新・stale 降格は「人間の意思表示(👍/🗑)の記録」または「無反応の機械的降格」であり、
PR レビューを挟む価値がない(P3: 承認疲れを作らない)。`serializeEntry` で round-trip し、
**push 前にローカル validateRepo**(ADR-0004 D2 の構造ガード)。✏️ だけは内容編集なので PR 経由。

### D4. 冪等・レート・安全弁

- 同一エントリの freshness pending が既に生きている間は再投入しない(pending_actions の走査)。
- 1 人 1 日 2 件(§6.7・確認疲れ防止)は `hitRateLimit("user:<discord>", "freshness", <JST日付>, 2)`。
- 実 commit・実 DM は `FRESHNESS_REAL` 相当の opt-in(既定 dry-run。gap-tracker の GAP_TRACKER_REAL と同じ)。
- decision(review_interval null)・既 stale・superseded は対象外。

## 影響・トレードオフ

- **利点**: gap-tracker で確立した部品(unit テンプレ・bot.db 共有・commitFiles・リアクション UI)の
  再利用で新規面が小さい。AC「stale 降格 → /ask 注記」の後半は F1 実装済みで、E2E 接続の確認だけが残る。
- バッチの実行形態は引き続き 3 系統(ADR-0016 D4)の枠内。VM 依存がまた 1 つ増える(§7.4 の運用でカバー)。
- DM ベースのため、DM を閉じているメンバーには届かない(送信失敗は warn + pending 温存 → 14 日で
  自動 stale に倒れる = 安全側)。

## 却下した代替案

- **GitHub Actions cron**(§3.2 の当初案)→ pending_actions(bot.db)に触れない。ADR-0014 と同じ理由で却下。
- **bot 内蔵の常駐タイマ** → oneshot バッチの分担(ADR-0014/0016)を崩す。テスト・再実行も難しい。却下。
- **ボタン UI(Discord components)** → 既存の確認系はすべてリアクション流儀。ボタンは interaction
  ハンドラの新設面が増える割にワンタップ性は同じ。却下。
- **確認なしで期限切れを即 stale** → owner の「まだ正しい」を拾えず、鮮度が実態より悪く見える。
  §6.7 のワンタップ確認が仕様。却下。

## 検証

- ユニット: 期限判定(type 別 interval・decision 除外)・owner 選定(日 2 件・members 未登載スキップ)・
  14 日降格・リアクション 3 分岐(fake store/gh/messenger)。
- 実機(VM): timer 手動 1 回(dry-run → real)→ fixture エントリを 🗑 で stale 化 → **/ask で
  「※最終確認から時間が経っています」注記が付く**(§6.7 AC の E2E・F5 の runbook 手順)。
