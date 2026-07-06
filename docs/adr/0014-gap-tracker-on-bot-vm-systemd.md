# ADR-0014: gap-tracker を bot と同じ社内 VM の systemd timer で実行する

- **ステータス**: proposed
- **日付**: 2026-07-06
- **関連**: design.md §3.2(C5 は「GitHub Actions cron」)・§4.6(bot ローカル SQLite)・§6.5(gap-tracker)・
  §6.2 L441(bot は questions を queue するだけで git に書かない)/ ADR-0010(社内 VM 常駐・systemd user)・
  ADR-0013(extractor は Actions エフェメラル runner)
- **備考**: 採択(`accepted`)および design.md §3.2 への転記は人間レビューで行う。

## 背景

design.md §3.2 は gap-tracker(C5)を「GitHub Actions cron(日次)」と定めるが、§6.5 step1 は
「discord-bot の **SQLite から**未処理の NOT_FOUND / 👎 クエリを取得」する。この2つは両立しない:

- bot の SQLite(`/data/bot.db`)は **社内 VM のローカルディスク**にある(ADR-0010 で常駐先が
  Fly.io 想定から社内 VM に変わった)。
- GitHub Actions のランナーは VM とファイルシステムを共有せず、**SQLite に到達できない**。

設計時の暗黙前提(バッチがキューに届く)が、ホスティング決定(ADR-0010)で崩れた。
CLAUDE.md の規約に従い人間確認を行い、**「bot と同じ VM で実行」をユーザが選択**した(2026-07-06)。

## 決定

### D1. gap-tracker は bot と同じ VM 上の systemd user timer で実行する

- スケジュール: **平日 10:00 JST**(§6.5 L496「依頼が深夜に飛ばないように」)。
- デプロイは ADR-0010 の deploy kit の流儀(unit + timer を `docs/deploy/` に追加)。
- bot.db へは**同一ホストの別プロセス**としてアクセスする。WAL + busy_timeout(5s)は設定済みで、
  gap-tracker のトランザクションは短い(SELECT + 処理後の UPDATE)ため競合は実用上問題にならない。

### D2. SQLite アクセスは `@stratum/discord-bot/store` subpath export 経由

スキーマとマイグレーションの正は discord-bot に置いたまま、`./store`(BotStore 型 + createMemoryStore)と
`./sqlite-store`(better-sqlite3 実装。native 依存を分離)を export し、gap-tracker はそれを import する
(evals → `@stratum/discord-bot/qa` の前例)。**SQL を gap-tracker に複製しない**。

### D3. 消費の恒等性は `BotStore.markActionDone(id)` で担保

pending_actions に state を前進させる手段が無かった(毎日同じ質問を再 commit してしまう)。
`markActionDone` を BotStore に追加し、gap-tracker は「questions/open へ commit 成功後」に done へ進める。

### D4. GitHub への書き込みは gh-client のまま(VM 上でも認証・経路は不変)

質問ログの commit は `commitFiles`(main へ直接・push 前にローカル validateRepo)、回答のナレッジ化は
従来どおり PR + 👍 代理マージ。VM 実行になっても ADR-0011(auth-agnostic)/ ADR-0013 の秘密の扱い
(トークンを clone の .git/config に残さない等)はそのまま適用する。

## 影響・トレードオフ

- **利点**: ブリッジ(HTTP エクスポートやファイル同期)を新設せず、追加の攻撃面ゼロ・実装最小で
  §6.5 step1 を成立させる。VM は既に bot が動いており運用単位が増えない。
- **design §3.2 からの逸脱**: C5 の実行基盤が「Actions」→「VM systemd」になる(転記は人間)。
  extractor(C2)は Actions のまま(ADR-0013)で、**バッチの実行基盤が2系統**になる。判断基準は
  「bot のローカル状態に触るバッチは VM、リポジトリだけで完結するバッチは Actions」。
- VM 障害時は gap-tracker も止まる(bot と運命共同体)。§7.4 の障害通知でカバー。

## 却下した代替案

- **Actions 維持 + bot がキューを HTTP でエクスポート** → 常駐 bot に認証付き API を生やす=攻撃面・
  実装コスト増。却下。
- **bot が直接 questions/open へ commit** → §6.2 L441「Bot から Git への書き込み経路を最小化」に反する。却下。
- **キューを SQLite でなくリポジトリ内ファイルにする** → bot に git 書き込みが要る(同上)+ 競合管理が複雑。却下。

## 検証

- ユニット: markActionDone(memory/sqlite)・commitFiles(updateRef)・gap-tracker 本体は fake で。
- 実機: VM 上で timer を1回手動起動(`systemctl --user start stratum-gap-tracker.service`)し、
  bot.db 読み取り → questions/open commit → 依頼投稿の1サイクルを確認(PR-D1 以降)。
