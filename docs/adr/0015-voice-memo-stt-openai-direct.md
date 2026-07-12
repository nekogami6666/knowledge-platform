# ADR-0015: voice-memo の文字起こしは OpenAI transcription API を直接呼び、記事化は capture 流とする

- **ステータス**: accepted(2026-07-12。design.md 転記 PR のレビューをもって採択)
- **日付**: 2026-07-08
- **関連**: design.md §6.4 ③-b(L481-485)・§14#1(本 ADR で解消)・§9.4(外部送信先)・§5.2・§2 P1/P3/P7 /
  ADR-0009(AI 経路は Claude on AWS に統一 — 本 ADR はその音声限定の例外)・ADR-0010(VM 常駐・外向き通信)・
  ADR-0014(実行基盤の判断基準、bot 直 commit の却下経緯)
- **備考**: design.md への転記(§14#1 決定済み化・§6.4 L484 の経路改訂・§9.4 の外部送信先確定・
  §8.3 プロンプト表・§3.2 C4)は 2026-07-12 の転記 PR で実施。同日、重複ドラフト
  `0015-stt-openai-transcription-exception`(未コミット・2026-07-10 起案)の固有内容
  — D1 の例外射程の限定(音声の文字起こし全般)・L483 の第一選択への格上げ・§9.4 allowlist 明示・
  diarize 切替候補 — を D1/D2/D3 に統合し破棄した。これらは**ユーザ裁定 2026-07-10
  「ADR-0009 は音声認識のみ OpenAI を例外とする」**を文書化したもの(ドラフト原文は転記 PR の本文に添付)。

## 背景

§6.4 ③-b は「文字起こしは**既存の議事録パイプラインと同一エンジンを流用**する(再利用 I/F がない場合の
フォールバックとして OpenAI Whisper API を許容)」と定め、§14#1 でその再利用 I/F の確認が未決だった。
調査(2026-07-07)の結果:

- 既存パイプラインの実体は **QB-Meeting-Ops**(queeenb-com、Python・別 VM の systemd 常駐)。
  extractor が clone する `dev-minutes` の書き込み元であることをコミット書式・publish.json で確認した。
- 文字起こしエンジンは **OpenAI transcription API**(providers.py の `audio.transcriptions.create`、
  運用モデル `gpt-4o-transcribe-diarize`、日本語設定)。
- 音声 → transcript を 1 コマンドで返す CLI(`import-discord-attachment-recording`)は実在するが、
  QB 側のホスト環境一式(SQLite・storage root・ffmpeg・API キー)を前提とし、出力は会議議事録
  固定(会議データモデル・議事録プロンプト)。③-b の要件(`interviews/voice-memos/` への原本保存・
  投稿者へのスレッド返信・返信での訂正反映)を満たせない。intake チャンネル相乗りも同様。
