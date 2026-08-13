# ADR-0028: interview セッション UI と VC 録音の自動チャンク分割

- ステータス: accepted(2026-08-13)
- 日付: 2026-08-13
- 関連: ADR-0015(voice-memo)/ ADR-0020(VC 録音)/ ADR-0027(抽出品質)/ design.md §6.4・§6.6 ⑤-b

## 背景

interview-kit(C7)は質問リストの生成までで、面談の録音〜ナレッジ化と繋がっていない:

- VC 録音は `max_recording_minutes`(既定 15 分)で**黙って切れ**、以降の会話が失われる。
  30〜60 分の面談は「テーマごとに全員退室 → 再入室」の運用回避が必要だった。
- 録音は voice-memo 経路(`interviews/voice-memos/` + capture 流用の**草案 1 本**)に流れ、
  面談 1 回から複数のナレッジ記事を抽出できない(extractor は voice-memos/ を意図的に除外)。
- 質問キット(`interviews/kits/`)と録音・文字起こしの間に紐付けが無く、
  「誰に・何を・なぜ聞いたか」を追跡できない。

また録音セッションの状態(`ActiveSession`)はプロセスメモリのみで、bot 再起動で消える。
15 分 1 本の音声メモなら損失は小さいが、数十分の面談では許容できない。

## 決定

### D1. interview セッションを pending_actions で永続化する

`/interview start person:<対象者> topic:<テーマ> [kit:<パス>]` で開始するセッションを
bot.db の `pending_actions`(type `interview_session`)に保存する。payload(zod 契約)は
sessionId(冪等キー)・person / topic / kitPath・starterId(= owner・DM 先)・
participantIds(チャンク横断の和集合)・chunks(seq / meetingId / filePath / transcript キャッシュ)・
currentChunk(再起動復元用)を持つ。state 遷移:

```
armed → recording → pending → done
   └──── cancelled(TTL 失効 / /interview cancel)
```

bot 再起動時は state:"recording" のセッションを復元し、currentChunk を冪等 finalize
(sidecar の finalize ジョブは冪等。sidecar も再起動済みで見つからなければ欠番)してから、
VC の現在人数で「次チャンク開始」か「セッション完了」を選ぶ。armed は DB でそのまま生存する。

**通常 VC 録音の ActiveSession のメモリ限定は維持する**(スコープ外)。15 分上限がある通常録音の
再起動ロスは最大 1 メモで許容範囲、セッションは蓄積が大きいため永続化する、という線引き。

### D2. 自動チャンク分割は「finalize 完了待ち → 直列 re-start」

上限到達時に録音を終わらせず、新しい meetingId(チャンク連番)で自動的に録音を再開する。
ただし **finalize と並行した再開始は不可能**: sidecar(@discordjs/voice)は 1 guild 1 音声接続で、
finalize ジョブが完了時に接続を destroy する。並行 start すると新チャンクが同じ接続を掴んだ直後に
破棄され無音になる。よって既存のポーリング(status が確定するまで待つ)後に再 start する
**直列方式**とし、チャンク境界に数秒〜十数秒(ffmpeg 変換時間)の録音欠落が生じることを許容する。
面談の用途では境界の数秒は失われても文脈で補える、という判断。sidecar は無改修。

付随の決定:
- **無音チャンク(finalize "failed")は欠番として続行**する。自動分割では無発話 15 分が普通に
  発生するため、チャンク失敗 ≠ セッション失敗。
- participant_ids はチャンク単位(発話者ベース)→ セッションでは和集合を取る。
- `max_recording_minutes > 22` は 128kbps AAC で STT の 25MB 上限を超えうるため設定ロード時に warn。
- recordings-cleanup はセッション(armed / recording / pending)のチャンク meetingId を
  「消してはいけない録音」に加える(STT 前の音声を retention で失わない)。

### D3. 自動分割は通常 VC 経路にも適用する

セッションが無い通常の VC 録音も、上限到達で黙って切れる代わりに自動で次の録音を開始する
(1 チャンク = 1 voice_memo = 1 PR の従来挙動の連結)。「上限後の会話が失われる」既知の穴の解消。

### D4. セッション原本は interviews/sessions/ に保存し、草案はスキップする

