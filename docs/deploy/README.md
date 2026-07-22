# stratum 常駐デプロイ手順(社内 Ubuntu VM / rootless Docker + compose)

常駐 discord-bot を **rootless Docker + `docker compose`** で動かす手順です(**ADR-0016**。
systemd user サービス直実行だった ADR-0010 D1 を差し替え)。落ちても再起動・OS 再起動後も自動復帰します。

実行形態は 3 系統(ADR-0016 D4):

| 何 | どこで | 例 |
|---|---|---|
| 常駐 | VM の rootless Docker(compose) | discord-bot |
| bot のローカル状態(bot.db)に触る oneshot バッチ | VM の systemd user timer(ホスト node) | gap-tracker / freshness-checker |
| リポジトリで完結するバッチ | GitHub Actions | extractor / pr-miner / eval |

- 開発はローカル(WSL2 等)、**本番はこの VM**(分離)。
- 受信ポートは開けません。通信は **外向きのみ**(Discord WebSocket / `aws-external-anthropic.<region>.api.aws` /
  GitHub / `api.openai.com` — voice-memo の文字起こしのみ・ADR-0015)。
- FS 封じ込め: bot からはイメージ(read-only)+ 明示マウント(`/config`(ro)・`/clones`・`/data`)しか
  見えません(ADR-0010 D3 の実データゲートの FS 要件を満たす。データポリシー再確認(ADR-0002/§9.3)は
  別途 — ADR-0016 検証節)。

---

## 前提(VM 側)

- Ubuntu 24.04(x86_64)、常時起動。自分のユーザで SSH できる。
- **rootless Docker + compose plugin 導入済み**(root を要する一度きり作業 3 つ — `uidmap` 等の apt /
  AppArmor userns プロファイル / compose plugin。詳細は ADR-0016 背景。未導入なら IT に依頼):
  ```sh
  docker info --format '{{.SecurityOptions}}'   # rootless を含めば OK
  docker compose version
  systemctl --user status docker                # active (running)
  ```
- Node 22(nvm)— **gap-tracker(systemd 側)にのみ必要**。bot だけならコンテナ内で完結。
- 外向きにインターネット(上記 4 宛先)へ出られる。塞がれている場合は許可申請。

## 手順

### 1) リポジトリを clone
```sh
mkdir -p ~/stratum && cd ~/stratum
git clone https://github.com/queeenb-com/knowledge-platform.git
cd knowledge-platform
```
(private リポなので、読み取り権限のある認証=deploy key / HTTPS トークン等が必要)

### 2) config + 検索コーパス(synthetic)
bot は `apps/discord-bot/config/*.yaml` を読みます(実値ファイルは `.gitignore` 済み)。`*.yaml.example` を雛形に作成:
```sh
cd ~/stratum/knowledge-platform/apps/discord-bot/config
cp repos.yaml.example   repos.yaml        # synthetic 3件(url なし)
# channels.yaml は任意(ADR-0018: 読むチャンネルは Discord のロール可視性で決まる。
# 「公開だが読ませない」明示除外を使う場合のみ channels.yaml.example をコピーして permanent_exclude を記入)
```
> **チャンネルの読み取り制御(ADR-0018)**: bot(専用ロール)が見えるチャンネル = 読む。
> 機密チャンネルは private にして bot を入れない。bot ロールに **Administrator を付けない**こと。
> 起動ログに可視チャンネル一覧が出るので、意図しないチャンネルが混ざっていないか確認する。
> members 対応表(github ↔ discord)はローカル設定ではなく **knowledge-base リポの
> `_meta/members.yaml`** が唯一の正です(ADR-0017 D3)。各自が KB への PR で申告し、bot は
> KB clone から自動で読みます(未整備の間は owner が "unassigned" になるだけで動作します)。
synthetic コーパスを clone 先に配置(`repos.yaml` が url なし=ローカル git リポを前提とするため):
```sh
cd ~/stratum/knowledge-platform
mkdir -p ~/stratum/clones
cp -r evals/fixtures/qa-corpus/. ~/stratum/clones/
cd ~/stratum/clones && git init -q && git add -A \
  && git -c user.email=bot@local -c user.name=bot commit -qm "synthetic corpus"
```
> 本物のリポに向けるのは ADR-0002 データポリシー確認後(`repos.yaml` に実 url + git 認証)。

