# ADR-0020: voice-memo の第 2 入口として VC 録音を追加する(recorder sidecar 流用)

- **ステータス**: proposed
- **日付**: 2026-07-17
- **関連**: design.md §6.4 ③-b(voice-memo)・§1.3(非目標)・§2 P1/P3/P7 /
  ADR-0015(STT = OpenAI 直呼び・添付方式・D6 分割なし)・ADR-0016(bot compose)/
  QB-Meeting-Ops `docs/recorder-sidecar-http-contract.md`(録音 sidecar の HTTP 契約)
- **備考**: 採択(`accepted`)と design.md §6.4/§1.3 の転記は人間レビューで行う。

## 背景

現行 voice-memo(ADR-0015)は「#voice-memo テキストチャンネルへの音声**添付**」が唯一の入口で、
スマホ等での録音 → アップロードの手間がある。ユーザー要望は「**ボイスチャンネルに入って喋るだけ**」
(P3 のワンタップ性の徹底)。社内には QB-Meeting-Ops が VC 録音の実証済みスタック
(録音専用 bot + discordjs-recorder sidecar・話者別 PCM → m4a)を持つが、外部 I/F は無く(§14#1)、
録音開始閾値も「2 人以上」(会議前提)で voice-memo(1 人語り)には合わない。

§1.3 の非目標「リアルタイム音声処理はしない(録音 → 後処理のバッチで十分)」は、
**録音をファイル化して後段バッチで処理する形なら抵触しない**(まさに想定形)。リアルタイムでの
逐次 STT・応答はひきつづき非目標。

## 決定

### D1. 録音は QB-Meeting-Ops の discordjs-recorder sidecar を**リポ内コピー**で流用する

- `sidecars/voice-recorder/` に server.js 一式(@discordjs/voice + @snazzah/davey + prism-media)を
  コピーし、stratum の docker-compose に**別コンテナ**として追加(localhost バインドの HTTP、
  meeting-ops と同じ契約: `POST /recordings/start|finalize|abort`・`GET /recordings/status|health`)。
- 録音データプレーンを bot 本体(read-only rootfs)から分離し、実証済みコードを無改造に近い形で使う。
  ffmpeg(PCM mix → m4a)は sidecar イメージにのみ同梱。
- 出所を明記し、上流(QB-Meeting-Ops)の改善は必要時に手動で取り込む(vendoring。共有パッケージ化はしない)。

### D2. VC に入る録音 bot は**専用アカウントを新設**する(meeting-ops と同じ役割分離)

- 制御 = stratum bot(voice-state 監視・セッション判断・後段接続)。録音 = 新設 bot
  (`RECORDER_DISCORD_TOKEN`・sidecar が使用)。Gateway セッションの分離で挙動を単純に保つ。
- stratum bot に `GuildVoiceStates` intent を追加(§9.5 の最小権限表を改訂)。

### D3. トリガーは「専用 VC への入室」・1 人語り限定・時間上限つき

- `voice.yaml` に `vc_channel_id`(既定 null = 機能 OFF)を追加。この VC への**入室(1 人目)で録音開始**、
  **退室(0 人)で finalize**。
- **2 人目が入室したら abort** し、「voice memo は 1 人用。会議は meeting-ops の対象チャンネルで」と案内
  (owner = 入室者で一意になり、現行の「本人へ DM」がそのまま成立する)。
- `max_recording_minutes`(既定 15)で自動 finalize(ADR-0015 D6 の「分割しない」を維持 — 128k m4a で
  25MB 上限内に収まる長さに制御する)。日次上限は既存 `daily_limit` を共用する。

### D4. 録音成果は既存 voice-memo パイプラインへ合流する(STT 以降は現行どおり)

- finalize 後、bot が `pending_actions(type:"voice_memo")` に**ローカルファイル参照 payload**
  (`source:"vc"`・`filePath`・`authorId`=入室者・`channelId`=vc)で投入 → 既存 voice-pipeline が
  添付 DL の代わりにファイルを読んで STT(packages/llm/stt.ts)→ 原本
  `interviews/voice-memos/` + capture 流の記事 PR + 本人 DM(👍 マージ・訂正フライホイール)。
- 録音ファイルは bot/sidecar で共有する volume(`STRATUM_DATA/recordings`)に置き、PR 同梱はしない
  (原本 = 文字起こし全文。音声は保持期間後に削除してよい — meeting-ops と同じ扱い)。

### D5. 安全弁

- 品質ゲートは v1 最小(0 バイト/極短の録音は STT に流さず本人へ案内)。meeting-ops の
  ffprobe ゲート移植は必要になってから(P7)。
- 録音同意: 対象 VC は録音専用であることを名前と topic で明示(§9.2 の周知運用と同じ)。
- OpenAI データ利用ポリシー確認(ADR-0015 D3 のゲート)は VC 経路でも**実音声投入前に必須**のまま。

## 影響・トレードオフ

- 利点: 「入って喋るだけ」で voice-memo が成立(P3)。録音スタックは実証済みコードの流用で新規リスク最小。
- コスト: コンテナ +1(sidecar)・bot アカウント +1・compose/デプロイ手順の追記。vendoring した
  sidecar は上流と乖離しうる(意図的な選択)。
- §1.3 は改訂不要(録音 → 後処理バッチは非目標の範囲外)だが、§6.4 ③-b への入口追記は design.md 転記が必要。

## 却下した代替案

- **meeting-ops に録音を任せて成果物連携**: 閾値(2 人)・出力(議事録/minutes リポ)・owner 概念が
  voice-memo と合わず、meeting-ops 側の改修と運用結合が発生。stratum 完結の要望に反する。却下。
- **meeting-ops の sidecar プロセスを共用(同一インスタンスを 2 つの制御プレーンから駆動)**:
  セッション管理の主が 2 つになり契約前提が崩れる。録音 bot も VC 1 つにしか入れない。却下。
- **@discordjs/voice を bot プロセスへ直接組み込み**: read-only rootfs・ffmpeg 同梱・書き込み領域など
  bot イメージの構成変更が大きく、障害分離も失う。却下。
- **リアルタイム逐次 STT**: §1.3 非目標。却下。

## 検証

- ユニット: 入退室スナップショット → 開始/中止/終了判定(1 人開始・2 人 abort・0 人 finalize・上限 finalize)、
  vc payload の voice-pipeline 分岐(ファイル読み・添付 DL しない)。
- 実機: 専用 VC で 1 人録音 → 退室 → DM に「こう記録しました」+ PR(現行 E2E と同じ受け入れ条件)。
  2 人目入室で abort 案内。15 分超で自動終了。
