# ADR-0042: /ask の Claude Code subprocess を事前起動(prewarm)して起動待ちを外す

- ステータス: proposed
- 日付: 2026-10-08
- 関連: ADR-0035(時間予算・直列キュー)・ADR-0037(読み取り封じ込め)・ADR-0038 D6(プロセス内ツール
  `discord_search`)・ADR-0039(役割 `qa`)・design.md §6.2 / §9.5・PR #181(/ask の内訳計測)

## 背景

- PR #181 の計測(実 API・bench:ask)で、/ask 1 件あたり `startupMs`(`query()` の開始 → 最初の SDK メッセージ =
  Claude Code subprocess の起動・設定読み込み・initialize)が **1.5〜2.0 秒**あった。全体は約 10〜13 秒。
- /ask は `SerialQueue` で 1 件ずつ処理し、`runAgentSearch` が毎回 `query()` で新しい subprocess を起動している。
- Agent SDK 0.3.285 には `prewarm()`(`@alpha`)がある。プロセスの起動・設定・認証・ツール・MCP の handshake・
  hook の登録までを先に済ませて待機させ(spare)、`claim()` で作業ディレクトリ等を渡して最初のメッセージを送る。
  待機中は約 230〜260 MB を保持する(sdk.d.ts の JSDoc)。

## 決定

### D1. 待機プロセスを最大 1 本だけ持ち、/ask の後に次の 1 本を用意する

- /ask の検索が終わったら(成否を問わず・呼び出し側の中断を除く)、同じ構成の spare をバックグラウンドで `prewarm()` する。
  次の /ask はそれを `claim()` して使う。準備中なら最大 5 秒だけ待ち、間に合わなければ従来の `query()` で起動する。
- 起動直後と、待機が長く続いて破棄した後の最初の 1 件は従来どおり(待機プロセスは遅延して作り直す)。
- spare は 1 回限り(1 つの /ask だけに使い、終われば閉じる)。`persistSession: false` は維持し、会話を
  質問者の間で持ち越さない。

### D2. spawn 時に固定される設定と、claim 時に渡す設定を分ける

`prewarm()` の時点で固定されるもの(SDK の仕様): `settingSources`・起動時の `env`・`systemPrompt`・`mcpServers`・
`hooks`・`allowedTools` / `disallowedTools`・`tools`・`permissionMode`・`outputFormat`・`maxTurns`・`effort` /
`thinking`・`model`・`abortController`。claim で渡すもの: `cwd`(作業ディレクトリ)と `appendSystemPrompt`。

- 固定される設定(モデル ID・静的な system prompt・出力スキーマ・ツール定義・探索ノブ・subprocess env)の指紋を
  spare に持たせ、claim 時に一致しなければ spare を捨てて従来の `query()` で起動する(設定の変更・env の差し替えに追従)。
  指紋はメモリ上の比較だけに使い、ログには出さない。
- モデルは従来どおり役割 `qa` を models.ts で解決し、spawn 時に渡す(claim では変えない。claim の `model` は
  受理されないと別モデルのまま走るため)。

### D3. 封じ込め(ADR-0037)は claim ごとの参照で判定する

- PreToolUse hook は spawn 時に固定されるため、判定ルートを「その spare を claim した /ask の realpath(cwd)」として
  claim 時に設定する参照から読む。claim 前・終了後(参照が空)はすべてのツール呼び出しを deny する(fail-closed)。
  hook は従来どおり deny しか返さない。
- `blockReadsOutsideWorkingDirectories`・`tools` = allowedTools・`settingSources: []`・`persistSession: false`・
  `buildAgentEnv` による env の絞り込み・`dontAsk`・`strictMcpConfig` は spawn 時の Options にそのまま載せる。

### D4. repo 対応表は claim 時の `appendSystemPrompt` で渡す