### 3) デプロイ(初回は env 雛形→鍵入力→再実行)
```sh
cd ~/stratum/knowledge-platform
./docs/deploy/deploy.sh        # 1回目: ~/stratum/stratum.env の雛形を作って停止
nano ~/stratum/stratum.env     # REPLACE_ME を実値に(鍵の形式は env.example のコメント参照)
./docs/deploy/deploy.sh        # 2回目: docker compose build → up -d
```
deploy.sh はリポルートに `.env`(compose 変数: `STRATUM_ENV`/`STRATUM_DATA`/`STRATUM_CLONES` の
絶対パス)も生成します(`.gitignore` 済み)。

### 4) 再起動後も常駐させる(初回のみ)
```sh
loginctl enable-linger "$USER"
loginctl show-user "$USER" | grep Linger      # => Linger=yes なら OK
systemctl --user is-enabled docker            # => enabled(rootless docker の自動起動)
```
linger + rootless `docker.service` + `restart: unless-stopped` の 3 点で母艦再起動後も自動復帰します
(ADR-0016 D5)。

### 5) 確認 → Discord で /ask
```sh
docker compose ps                    # bot が running
docker compose logs -f bot           # 'slash commands registered' / 'discord-bot started'
```
許可チャンネルで `/ask <質問>` を実行。**§6.2 受け入れ条件**で確認:
- AC1: 既知の質問 → 出典付きで回答 + 👍👎
- AC2: コーパスに無い質問 → 捏造せず「分かりません」(キューに積まれる)
- AC3: 3連続で投げてもクラッシュしない

---

## systemd 直実行からの切替(既存 VM・一度きり)

旧 `stratum-bot.service`(ADR-0010 D1)から移行する場合:
```sh
systemctl --user disable --now stratum-bot.service
rm ~/.config/systemd/user/stratum-bot.service && systemctl --user daemon-reload
cd ~/stratum/knowledge-platform && ./docs/deploy/deploy.sh
```
`~/stratum/data/bot.db` は**そのまま使われます**(bind mount + uid 0 = ホストユーザのため移行・chown
不要 — ADR-0016 D2)。gap-tracker の unit も変更不要。

## 更新(新版を入れる)
```sh
cd ~/stratum/knowledge-platform && ./docs/deploy/update.sh
```
(git pull → ホスト側 build(gap-tracker 用)→ `docker compose build` → `up -d`)

## 運用(ADR-0010 D4 / ADR-0016 D5)

- **死活監視**: 当面は `docker compose ps` を定期確認(heartbeat は将来 follow-up)。
- **再起動テスト**: 一度 VM を再起動し、`docker compose ps` で自動復帰を確認(linger 必須)。
- **ログ**: `docker compose logs --tail 200 bot`。肥大したら `docker system prune -f`(停止中コンテナ・
  未使用イメージ・ビルドキャッシュの掃除。月 1 目安)。
- **単一インスタンス厳守**: 同じ Discord トークンで bot を二重起動しない(SQLite + 直列キュー前提)。
  切替時は旧 systemd サービスの停止を必ず先に。

## gap-tracker / freshness-checker(systemd user timer のまま・ADR-0014 / ADR-0019)

bot の Docker 化後も gap-tracker は**ホスト側 systemd のまま**です(`docs/deploy/stratum-gap-tracker.{service,timer}`)。
freshness-checker(§6.7)も同型です(`stratum-freshness.{service,timer}`・平日 11:00 JST。
開始手順は `docs/runbooks/freshness.md`)。
bot.db は bind mount + uid 0 によりホストユーザ所有のままなので、同一ホスト別プロセスの共有
(WAL + busy_timeout)が従来どおり成立します(ADR-0016 D2)。gap-tracker の更新はホスト側 build
(update.sh がやる `pnpm -r build`)で反映されます。

