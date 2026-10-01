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

## 追記(2026-10-01・全体期限・正常終了・強制終了の後始末)

背景: デプロイで処理中の質問が消え「調べています…」が残る(終了処理が無い)。また、期限切れの質問でも
最後まで検索していた(D2 は「失効後は DM で配送」だが、14 分以上待った質問への回答が DM で後から届いても
質問者は既に離れていることが多く、後続の質問の待ち時間だけが伸びる)。2026-10-01 のユーザー決定に従い
次を追加・変更する(計画 1-4)。

- **D2'(D2 を改める): 受付からの全体期限。** 期限 = 受付(deferReply 直後)+ interaction token 15 分 −
  余裕 1 分(既存の `INTERACTION_TOKEN_MS` / `INTERACTION_DEADLINE_MARGIN_MS`。判定は既存の
  `interactionLikelyExpired` をそのまま使う)。
  - 直列キューで順番が来た時点で期限を過ぎていたら**検索を始めない**。「混雑のため時間内に回答できません
    でした。お手数ですがもう一度質問してください。」を本人に通知し、`queries.answer_status =
    'timeout_skipped'` で記録し、warn ログ(待ち時間)を出す。question_queue には積まない。
  - 通知先: token がまだ使える(受付から 15 分未満)なら ephemeral の進捗表示を書き換え、失敗したら DM。
    15 分以上なら最初から DM(D2 の DM 経路。本人にしか見えない)。
  - D2 (b) の「開始時点で期限切れなら DM で配送」は、開始時点では上記のスキップに置き換わり、
    **配送時点**の判定として残す(期限内に始まった検索が長引いた場合は interaction を試みず DM で配送)。
  - 基準の選択: 「残り時間 < `ASK_TIMEOUT_MS`(600 秒)なら開始しない」も検討したが、既定値では受付から
    4 分待っただけで捨てることになる。本番の所要時間は中央値 57 秒・p90 124 秒で、4〜14 分待った質問の
    多くは期限内に回答できる。期限内に始まった検索が長引いた場合は D2 の DM 配送で救えるため、
    「期限を過ぎてからは始めない」を採用する(捨てるのは確実に間に合わない質問だけ)。
- **D3 の補足:** 失効エラーの判定に `InvalidWebhookToken`(15 分を過ぎた interaction webhook の編集で返る)を
  加える。
- **D7: 正常終了(SIGTERM / SIGINT)。**
  1. 新規 /ask の受付を止め、「再起動中です。少し待ってからもう一度お試しください。」を ephemeral で返す
     (検索・記録・レート制限の消費をしない)。
  2. 処理中(順番待ちを含む)の /ask を最大 `SHUTDOWN_GRACE_MS`(env・既定 60 秒)待つ。
  3. 超えたら中断する。検索中のものは `AbortSignal` を `handleAskRequest` → `createQaSearch` →
     `runAgentSearch` へ通して打ち切る(`runAgentSearch` 内部の AbortController はタイムアウトと呼び出し側の
     中断の両方で abort し、呼び出し側の中断は `LlmError("ABORTED")` として TIMEOUT と区別する。ABORTED は
     再試行しない)。git sync は中断できない(1 コマンド 60 秒の上限つき)ため、同期後に判定して検索に入らない。
     順番待ちのものはキューの順番を待たずにその場で中断処理をする(後で順番が来たタスクは何もしない)。
     いずれも進捗表示を「再起動のため中断しました。お手数ですがもう一度質問してください。」に書き換え、
     `answer_status = 'interrupted'` で記録する。進捗表示の定期更新は中断で止め、タイマを残さない。
  4. 中断後の後処理を最大 15 秒待ち、Discord クライアントを切断し、bot.db を閉じて exit 0。
  - compose の `stop_grace_period: 90s`(既定 10 秒では待たずに SIGKILL される)。60 + 15 < 90。
  - `docs/deploy/update.sh` は bot の再作成の前に、処理中(受付から 15 分以内)の /ask の件数を表示し、
    0 件でなければ警告する(止めない)。件数はホストの node + better-sqlite3 で bot.db を読み取り専用で数える。
  - 範囲外: 同じ直列キューに載る鮮度確認の KB 書き込みや voice/interview の worker は待たない(従来どおり)。
