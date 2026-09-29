# ADR-0035: /ask の時間予算 — タイムアウト 600 秒・interaction 失効時の DM 配送・進捗表示・探索予算

- ステータス: proposed
- 日付: 2026-09-30
- 関連: design.md §6.2(失敗時挙動・受け入れ条件)・§5.3(grep 方式の選定)・ADR-0030(常に応答する)・
  ADR-0032(タイムアウトのリトライ増幅)・ADR-0034(/ask ephemeral)

## 背景

`/ask` の agentic search(Agent SDK・Read/Grep/Glob・最大 30 ターン)は design.md §6.2 の
「上限 120 秒」で AbortController により打ち切っている。knowledge-base と minutes の成長に伴い
120 秒超が頻発し、利用者から「ナレッジ共有エージェントがタイムアウトする」と報告された
(2026-09 下旬)。

現状の時間構造は次のとおりで、遅さと失敗が別々の場所に隠れている:

| 区間 | 上限 | 問題 |
|---|---|---|
| `deferReply`(3 秒 ack) | 同期処理のみ先行 | 概ね安全 |
| 直列キュー待ち(`SerialQueue`) | 無制限 | 先行質問の合計時間をそのまま待つ |
| git sync(fetch/reset/clean) | **無し** | ネットワーク停滞で無限に待ちうる |
| agentic search | `ASK_TIMEOUT_MS`(120 秒) | KB 成長で頻繫に超える |
| 配送(editReply/followUp) | interaction token **15 分** | 失効後は回答を届けられない |

また defer 後は回答まで無言で、利用者は「動いているのか」を判別できない。SDK の result が返す
`num_turns` / `duration_api_ms` は捨てており、「何ターン使って遅いのか」を観測できない。

## 決定

- **D1: 検索タイムアウトの既定を 600 秒にする(env `ASK_TIMEOUT_MS` で調整)。**
  §6.2「上限 120 秒」を「上限 600 秒」へ改める。TIMEOUT は従来どおりリトライしない
  (ADR-0032 の教訓: 再送は待ち時間を倍にするだけ)。`createQaSearch` の 429/529 リトライは
  `runAgentSearch` がそれらのコードを投げないため実質無効であり、1 件の最悪所要時間は
  「git sync + 600 秒」と見積もる。
- **D2: 直列キューは維持し、interaction token(15 分)の失効後は本人への DM で配送する。**
  600 秒 × 直列では 2 件目以降が 15 分を超えうる。混雑時の拒否や並列化ではなく、
  (a) 配送時に `UnknownInteraction` で失敗したら同じチャンク列と 👍👎 を `user.send` で届ける、
  (b) 受付から `15 分 − 余裕` を超えてタスクが開始した場合は interaction を試みず最初から DM で配送する。
  DM は本人にしか見えないため ADR-0034(本人限定)を満たす。DM も失敗したら従来どおりログに残す
  (ADR-0030 D2 と同じ「無言にしない」方針)。
- **D3: interaction 操作の失敗を封じ込める。** `reply` / `deferReply` が `UnknownInteraction` /
  `InteractionHasAlreadyBeenAcknowledged` で失敗しても handler を落とさず warn ログで終える
  (unhandled rejection を出さない)。git 実行には 1 コマンド 60 秒のタイムアウトを付ける。
  エラーコードは discord.js の `RESTJSONErrorCodes` で参照し、数値を直書きしない。
- **D4: 所要時間の観測。** `runAgentSearch` の結果に `numTurns` / `durationApiMs` を載せ、
  `/ask` 完了時に `{ elapsedMs, numTurns, durationApiMs, status }` を info ログに出す。
  SQLite 列の追加は、後続判断(D6・並列化)に必要になった時点で行う。
- **D5: 進捗のライブ表示。** defer 後、5 秒間隔で「順番待ち(前に N 件)」「調べています…
  経過 N 秒 / 参照 N ファイル(上限 600 秒)」を `editReply` で更新する。Agent SDK のストリームから
  `tool_use` ブロックの**ツール名と回数のみ**を拾う(パス・内容は渡さず、漏洩面を増やさない)。
  最終回答の配送前に進捗更新を停止し、進行中の edit を待ってから配送する(古い tick が回答を
  上書きしない)。
- **D6: 探索量の削減はプロンプトの「探索予算」で行い、`maxTurns` の引き下げでは行わない。**
  `error_max_turns` は汎用エラー文面に落ちるため、上限を下げると timeout 文面(質問を絞る案内)より
  体験が悪化する。`maxTurns` / `effort` / `thinking` は env ノブ(既定は現状維持)として
  golden eval と VM の `queries.elapsed_ms` で比較してから既定を変える。
  KB エントリ一覧(path/title/tags)の前置きは、D4 のデータで「KB 探しに多ターン使っている」と
  分かった場合に追加する。前置きは毎 sync でクローンから派生させ永続化しない
  (§5.3「索引の同期負債なし」を維持。§1.3 のベクトル DB 等は導入しない)。

## 却下した代替案

- **git sync の TTL キャッシュ**: freshness の `syncKbClone` が clone 作業ツリーへ書き込むため、
  TTL 中の検索が `resolvedCommit` とズレて permalink を汚染する。fetch は数秒で timeout 窓の外。
- **キュー深さの上限で即拒否**: 15 分失効の構造的解決にはなるが、質問を捨てる体験になる。
  ユーザー決定(2026-09-30)で「無制限直列 + 失効後 DM」を採用。
- **並列度 2**: Agent SDK subprocess のメモリと、freshness と /ask の clone 競合(既存の
  `reset --hard` レース)に sync 排他が必要。データが出るまで保留(将来課題)。
- **タイムアウト時の自動リトライ**: ADR-0032 で否定済み。

## 影響・トレードオフ

- 1 件あたり最長 10 分待つことになる。D5 の進捗表示と D2 の DM 配送で「無言」「届かない」を防ぐ。
- 失効後の DM は ephemeral と異なり Discord 上に残る(本人の DM のみ)。
- `numTurns` ログにより、以後の調整(探索予算・カタログ・並列化)をデータで判断できる。
- 将来課題: freshness と /ask の clone 競合(sync ミューテックス)、並列度 2。

## design.md への転記(人間)

- §6.2 失敗時挙動(L446 付近): 「上限 120 秒」→「上限 600 秒(env `ASK_TIMEOUT_MS`)。
  interaction 失効後は本人 DM で配送(ADR-0035)」。
- §6.2 処理フロー step 1: 「考え中」表示は 5 秒間隔で進捗更新される旨を追記。