全チャンクの文字起こしを seq 順に結合し、
`interviews/sessions/<YYYY>/<YYYY-MM-DD>-<slug(person)>-<slug(topic)>-<sessionId 先頭6字>.md`
として**単発 PR(原本 1 ファイルのみ)**を作る。capture 流用の草案 1 本は作らない —
マージ後、夜間 extractor が `extract-interview` プロンプトで**複数のナレッジ記事**に分割する
(extractor の interviews 除外は kits / voice-memos のみなので sessions/ は自動的に抽出対象。
extractor 側の変更は不要)。パス規約:

- 日付は源泉日規約(`source-date.ts` の `YYYY-MM-DD`)に適合させ、抽出エントリの日付・ID 年に伝わる。
- sessionId サフィックスで一意化(日本語 person/topic の slug は "x" にフォールバックするため必須)。
- 冒頭に「参加者: A, B」行(extractor の parseParticipants 契約に適合)+ 対象者・テーマ・
  質問キットへの参照(`interviews/kits/...`)+ 文字起こしメタを記録する。
- パス定数・ビルダは kb-core に置く(`VOICE_MEMOS_DIR` の前例)。

PR の承認は既存の DM 👍 代理マージをそのまま使う(変更不要)。DM 先(owner)は
`/interview start` の実行者。STT 結果はチャンク単位で payload にキャッシュし、
一時失敗後の再試行で再 STT しない(コスト・時間)。恒久失敗チャンクは
「(チャンク n: 音声を取得できませんでした)」のプレースホルダで本文に明示して続行する。

### D5. 運用ルール

- 同時に有効な interview セッションは **1 件**(guild 単位ではなく全体で 1 件・v1 の単純化)。
- `armed` の TTL は既定 120 分(voice.yaml `interview_arm_ttl_minutes`)。誰も VC に入らないまま
  失効したら lazy に cancelled へ落とす。
- `/interview start` 時に通常録音が進行中なら**拒否**する(開始前の雑談の帰属が曖昧になるため。
  録音に後からセッションを被せない・v1)。
- `/interview cancel`: armed → cancelled。recording → 録音 abort + cancelled。
- `/interview status`: state・チャンク数・経過時間・kitPath・TTL 残りを ephemeral 表示。
- VC 録音機能(RECORDER_URL + voice.vc_channel_id)が無効な環境では /interview を登録しない。

## 影響・トレードオフ

- **利点**: 面談が「/interview start → VC で話す → 退室 → DM で 👍」の操作 3 回で複数ナレッジになる
  (§6.4 の操作最小化思想)。15 分制限の運用回避が不要になる。再起動でセッションが失われない。
  キット → 面談 → 記事の追跡が可能になる。
- **コスト**: チャンク境界の数秒欠落(D2)。vc-recorder の状態機械が複雑化(テストで固定)。
  bot.db に新 type(スキーマ変更は不要 — setActionPayload の追加のみ)。
- **既知の未解決(スコープ外)**: VC 経路の daily_limit 未適用(ADR-0020 D3 と実装の乖離)は
  本 ADR でも変えない。interview-kit の日本語 topic slug 衝突(kits/ 側)も据え置き
  (sessions/ 側は sessionId で回避)。

## 却下した代替案

- **sidecar にチャンクローテーション API を追加**: 境界欠落は消えるが、vendoring 元
  (QB-Meeting-Ops)との契約乖離が生まれる。v1 は無改修+欠落許容。効果不足なら再検討。
- **max_recording_minutes を 60 分へ**: 25MB 超過・失敗時の損失大・1 記事に情報過多(過去に否決済み)。
- **音声ファイルの Discord / GitHub 保存**: サイズ・機密性・履歴永続の問題(過去に否決済み)。
- **VC 録音全体(通常経路含む)の永続化**: 通常録音の再起動ロスは小さく、複雑化に見合わない(D1)。

## 実装 PR(予定)

1. 本 ADR(draft)
2. kb-core: interviews パス規約 + セッション原本ビルダ
3. discord-bot: セッション契約 + 状態機械(setActionPayload)
4. discord-bot: vc-recorder 自動分割 + 再起動復元
5. discord-bot: /interview start・status・cancel
6. discord-bot: セッション STT 結合 + 原本 PR + cleanup 保護
7. runbook + 本 ADR accepted 化

## design.md 転記リスト(人間)

- §6.4: VC 録音の自動チャンク分割(上限到達で切れない)。
- §6.6 ⑤-b: /interview セッションフロー(キット → 録音 → sessions/ → extractor 複数記事化)。
- §4.1.1: `interviews/sessions/` の追加(voice-memos は 1 記事・sessions は複数記事の抽出対象)。