- **D8: 強制終了(SIGKILL / OOM)からの後始末。**
  - bot.db に `inflight_asks`(id・application_id・interaction token・受付時刻・相関 ID)を置き、
    受付時に入れ、完了(成功・失敗・中断)時に即削除する。質問本文は持たない。
  - 起動時(新規受付より前)に残っている行を読み、ClientReady で受付から 15 分未満のものだけ
    `PATCH /webhooks/{application_id}/{token}/messages/@original`(bot 認証なし)で元の ephemeral 応答を
    「再起動のため中断しました…」に書き換え、読んだ行を id 単位で削除する(15 分以上のものは消すだけ)。
    強制終了で消えた質問は `queries` に行が無いため、`interrupted` の記録はしない(本文を保存しないため)。
  - 正常終了で中断後の後処理が 15 秒を超えた分も行が残り、次回起動時に同じく書き換える。
  - **token の扱い(セキュリティ上のトレードオフ):** interaction token は「その interaction の応答
    (本人だけに見える ephemeral)を 15 分間だけ編集・追記できる」権限で、bot トークンやチャンネルへの
    投稿権限ではない。bot.db は既に質問本文・回答を持ち、ホストユーザ所有(chmod・bind mount)で
    bot とホスト側バッチだけが読む。漏れた場合の最悪は「15 分以内の本人向け表示の改ざん」に限られる。
    これに対し、記録しなければ強制終了のたびに「調べています…」が残り続ける。よって保存するが、
    (1) 完了時に即削除、(2) 起動時に全削除、(3) ログ・例外文言に出さない(DiscordAPIError の url に
    token が入るため、後始末の警告は name/code/status だけを出す)、(4) update.sh の件数表示は token 列を
    読まない、を守る。
  - **スキーマ:** `inflight_asks` は `CREATE TABLE IF NOT EXISTS` を開くたびに実行する追加のみ・冪等の表で、
    `user_version` を消費しない。行は最長 15 分の揮発データで列の移行が要らないため。bot.db はホスト側
    バッチ(gap-tracker / freshness / stats / recordings-cleanup)も同じ `createSqliteStore` で開くが、
    古いコードは表を知らずに素通りし、新しいコードは同じ表を作るだけで衝突しない。並行する 3b-2
    (ADR-0036 D4)が SCHEMA_VERSION 2 で `managed_clones` を足す予定のため、版番号を取らずに独立させた
    (どちらが先にマージされても番号の付け直しが要らない)。将来 migrate の版に畳む場合も文は冪等なので
    任意の段へそのまま移せる。
- **`answer_status` の追加値:** `timeout_skipped` / `interrupted`。/stats の週次レポートは errors と別に
  「混雑で未検索 N」「再起動で中断 N」を非ゼロのときだけ表示する。gap-tracker は question_queue だけを
  読むため影響しない。

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
- (追記分)§6.2 失敗時挙動: 「直列キュー待ちで interaction token(15 分)が失効した場合は本人 DM で配送」→
  「受付から 14 分を過ぎて順番が来た質問は検索せず、再質問を案内して `timeout_skipped` で記録(ADR-0035 D2')。
  検索が長引き配送時点で期限を過ぎた回答は本人 DM で配送」。再起動時は処理中の質問を最大 60 秒待ってから
  中断し `interrupted` で記録する旨(D7)と、強制終了後の起動時の書き換え(D8)を追記。
- (追記分)§4.6 queries の answer_status に `timeout_skipped` / `interrupted`、bot.db に `inflight_asks` を追記。

## 追記(2026-10-01): 工程別の計測(段階 1-1)

本番 61 件の所要時間は中央値 57 秒・p90 124 秒だが、D4 のログ(`elapsedMs` / `numTurns` /
`durationApiMs`)だけでは「待ち・同期・検索・配送のどこで時間を使ったか」が分からない。
また SDK の result にあるキャッシュトークンと推定費用を捨てていた。

- **D4 を改める: /ask 1 件につき 1 行の完了ログを出す。** msg は `/ask: 完了` で固定し、
  相関 ID(`correlationId`)を付ける。配送まで含めるため `discord.ts`(handleAsk)が配送後に出し、
  `ask.ts` は工程別の値を `AskResult.metrics` で返すだけにする(旧 `/ask: 検索完了` は廃止・二重に出さない)。
  - 工程: `queueWaitMs`(受付 → キューのタスク開始)/ `syncMs` / `promptMs`(プロンプト + manifest)/
    `searchMs`(再試行を含む)/ `validateMs`(引用の検証・整形・queries 記録)/ `deliveryMs` / `totalMs`。
    `elapsedMs` は従来どおり `queries.elapsed_ms` と同じ値。
  - 検索の観測値: `numTurns` / `durationApiMs` / `deniedToolCalls` / `notFound` / `citations` /
    `validCitations` / `inputTokens` / `outputTokens` / `cacheCreationInputTokens` / `cacheReadInputTokens` /
    `totalCostUsd` / `modelUsage`(モデル別の入出力・キャッシュトークンと費用)/ `requestedModel` / `actualModel`。
    `inputTokens`(SDK の `input_tokens`)はキャッシュ分を含まない点に注意する。
  - 失敗時: `failedStage`(`queue` / `sync` / `prompt` / `search` / `validate` / `delivery`)・
    `failedAtMs`(受付から失敗まで)・`errorKind` / `errorCode`(LlmError の code、git の失敗は
    `GIT_DNS` / `GIT_TIMEOUT` / `GIT_NETWORK` / `GIT_AUTH` / `GIT_NOT_FOUND` / `GIT_ERROR`、errno 系はその code)。
  - 項目の一覧は `apps/discord-bot/src/ask-metrics.ts` の冒頭が正。
- **ログに出さないもの**: 質問・回答・社内文書の本文、エラーの message(git の stderr は URL を含みうる)、秘密値。
  エラーの詳細は従来どおり `/ask pipeline error` の error ログ(秘密値の伏字化あり)に出る。
- **DB には保存しない(ログのみ)**。`queries` への列追加は bot.db のスキーマ上げを伴い、ホストのバッチと
  共有するため、他の変更とまとめて 1 回で行う。それまでは完了ログを集計に使う。
