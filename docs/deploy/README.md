# stratum Q&A bot — 常駐デプロイ手順(社内 Ubuntu VM / no-root / no-Docker)

常駐 discord-bot を **社内 Ubuntu VM の systemd「ユーザ」サービス**として動かす手順です。
root も Docker も不要。落ちても再起動・OS 再起動後も自動復帰します。設計判断は **ADR-0010** を参照
(ADR-0010 が当初の Fly.io/Docker 前提を更新。Docker イメージは将来の移行先用に末尾に残置)。

- 開発はローカル(WSL2 等)、**本番はこの VM**(分離)。
- 受信ポートは開けません。通信は **外向きのみ**(Discord WebSocket / `aws-external-anthropic.<region>.api.aws` / GitHub)。
- Phase 1a は **synthetic データのみ**(ADR-0002)。実データ投入は ADR-0010 §D3 のゲート(rootless サンドボックス検証等)を満たしてから。

---

## 前提(VM 側)
- Ubuntu 24.04(x86_64)、常時起動。
- 自分のユーザで SSH できる(root/sudo は不要)。
- 外向きにインターネット(上記3宛先)へ出られる。社内 FW で塞がれている場合は許可申請。

## 手順

### 1) Node 22(nvm・root 不要)
```sh
node -v   # 既に v22 ならスキップ
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL
nvm install 22
corepack enable     # pnpm を有効化
```

### 2) リポジトリを clone
```sh
mkdir -p ~/stratum && cd ~/stratum
git clone https://github.com/queeenb-com/knowledge-platform.git
cd knowledge-platform
```
(private リポなので、読み取り権限のある認証=deploy key / HTTPS トークン等が必要)

### 3) config + 検索コーパス(synthetic)
bot は `apps/discord-bot/config/*.yaml` を読みます(実値ファイルは `.gitignore` 済み)。`*.yaml.example` を雛形に作成:
```sh
cd ~/stratum/knowledge-platform/apps/discord-bot/config
cp channels.yaml.example channels.yaml   # allow: ["<許可チャンネルID>"]
cp repos.yaml.example   repos.yaml        # synthetic 3件(url なし)
cp members.yaml.example members.yaml      # 空で可
nano channels.yaml                        # 許可チャンネルIDを入れる
```
synthetic コーパスを clone 先に配置(`repos.yaml` が url なし=ローカル git リポを前提とするため):
```sh
cd ~/stratum/knowledge-platform
cp -r evals/fixtures/qa-corpus/. ~/stratum/clones/
cd ~/stratum/clones && git init -q && git add -A \
  && git -c user.email=bot@local -c user.name=bot commit -qm "synthetic corpus"
```
> 本物のリポに向けるのは ADR-0002 データポリシー確認後(`repos.yaml` に実 url + git 認証)。

### 4) デプロイスクリプト(初回は env 雛形→鍵入力→再実行)
```sh
cd ~/stratum/knowledge-platform
./docs/deploy/deploy.sh        # 1回目: ~/stratum/stratum.env の雛形を作って停止
nano ~/stratum/stratum.env     # REPLACE_ME を実値に(鍵の形式は env.example のコメント参照)
./docs/deploy/deploy.sh        # 2回目: build → service 設置 → 起動
```

### 5) 再起動後も常駐させる(初回のみ・1コマンド)
```sh
loginctl enable-linger "$USER"
loginctl show-user "$USER" | grep Linger    # => Linger=yes なら OK
```
> パスワードを求められて通らない場合だけ、IT に一度だけ `loginctl enable-linger <あなたのユーザ>` を依頼。

### 6) 確認 → Discord で /ask
```sh
systemctl --user status stratum-bot          # active (running)
journalctl --user -u stratum-bot -f          # 'slash commands registered' / 'discord-bot started'
```
許可チャンネルで `/ask <質問>` を実行。**§6.2 受け入れ条件**で確認:
- AC1: 既知の質問 → 出典付きで回答 + 👍👎
- AC2: コーパスに無い質問 → 捏造せず「分かりません」(キューに積まれる)
- AC3: 3連続で投げてもクラッシュしない

---

## 更新(新版を入れる)
```sh
cd ~/stratum/knowledge-platform && ./docs/deploy/update.sh
```

## 運用(ADR-0010 §D4)
- **死活監視**: bot の heartbeat を #stratum-ops 等へ(将来 follow-up)。当面は `systemctl --user status` を定期確認。
- **再起動テスト**: 一度 VM を再起動し、`systemctl --user status stratum-bot` が自動で running になることを確認(linger 必須)。
- **ログ掃除**: `journalctl --user --vacuum-time=14d`。
- **単一インスタンス厳守**: 同じ Discord トークンで bot を二重起動しない(SQLite + 直列キュー前提)。

## トラブルシュート
- **`node: command not found`(サービス起動時)**: systemd は nvm を読まない。`deploy.sh` は `which node` の絶対パスを
  unit に焼き込みます。Node を入れ替えたら `./docs/deploy/deploy.sh` を再実行(パス再生成)。
- **`enable-linger` が通らない**: polkit 制限。IT に1回だけ実行依頼(上記5)。
- **better-sqlite3 のエラー**: linux-x64 のビルド済みバイナリ取得が基本(コンパイル不要)。失敗する場合は
  ネットワーク制限の可能性。ログを添えて相談。
- **回答が来ない / 認証エラー**: env の鍵を確認。`ANTHROPIC_AWS_API_KEY` が AEAA…(~131字)であること
  (MT…/72字なら Discord トークンの取り違え)。VM から `aws-external-anthropic.<region>.api.aws` に出られるか。

## セキュリティ注意(ADR-0010 §D3)
root/Docker が無いため OS レベルの FS 封じ込めが弱く、Q&A エージェントの `Read` が原理的に
`~/.ssh` 等にも到達しえます。**synthetic のみなら許容**。**実データ(機微情報を含む議事録)を載せる前に**、
rootless サンドボックス(`bubblewrap` 等)で可視範囲を `~/stratum/clones` に限定できることを検証してください
(検証不可なら synthetic に留める / 別ホストへ)。

## 将来の移行(ADR-0010 §D5)
コア(`runAgentSearch` + 引用検証 + 整形)は Discord/VM 非依存。実データ本番化・可用性要件化の際は
AWS EC2/Fargate 等へ載せ替え可能(別 ADR で再評価)。その場合のコンテナ化資産として、リポジトリルートの
`Dockerfile`(非 root・read-only root FS 前提のマルチステージ。PR-6c)を利用できる。Docker 採用時は
env を Claude on AWS の 4 変数(`CLAUDE_CODE_USE_ANTHROPIC_AWS` / `ANTHROPIC_AWS_API_KEY` /
`ANTHROPIC_AWS_WORKSPACE_ID` / `AWS_REGION`)に読み替えること(ADR-0009。`Dockerfile` の旧 `ANTHROPIC_API_KEY`
記述は移行時に更新)。
