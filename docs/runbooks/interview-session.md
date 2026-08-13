# Runbook: インタビューセッション(/interview + VC 録音)

質問キット作成 → VC 面談(自動分割録音)→ 文字起こし原本 PR → extractor 複数記事化、の運用手順。
仕組みの設計判断は [ADR-0028](../adr/0028-interview-session-and-chunked-vc-recording.md)。

## 前提(1回だけ)

- VC 録音基盤が有効なこと: `RECORDER_URL` + `voice.yaml` の `vc_channel_id`(recorder コンテナ稼働)。
  未設定の環境では `/interview` コマンド自体が登録されない。
- 録音されることをチャンネル名/説明に明記し、参加者の同意を得る運用。
- `voice.yaml` の `interview_arm_ttl_minutes`(既定 120 分): `/interview start` 後、誰も VC に
  入らないままこの時間が過ぎるとセッションは自動キャンセル。

## 通常フロー

1. **質問キットを作る(任意・推奨)**: GitHub Actions → `interview-kit` → Run workflow
   (`person` / `topic`、まず `real: false` でログ確認 → `real: true` で PR)→ マージ。
2. **セッション開始**: Discord で `/interview start person:<対象者> topic:<テーマ>`。
   - `kit:` で質問キットのパス(`interviews/kits/...`)を明示できる。省略時は
     `person`×`topic` の規約パスを自動発見。見つからなければキット無しで開始(reply に明示)。
   - 進行中の別セッション・通常録音がある間は開始できない(先に終わらせる)。
3. **VC で面談**: 録音 VC に入ると自動で録音開始。**15 分ごとに自動分割**されるので
   退室・再入室は不要(チャンク境界で数秒の録音欠落あり — 大事な発言の途中で切れたら
   言い直す程度でよい)。途中経過は `/interview status`。
4. **終了**: 全員が VC から退室すると録音終了 → 文字起こし → セッション原本
   (`interviews/sessions/<年>/<日付>-<対象者>-<テーマ>-<ID>.md`)の PR が作られ、
   `/interview start` した人に DM が届く。
5. **承認**: DM の PR リンクを確認し、**DM に 👍** でマージ(bot が代理マージ)。
6. **記事化(自動)**: マージ後、夜間の extractor がセッション原本から複数のナレッジ記事・
   決定・未解決の問いを抽出して PR にする(通常の抽出 PR と同じレビュー導線)。

## 中止したいとき

- `/interview cancel` — armed(録音前)なら即キャンセル。録音中なら録音を破棄してキャンセル。

## 障害対応

- **DM が来ない / PR ができない**: bot ログで `interview` を grep。STT の一時失敗は
  自動再試行される(文字起こし済みチャンクはキャッシュされ再課金しない)。滞留の確認は
  `sqlite3 data/bot.db "SELECT id, state, created_at FROM pending_actions WHERE type='interview_session';"`
- **チャンク欠番**(本文に「(チャンク n: 音声を取得できませんでした)」): 無音区間や
  録音失敗の痕跡。前後の文脈で補えるなら PR をそのまま承認し、致命的なら面談を撮り直す。
- **bot 再起動が挟まった**: 録音中セッションは起動時に自動復元される(復元できなかった
  チャンクは欠番)。`/interview status` で継続を確認。
- **armed のまま放置**: TTL(既定 120 分)で自動キャンセルされる。すぐ消したいときは
  `/interview cancel`。
- **録音データの置き場**: VM の `RECORDINGS_DIR` 配下(meetingId ごと)。セッション処理が
  終わるまで cleanup からは保護され、既定 14 日で削除される。

## 制限・既知事項

- 同時に有効なセッションは全体で 1 件(v1)。
- `max_recording_minutes` は 22 分以下を推奨(STT の 25MB 上限。超えると起動時に warn)。
- VC 経路には日次のレート制限が無い(ADR-0020 D3 の既知の乖離・据え置き)。
