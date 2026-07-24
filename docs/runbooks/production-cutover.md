# 本番カットオーバー手順(test → production・全コンポーネント)

テストサーバー/テスト bot から**本番**へ移す一連の手順です。deploy の機構は
[deploy/README.md](../deploy/README.md)、鮮度は [freshness.md](freshness.md)、VC 録音は
[voice-memo-vc.md](voice-memo-vc.md) を参照(本書はそれらを本番カットオーバーの順序で繋ぐ統合手順)。

## 前提(決定事項・2026-07-23)
- **VM**: rootless Docker + compose 導入済み(ADR-0016 前提を満たす)。
- **bot**: 新規 App を作らず、**今のテスト bot token を本番サーバーに招待して昇格**(App は1つ)。
- **/ask 検索**: synthetic → **実リポに切替**(ADR-0002 データポリシー確認 + git 認証)。
- **スコープ**: 全部(常駐 bot + gap-tracker + freshness + voice/VC録音)。

## 移行対象(既に本番相当のものは対象外)
| 何 | 本書での扱い |
|---|---|
| extractor / pr-miner / expertise(GitHub Actions) | ✅ 既に本番。**Step 5 で確認のみ** |
| 常駐 discord-bot | Step 1-3 で本番デプロイ + 実リポ検索 |
| gap-tracker / freshness(VM systemd) | Step 4 で `install-timers.sh` |
| voice/VC録音 | Step 0/2/3(録音専用 bot + `--profile vc`) |

---

## Step 0 — Discord 準備(ブラウザ・人間)
1. **テスト bot を本番サーバーに招待**: OAuth2 URL Generator で scopes=`bot`+`applications.commands`、
   permissions=View Channels / Send Messages / Add Reactions / Read Message History。生成 URL で本番サーバーへ。
2. **Developer Portal で privileged intent 有効化**: **Message Content Intent**(必須)。VC を使うので
   bot 設定の Gateway で voice 系も許可(bot は `GuildVoiceStates` を使う・ADR-0020)。
3. **録音専用 bot を新規作成**(ADR-0020 D2。メイン bot とは別 App)→ token を控える(`RECORDER_DISCORD_TOKEN`)。
   録音用 VC に招待(Connect 権限)。
4. **チャンネル ID を控える**(開発者モード ON → 右クリック → ID コピー): 依頼チャンネル / #stratum-ops /
   #voice-memo / 録音 VC / **本番サーバー(guild)ID**。
5. **webhook を作成**: 依頼チャンネル → `DISCORD_GAP_WEBHOOK`、#stratum-ops → `DISCORD_OPS_WEBHOOK`
   (チャンネル設定 → 連携サービス → webhook)。
6. **OpenAI API キー**(voice STT・ADR-0015。knowledge-platform 専用に新規発行)。

## Step 1 — VM: clone + config
```sh
mkdir -p ~/stratum && cd ~/stratum
git clone https://github.com/queeenb-com/knowledge-platform.git && cd knowledge-platform
```
`apps/discord-bot/config/`(実値は .gitignore 済み。`*.yaml.example` を雛形に):
- **`repos.yaml`(実リポ・/ask の検索対象)** — 推奨初期セット:
  ```yaml
  repos:
    - { repo: queeenb-com/knowledge-base, dir: knowledge-base, url: "https://x-access-token:<PAT>@github.com/queeenb-com/knowledge-base.git" }
    - { repo: queeenb-com/dev-minutes,    dir: dev-minutes,    url: "https://x-access-token:<PAT>@github.com/queeenb-com/dev-minutes.git" }
  ```
  `<PAT>` = KB/minutes を Contents:Read できる fine-grained PAT(Actions の EXTRACTOR_PAT と同等でよい)。
- **`ops.yaml`**: `channel_id: <#stratum-ops>` / `kb_repo: queeenb-com/knowledge-base`(👍 代理マージ)。
- **`voice.yaml`**: `channel_id: <#voice-memo>` / `vc_channel_id: <録音VC>` / `daily_limit`。
- **`channels.yaml`**: 任意(ADR-0018。公開だが読ませないチャンネルを `permanent_exclude`)。
- members は KB `_meta/members.yaml`(投入済み・設定不要)。

## Step 2 — secrets(`~/stratum/stratum.env`・chmod 600)
[deploy/env.example](../deploy/env.example) を雛形に、以下を実値化:
- 必須: `DISCORD_TOKEN`(テスト bot)/ Claude on AWS 4変数 / `DISCORD_GUILD_ID`(本番 guild)。
- 書き込み(bot の代理マージ/💡/voice + gap/freshness): **GitHub App trio**(Actions の `GH_APP_*` と同じ値)。
- voice: `OPENAI_API_KEY` / `RECORDER_URL=http://recorder:9488` / `RECORDER_DISCORD_TOKEN`。
- バッチ(同 env を共用): `DISCORD_GAP_WEBHOOK` / `DISCORD_OPS_WEBHOOK`。