> **既知の制約 — clones ディレクトリの共有と `git clean`(follow-up 予定)**
> bot・gap-tracker・freshness-checker は同一の `~/stratum/clones/knowledge-base` を共有します。
> 各 sync は `reset --hard` の後に `git clean -fd` を行い、未追跡の staging 残骸を掃除します
> (これが無いと gap-tracker が自分の dry-run 残骸を「commit 済み」と誤認しキューを消費した・2026-07-22)。
> 現構成では bot が KB に url 無し(clean しない分岐)なので競合しませんが、**将来 bot にも KB url を
> 設定する場合**、gap-tracker が validateRepo 用に staging している最中に bot の clean が
> それを消し、検証を素通りした未検証 commit が main に入りうる。恒久対応(アプリ別 CLONES_DIR 分離、
> または flock による直列化)は follow-up。それまでは bot の KB を url 無し運用に保つこと。

## トラブルシュート

- **`unable to open database file` / permission denied(/data)**: compose の `user: "0"` を消していないか
  確認(rootless では uid 0 = ホストユーザ。`node` に変えると subuid 所有になり書けない — ADR-0016 D2)。
- **`docker: command not found` / permission**: rootless Docker が自分のユーザに入っているか
  (`systemctl --user status docker`)。未導入は IT に依頼(前提参照)。
- **`enable-linger` が通らない**: polkit 制限。IT に 1 回だけ実行依頼。
- **better-sqlite3 のエラー**: イメージビルド内で 2 回焼いています(workspace + /app)。それでも出る場合は
  `docker compose build --no-cache` を試し、ログを添えて相談。
- **回答が来ない / 認証エラー**: env の鍵を確認。`ANTHROPIC_AWS_API_KEY` が AEAA…(~131字)であること
  (MT…/72字なら Discord トークンの取り違え)。VM から `aws-external-anthropic.<region>.api.aws` に出られるか。
- **zod 起因の実行時エラー**: agent-sdk は zod@^4 希望・repo は 3.25 固定(既知の peer 不整合。
  ADR-0016 記録)。まずこれを疑い、再現ログを issue へ。

## セキュリティ注意(ADR-0016 D3)

- コンテナは `read_only` rootfs + `cap_drop: ALL` + `no-new-privileges` + 明示マウントのみ。
  `~/.ssh` 等ホストの他領域には到達しません(ADR-0010 D3 の実データゲートを満たす)。
- **`user: "0"` は rootless 前提**(= ホストユーザ、特権昇格なし)。この compose を rootful Docker や
  他ホストへそのまま流用しないこと。
- シークレットは `~/stratum/stratum.env`(chmod 600)のみ。イメージ・レイヤ・ログに焼かない(§9.1)。

## 将来の移行(ADR-0010 D5)

コア(`runAgentSearch` + 引用検証 + 整形)は Discord/VM 非依存。イメージはホスト非依存
(既定 `USER node`)のため、実データ本番化・可用性要件化の際は AWS EC2/Fargate 等へ
そのまま載せ替え可能(別 ADR で再評価)。

## voice-recorder sidecar(VC 録音・ADR-0020)

VC voice-memo の録音は compose の `recorder` サービス(QB-Meeting-Ops discordjs-recorder の
vendored copy・`sidecars/voice-recorder/`)が担う。`stratum.env` に録音専用 bot の
`RECORDER_DISCORD_TOKEN` を追記し、`docker compose --profile vc up -d --build recorder` で起動
(recorder は `profiles: ["vc"]` で隔離 — 素の `up -d` / update.sh はトークン未設定でも
recorder を起動しない)。
bot からは compose 内部ネットワークの `http://recorder:9488`(ports 非公開)。録音ファイルは
`~/stratum/recordings`(bot と同一マウント)。手順の詳細: `docs/runbooks/voice-memo-vc.md`(PR-V8)。