- spawn 時の system prompt は「qa/answer の静的な本文 + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`」。/ask ごとに変わる
  repo 対応表は claim の `appendSystemPrompt` で渡す。Claude Code は custom system prompt の配列の**後ろ**に
  append を連結する(CLI 0.3.285 の実装で確認)ため、並びは PR #181 と同じ「静的本文 → 境界 → 対応表」になり、
  静的本文(とツール定義)のプロンプトキャッシュはそのまま効く。
- 却下: 対応表を最初のユーザーメッセージの前置きにする案。キャッシュ上は同等だが、指示の強さが system prompt より
  弱くなり、回答品質の比較をやり直す必要がある。

### D5. `discord_search` は spare に固定の委譲ツールとして載せ、claim した /ask の範囲だけで動かす

- MCP サーバ(プロセス内ツール)は spawn 時に固定されるため、spare にはツールの定義(名前・説明・入力スキーマ)だけを
  載せ、実行は「claim した /ask が渡した `discord_search`(質問者の範囲に閉じたもの)」へ委譲する。
  claim が無い・その /ask がツールを渡していないときは、エラー結果を返して何も検索しない。
- 前の /ask のハンドラ(前の質問者の範囲)を spare から参照しない(定義だけを写す)。
- ツールの有無・定義が違う /ask は D2 の指紋が一致しないため、従来の `query()` で起動する。

### D6. 機能フラグ `ASK_PREWARM`(既定 `off`)・観測

- `ASK_PREWARM=on` のときだけ有効。待機の上限 `ASK_PREWARM_IDLE_MS`(既定 30 分)を超えたら spare を閉じる
  (認証・設定の陳腐化を避ける)。正常終了(SIGTERM)の `stopTimers` で閉じる。
- `prewarm()` の失敗・claim の拒否(`cwd_not_found` 等)・spare の終了は、警告を種類ごとに 1 回だけ出して
  従来の `query()` に倒す。`prewarm()` が 3 回続けて失敗したら、そのプロセスでは以後 prewarm しない。
- 完了ログ `/ask: 完了` に `prewarmed`(true / false)を載せる。`startupMs` は spare を使ったときは
  claim → 最初のメッセージ、従来経路では `query()` の開始 → 最初のメッセージ。

## 計測(実装後・2026-10-08・開発機の WSL2 で bench:ask・synthetic コーパス・各 3 問)

| 構成 | startupMs(従来経路) | startupMs(spare を claim) | 1 問の平均費用 |
|---|---|---|---|
| `BENCH_PREWARM=off` | 309〜371 ms | — | $0.017 |
| `BENCH_PREWARM=on`(1 問目は従来経路) | 331 ms | **44〜75 ms** | $0.017 |

- spare を使った問の `firstTurnCacheRead` は 7,556〜8,148 で、従来経路(7,547〜8,133)と同程度。
  対応表を `appendSystemPrompt` に移しても静的本文のプロンプトキャッシュは効いている(D4)。ただし最初の試行
  (指紋の修正前)では spare を使った 1 問が `firstTurnCacheRead` 0(費用 $0.039)だった。原因は特定できていないため、
  有効化後は完了ログの `firstTurnCacheRead` を `prewarmed` 別に見る。
- 開発機では従来経路の起動自体が 0.3〜0.9 秒で、本番(1.5〜2.0 秒)より小さい。本番での削減幅は有効化して
  完了ログ(`prewarmed` / `startupMs`)で確かめる。`prewarm()` 自体は約 250 ms で終わる(/ask の合間に収まる)。
- 実 API で、spare を claim した検索が cwd 外のファイル(兄弟ディレクトリ)の Read を deny し(`deniedToolCalls` 1)、
  claim した cwd 基準の相対パスは読めることを確かめた。
- 実装上の注意: SDK は `query()` / `prewarm()` のたびに `process.env.CLAUDE_AGENT_SDK_VERSION` を書くため、
  D2 の指紋からはこの変数を除く(除かないと最初の spare が必ず不一致で捨てられる)。

## 影響・トレードオフ

- **メモリ**: 待機中は常時 1 本(約 230〜260 MB)多く持つ。/ask の実行中は実行中の 1 本 + 準備中の 1 本になりうる。
  bot コンテナのメモリ上限に余裕があることを有効化の前に確かめる。
- **陳腐化**: spawn 時の設定・env・認証を最長 `ASK_PREWARM_IDLE_MS` まで持ち越す。設定の差し替えは指紋で検出するが、
  CLI の外で変わるもの(組織のモデル制限等)は次の作り直しまで反映されない。
- **alpha API**: `prewarm()` / `SpareProcess` は `@alpha` で、SDK の更新で形や挙動が変わりうる。SDK を上げるときは
  本機能の単体テストと bench:ask(`BENCH_PREWARM=on`)で確認する。失敗は従来経路に倒れるため、/ask 自体は止まらない。
- 間隔の空いた利用(30 分超)では毎回従来経路になり、効果は出ない(直列で続けて質問される時間帯に効く)。

## 却下した代替案

- **キューの並列度を 2 にする**: 起動時間は減らず、待ち時間の偏りを散らすだけ。メモリと API の同時実行が倍になり、
  同期・鮮度確認の書き込みとの直列化(ADR-0036 3b-1)も崩れる。
- **セッションを質問者をまたいで使い回す(`persistSession` / resume / 長寿命の streaming 入力)**: 前の質問・
  検索で読んだ本文・`discord_search` の結果が次の質問者の文脈に残る。`persistSession: false` と 1 回限りの spare を維持する。
- **`startup()`(WarmQuery)**: 作業ディレクトリと全 Options を先に決める必要があり、`discord_search` のハンドラや
  対応表も spawn 時に固定されるため、質問者ごとの範囲を安全に渡せない。

## ロールバック

- `ASK_PREWARM=off`(既定)または未設定にして再起動する。従来の `query()` 経路だけになる(コードの差分は不要)。

## design.md への転記(人間)

- 有効化を決めた時点で、§6.2(/ask の処理フロー)に「Claude Code subprocess は事前起動した 1 本を claim して使う
  (`ASK_PREWARM`・失敗時は従来の起動)」、§9.5 に「事前起動した spare の封じ込め hook・プロセス内ツールは claim した
  /ask の参照だけを読み、claim の外では deny」を追記する。既定 off の間は転記しない。