## Step 3 — bot デプロイ(compose)
```sh
cd ~/stratum/knowledge-platform
./docs/deploy/deploy.sh        # 1回目: stratum.env 雛形を作って停止 → Step 2 を記入
./docs/deploy/deploy.sh        # 2回目: build → up -d
loginctl enable-linger "$USER" # 母艦再起動後も自動復帰
docker compose --profile vc up -d --build recorder   # VC 録音(録音 bot token 設定済みのとき)
```
確認: `docker compose logs -f bot` に `slash commands registered` / `discord-bot started`。
起動ログの**可視チャンネル一覧**に意図しないチャンネルが混ざっていないか確認(ADR-0018)。
本番サーバーで **/ask(実リポ)AC1/AC2/AC3・👍👎・💡→PR→DM→👍・#voice-memo に音声 / 録音 VC**。

> **単一インスタンス厳守**: テスト bot を本番へ移すので、**テスト側の bot 常駐は必ず停止**する
> (同一 token の二重起動は SQLite + 直列キューが壊れる)。

## Step 4 — gap-tracker + freshness(systemd)
```sh
cd ~/stratum/knowledge-platform
pnpm -r build                              # ホスト側 dist(systemd はコンテナ外で node 実行)
./docs/deploy/install-timers.sh            # まず dry-run で設置(GAP/FRESHNESS_REAL 無し)
# 初回検証(dry-run): 溜まった実 open 質問が「処理予定」ログに出るか
systemctl --user start stratum-gap-tracker.service
journalctl --user -u stratum-gap-tracker -n 40 --no-pager
# 問題なければ real 有効化で再設置
./docs/deploy/install-timers.sh --real
```
real 初回で **溜まった open 質問(検証時点で q-2026-0001〜0004)が処理**され、滞留分にリマインドが飛びます。

## Step 5 — Actions(既に本番・確認のみ)
- extractor: `gh workflow run extractor-nightly.yml` → 実 PR が knowledge-base に立つ → #stratum-ops 通知 → **👍 で代理マージ**。
- pr-miner: 初回完走のコスト/件数を見て `PR_MINER_TARGETS` / `window_days` を予算(ADR-0024 D1)に合わせて調整。
  実 PR 化は `PR_MINER_REAL` を後日 uncomment。
- expertise: 既に real(週次)。

## Step 6 — 監視(暫定)
- `docker compose ps` を定期確認(heartbeat 自動化は既知の follow-up)。
- #stratum-ops のバッチ通知(失敗・PR)を購読。
- コスト: `packages/llm` の週次サマリで消化率を追い、¥2-3万/月(ADR-0024 D1)超過傾向なら頻度/件数を絞る。

---

## データポリシー(ADR-0002・実データ GO)
/ask を実 minutes/KB に向ける = 実データを Claude on AWS へ送る(保持ポリシー下で許容)。§9.3 の機微除外は
system prompt が強制。FS 封じ込め(compose の read-only rootfs + 明示マウントのみ)が ADR-0010 D3 / ADR-0016 の
FS ゲートを満たす。**最終 GO は人間**(本カットオーバーの実施をもって GO とする)。

## ロールバック
- bot: `docker compose down`(テスト側を戻すなら旧環境を再起動)。
- gap/freshness: `systemctl --user disable --now stratum-gap-tracker.timer stratum-freshness.timer`。
- extractor: `EXTRACTOR_REAL_PR` を再コメント化(PR)で dry-run へ。

## KB データの掃除ルール(issue #92・重要)
テストデータや誤エントリを knowledge-base から消すときは、以下を厳守する(gap-tracker の台帳整合を壊さないため):

- **前進 commit のみで消す**。履歴書き換え(force push / rebase)・過去への巻き戻し・`_meta/id-counter.json`
  のリセットは**禁止**。ID は永久欠番でよい(欠番は無害。ID 再利用は有害)。
- KB を巻き戻すと q-id / kb-id が**再発番**され、bot.db に残った pending な `gap_pr` 台帳が**別の質問を指す
  stale 参照**になる → gap-tracker が無関係な質問を answered へ誤移動する(実際に 2026-07-24 に発生)。
  コード側に整合ガード(台帳の `asked_at` と KB 質問の `asked_at` を照合し不一致は skip + warn)を入れたが、
  巻き戻し自体を避けるのが本筋。
- **質問/回答系を掃除したら bot.db の関連台帳も同時に掃除**する(同じ VM 上・`DB_PATH=~/stratum/data/bot.db`):
  ```sh
  # 例: 消した質問 q-2026-000X に紐づく gap_pr / gap_reminder / gap_wontfix 台帳を確認して掃除
  sqlite3 ~/stratum/data/bot.db "SELECT id,type,payload_json FROM pending_actions WHERE type LIKE 'gap_%';"
  # 該当行を DELETE(または state を 'done' に)。掃除しないと整合ガードが毎 run 警告を出し続ける。
  ```
