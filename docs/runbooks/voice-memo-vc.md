# Runbook: VC 録音 voice-memo の開始(§6.4 ③-b / ADR-0020)

「専用ボイスチャンネルに入って喋るだけ」で voice-memo(原本保存 + 記事 PR + 本人 DM)が動く
第 2 入口を有効化する手順。録音は compose の `recorder` sidecar(PR-V6)、制御は bot(PR-V7)。

## 0. 前提

- [ ] PR-V5〜V7 がマージ済みで、VM のコード・イメージが最新(`./docs/deploy/update.sh`)
- [ ] 添付経路の voice-memo が設定済み(`voice.yaml` の channel_id・`OPENAI_API_KEY`)—
      STT 以降は同じパイプラインを使うため
- [ ] **OpenAI データ利用ポリシーの確認(ADR-0015 D3 のゲート)** — 未実施なら実音声を流す前に必ず

## 1. 録音専用 bot の作成(人間・Developer Portal)

1. https://discord.com/developers/applications → New Application(名前例: `stratum-recorder`)
2. Bot タブ → トークンを控える(**Privileged Intents は不要**。MESSAGE CONTENT 等は OFF のまま)
3. OAuth2 → URL Generator → scope `bot`・権限 **Connect** のみ → 生成 URL でサーバーへ招待
4. 対象 VC(手順 3)が private の場合は録音 bot(のロール)をチャンネルに入れる

## 2. 設定(VM)

```sh
# stratum.env に録音 bot のトークンを追記(chmod 600 のまま)
echo 'RECORDER_DISCORD_TOKEN=<手順1のトークン>' >> ~/stratum/stratum.env
# bot 用に sidecar の URL(compose 内部ネットワーク)も追記
echo 'RECORDER_URL=http://recorder:9488' >> ~/stratum/stratum.env
mkdir -p ~/stratum/recordings
```

## 3. 専用 VC の作成 + voice.yaml

- Discord に録音専用のボイスチャンネルを 1 つ作る。**名前か topic に「入室中は録音されます」を明記**
  (§9.2 の周知運用・録音同意)
- `apps/discord-bot/config/voice.yaml` に追記:

```yaml
vc_channel_id: "<作った VC の ID>"
# max_recording_minutes: 15   # 既定 15 分(STT 25MB 上限に収める・D6)
```

## 4. 起動

```sh
cd /home/vm/knowledge-platform
docker compose up -d --build recorder bot
docker compose logs recorder --tail 5   # listening 表示
docker compose logs bot --tail 5        # {"vcRecorder":true,"msg":"VC 録音入口(ADR-0020)"}
curl -s http://127.0.0.1:9488/health 2>/dev/null || docker compose exec bot sh -c 'wget -qO- http://recorder:9488/health'
```

## 5. E2E(受け入れ確認)

1. 専用 VC に 1 人で入って 20〜30 秒喋る → 退室
2. 数十秒後、本人に DM: 「🎙️ VC 録音をナレッジ化する PR を作成しました」+ 冒頭抜粋 + 原本パス
3. PR に原本(`interviews/voice-memos/…`)+ 記事 + 採番が同梱されている(validate CI 緑)
4. DM に 👍 → 代理マージ(§6.3)
5. 2 人で入り直して数十秒喋る → 退室 → 記事の `people` に両者(members.yaml 登載者)が載る
6. 15 分放置 → 自動 finalize されることを一度だけ確認(任意)

## 運用ノート

- 録音の開始/終了は入退室に完全連動(コマンド無し・P3)。**2 人目以降が入っても録音は継続**
  (owner = 最初の入室者・D3)
- 録音失敗(sidecar 不達・finalize failed)は owner に DM 案内(pending は積まない = 録り直し)
- 音声(recording.m4a)は `~/stratum/recordings/` にのみ残る(PR には載せない)。容量が気になったら
  古い meeting ディレクトリを削除してよい(原本 = 文字起こしは KB にある)
- 話者分離は v1 では無し。必要になったら `STT_MODEL` を diarize 版へ(ADR-0015 D2)

## トラブルシュート

- **DM が来ない**: ① `docker compose logs bot | grep vc`(start/queued/failed)② recorder の
  `/health` ③ `~/stratum/recordings/<meeting_id>/recording.m4a` の有無
- **録音 bot が VC に入らない**: トークン取り違え(stratum.env)/ 招待時の Connect 権限 /
  private VC に録音 bot が入っていない
- **`vcRecorder: false` で起動**: voice.yaml の `vc_channel_id` か env `RECORDER_URL` の欠落

## design.md 転記リスト(人間レビュー・ADR-0020 採択時)

- §6.4 ③-b: 入口に「専用 VC 録音(ADR-0020)」を追記
- §9.5 intents 表: `GuildVoiceStates` 追加