- また design.md 内で ③-b の記事化経路が二義的だった(§6.4 L484「extractor と同じ抽出フロー」と
  §8.3 L594「`capture/draft.md` がスレッド/**音声メモ** → エントリ草案」)。CLAUDE.md の規約に従い
  人間確認を行い、**capture 流をユーザが選択**した(2026-07-07)。

## 決定

### D1. エンジン共有・プロセス非共有(§14#1 の回答)。例外の射程は STT のみ

QB-Meeting-Ops と**同一のエンジン = OpenAI transcription API** を、knowledge-platform が自前クライアント
で直接呼ぶ。QB の CLI・ホスト・SQLite には依存せず、QB 側への改修依頼も行わない(別チーム・別リリース
サイクルの Python システムであり、結合は双方の変更自由度を損なう)。

- **ADR-0009(全 AI を Claude on AWS に統一)からの例外は STT(音声→テキスト変換)に限定**する
  (ユーザ裁定 2026-07-10「ADR-0009 は音声認識のみ OpenAI を例外とする」)。
  テキスト生成(要約・抽出・Q&A・judge)は従来どおり Claude on AWS のみ(Claude on AWS / Anthropic は
  STT を提供しないため、ADR-0009 の統一の射程外)。
- L483 の「フォールバックとして OpenAI Whisper API を許容」は、フォールバックではなく**第一選択に格上げ**
  する(文言上の「Whisper API」は同じ OpenAI transcription API 系列の現行モデルと読み替え、design 転記で更新済み)。
- §6.4 のインタビュー録音(L523「録音は既存基盤」)を将来 knowledge-platform 側で文字起こしする場合も、
  同じ STT モジュールを使う(例外の適用先は voice-memo に限らず「音声の文字起こし」全般)。

### D2. STT クライアントは packages/llm 内の独立モジュール(ModelRole に stt は追加しない)

- 配置: `packages/llm/src/stt.ts`。`Transcriber` インターフェース + OpenAI 実装(fetch multipart)。
  `withRetry` を共用。OpenAI への依存は packages/llm 内のみ許可(`@anthropic-ai/sdk` と同じ封じ込め)。
- **`ModelRole`("fast"|"standard"|"deep")に `stt` を追加しない**。`MODELS: Record<ModelRole, string>`・
  `prompts.ts` の VALID_ROLES(role は Claude プロンプト専用)・`Usage` のトークン前提を壊さないため。
  STT モデル ID は `models.ts` の **`STT_MODEL` 定数**で一元管理(ハードコード禁止の維持)。
- 初期値は **`gpt-4o-transcribe`**(個人メモは一人語りで話者分離不要。ユーザ選択 2026-07-08)。
  話者分離が必要になった場合は QB-Meeting-Ops が本番運用している **`gpt-4o-transcribe-diarize`** を
  `STT_MODEL` の切替候補とする(§5.2 の四半期見直しに STT_MODEL も含める)。
- usage: STT は秒課金でトークン型 `Usage` に載らないため UsageRecorder は拡張せず、STT 独自の
  結果(モデル・音声秒数)を返して呼び出し側でログに残す。
- 言語処理(草案生成・訂正反映)は従来どおり Claude(`runAgentSearch`)のみ。OpenAI に送るのは
  音声バイナリと文字起こし指示だけ。

### D3. 外部送信先に OpenAI API(音声文字起こしのみ)を追加する(§9.4 改訂)

- `OPENAI_API_KEY` は knowledge-platform 専用に新規発行(課金・失効を QB と分離)し、環境ファイル
  (chmod 600)で注入・ログ出力禁止(logger のキー名リダクト対象に含める)。
- Agent SDK subprocess の env allowlist(agent.ts の `ANTHROPIC_`/`CLAUDE_`/`AWS_` 接頭辞)に
  **`OPENAI_` は追加しない**(subprocess への秘密漏出防止)。STT は bot 本体プロセスで呼び、キーは引数注入。
- §9.4 の外部送信 allowlist に **OpenAI(音声の文字起こしのみ)** を明示追加する(音声原本が OpenAI に
  渡ることを許容する)。既存 QB-Meeting-Ops が同一 API を本番運用中である事実をリスク許容の根拠とする。
- OpenAI のデータ利用ポリシー(学習利用・保持期間)を公式ドキュメントで確認し、確認日付と内容を本 ADR に
  追記する(ADR-0002 と同じ運用)。**確認は 2026-07-12 時点で未実施**。原文の「実装着手前に確認」は
  満たされないまま STT 実装が main にマージされた(手順逸脱として記録)。ゲートは
  **「実音声を投入する前に必ず確認」として維持**する — 未確認のまま実データを扱わない。

### D4. 記事化は capture 流、原本は同一の単発 PR に同梱

- 記事化は 💡 capture(PR-E1)と同じ「草案(`capture/draft.md`)→ 単発 PR → 投稿者本人へ DM →
  👍 で代理マージ」(**ユーザ裁定 2026-07-07**)。extractor に voice-memo ソースは追加しない
  (長文メモの取りこぼしが常態化したら夜間再走査の追加を再検討)。
- 文字起こし原本(全文・無加工)は `interviews/voice-memos/<YYYY>/<date>-<messageId>.md` として
  **記事草案・ID カウンタと同じ PR に同梱**(**ユーザ裁定 2026-07-08**)。bot の main 直 commit を
  避け、ADR-0014 の却下判断(書き込み経路の最小化)と整合する。
- 冪等キーはブランチ名 `voice-memo/<messageId>`(capture の `capture/<messageId>` と同型)。
- 記事エントリの出典は kb-core の `voiceMemoSourceSchema`(`{kind:"voice-memo", repo, path, ref}`)。
  原本はナレッジエントリではないため frontmatter スキーマ対象外(validate-repo は interviews/ を走査しない)。

### D5. 受付の耐障害性(pending_actions でレジューム)

MessageCreate ハンドラは検知時に即時 ✅ リアクションで受領を示し、`pending_actions`
(type `"voice_memo"`, state `"pending"`)に記録してから STT・PR 作成を実行する。処理完了で
`markActionDone`。bot 再起動時は pending をレジュームする(gap_answer と同じ二段冪等)。
STT 失敗時はスレッドにエラー返信し、pending は残して再試行可能にする。

### D6. 初期スコープの上限(P7)

チャンク分割・ffmpeg 依存は実装しない。添付サイズ・音声長の上限を設定値で持ち、超過時は
「長すぎます。分割して投稿してください」と返信して受け付けない。上限到達が常態化したら
QB-Meeting-Ops の分割実装(providers.py)を参考に拡張を再検討する。

## 影響・トレードオフ

- **利点**: QB-Meeting-Ops と結合ゼロ(障害・リリース・ホスト前提が独立)。③-b の受け入れ条件
  (原本保存・スレッド返信・訂正反映・本人操作 2 回)を全て満たせる。STT 実装は multipart POST +
  リトライで小さい。
- **AI 経路が 2 系統になる**(Claude = 言語、OpenAI = 音声のみ)。ADR-0009 の「1 本化」からの
  限定逸脱。封じ込め(packages/llm 内のみ)で緩和。
- 「同一エンジン」は時間とともに QB 側と乖離し得る(QB のモデル変更に自動追従しない)。
  §5.2 のモデル四半期見直しに STT_MODEL も含めることで緩和。
- 新規シークレット 1 個(OpenAI キー)と月次予算への STT 加算(§14#3 の枠内で人間が確認)。
- 👍 されないまま放置された PR は原本も main に載らない(ブランチには残る)。滞留 PR は
  ops チャンネルの棚卸しでカバー。

## 却下した代替案

- **QB-Meeting-Ops の intake チャンネル相乗り**(external_imports.yaml に voice-memo カテゴリ追加)
  → 出力が会議議事録固定で ③-b の AC を 3 点満たせない。チャンネル ID・プロンプトが他チーム管理の
  別リポジトリに置かれ、本リポの設定一元性から外れる。却下。
- **QB CLI(`import-discord-attachment-recording`)の subprocess/SSH 呼び出し** → 同一ホストか未確認、
  別ホストなら SSH = 新規攻撃面。QB の SQLite/storage に不要な会議 session が蓄積し運用を汚す。却下。
- **extractor 夜間バッチでの記事化(§6.4 L484 の字義どおりの経路)** → 即時性がなく、承認者が
  投稿者本人でなくなり ③共通 AC の精神から外れる。extract.md の会議前提(決定者・参加者)の改修と
  品質評価のやり直しも必要。人間裁定(2026-07-07)で capture 流を選択。
- **原本の main 直 commit** → ADR-0014 が gap-tracker で却下した経路の再提案になる。PR 同梱で
  P1(原本保存)は実用上満たせる(人間裁定 2026-07-08)。却下。

## 検証

- ユニット: STT クライアントは fetch モック(multipart 組み立て・リトライ・エラー分類)。
  検知ガード・パス生成・冪等判定は純関数 + fake(capture.test.ts の流儀)。
- 実機: VM 上で短い実音声 1 件を #voice-memo に投稿し、✅ → スレッド返信 → DM → 👍 → マージの
  一周を監督付きで確認(本人操作 2 回、③共通 AC。ADR-0013 D1(d) と同じ流儀)。
