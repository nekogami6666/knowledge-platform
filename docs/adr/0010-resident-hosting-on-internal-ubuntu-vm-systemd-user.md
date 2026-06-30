# ADR-0010: 常駐ホスティングを社内 Ubuntu VM の systemd user サービスにする

- **ステータス**: proposed
- **日付**: 2026-06-30
- **関連**: design.md §3.2(構成)・§5.1(ホスティング)・§7.4(監視/再起動)・§9.1(シークレット)・§11 Phase 1・§14 #2 /
  ADR-0006(Q&A エージェントの FS 封じ込め)・ADR-0008(Claude on AWS)
- **備考**: 採択(`accepted`)および design.md §5.1/§14#2 への転記は人間レビューで行う。

## 背景

design.md は常駐 discord-bot を Fly.io(Docker)または社内サーバ Docker Compose で動かす前提(§5.1)で、
§14#2 は「社内サーバがあればそちらを優先検討」としていた。実環境として社内に常時稼働の Ubuntu 24.04 VM
(x86_64、常時起動)があるが、**Docker 導入不可・sudo/root なし**という制約がある。Phase 1a は synthetic
データのみ(ADR-0002)で、扱うのは常駐 bot 1 プロセスのみ(抽出等のバッチは GitHub Actions)。

## 決定

### D1. 常駐は社内 Ubuntu VM の systemd **user** サービスとする
`stratum-bot.service`(user unit、`Restart=always`、`WantedBy=default.target`)とし、`loginctl enable-linger <user>`
でログオフ後も常駐させる。開発は従来どおりローカル WSL2 で行い、本番 VM とは分離する。

### D2. 配置とシークレット(§9.1)
- データ/clone は `~/stratum/{data,clones}`、Node 22 は nvm で導入。
- シークレットは `~/stratum/stratum.env`(`chmod 600`)に置き、`set -a; . stratum.env; set +a` で注入。
  `DISCORD_TOKEN` / Claude on AWS の 4 変数を含む。ログ出力禁止(§9.1)。
- 通信は **外向きのみ**(Discord WebSocket / `aws-external-anthropic.ap-northeast-1.api.aws` / GitHub)。
  受信ポートは開けない。

### D3. FS 封じ込め(ADR-0006)は段階適用とする
root/Docker が無いため OS レベルの FS サンドボックスが弱く、`Read` が `~/.ssh`・`/proc/self/environ`・
兄弟 clone 等に到達しうる(agent.ts 既知の境界)。**Phase 1a(synthetic のみ)はこの弱い境界を許容**する。
**実データ(機微情報を含む議事録)を載せる前に、rootless サンドボックス(`bubblewrap` 等、非特権ユーザー名前空間)
が当該 VM で機能することを検証し、可視範囲を `clones` に限定すること**を必須条件とする。検証不可の場合は
synthetic に留めるか、D5 の移行先で運用する。

### D4. 可用性は運用で担保する(§7.4)
マネージド基盤が無いため、(a) #stratum-ops への死活監視(heartbeat)、(b) 母艦再起動後にサービスが自動復帰
すること(enable-linger + `default.target`)の確認、(c) 「生かし続ける」運用担当の明示、を運用要件とする。
§7.4 の「再起動はプラットフォームに委譲」は systemd の `Restart=always` が担う。

### D5. transport 非依存を維持し、将来の載せ替えを縛らない
ホスト固有値(パス・チャンネル・リポ)は config/env 経由とし、コードに焼かない。Q&A の中核(`runAgentSearch`
＋引用検証＋整形)は Discord/VM 非依存に保ち、社内VMはあくまで「現在のデプロイ先」と位置づける。会議で確認した
「どこにでも載せられる(将来の MCP サーバ等)」方針(会議3)に従い、AWS / Fly.io / 別フロントエンドへの載せ替えを
将来オプションとして残す。

## 影響・トレードオフ

- **利点**: 追加コスト¥0、データが完全に自社内に留まる(機微情報の管理上は有利)、既存構成を流用でき新規作業が少ない。
- **欠点**: 当該 VM が単一障害点(電源/ネット/再起動依存)。OS パッチ・Node 更新・ディスク管理は自前。
  FS サンドボックスが弱く、実データ前に D3 の手当てが必須。
- §14#2(常駐ホスティング先)は本 ADR で **決定済み**に更新する。

## 却下した代替案

- **Fly.io(design 当初案)** → 唯一の毎月実費が発生し、かつデータが自社インフラ外へ出るため、機微データの本番に不利。却下。
- **AWS EC2 / Fargate(ap-northeast-1)** → クレジットで実質無償・Claude on AWS と同居・root でサンドボックス可と利点は大きいが、
  現時点(synthetic)では社内VMで充足するため不採用。**実データ本番化・可用性要件化の際の有力な移行先として保持**(D5)。
- **全面サーバレス(Vercel 等)** → Discord Gateway の常時 WebSocket に常駐が必要で不適(design §5.3)。却下。

## 検証 / 解消条件

- synthetic で、systemd 常駐・クラッシュ自動復帰・enable-linger・母艦再起動後の自動起動・死活監視を確認する。
- **実データ投入のゲート**: D3 の rootless サンドボックス検証 + ADR-0002(データポリシー再確認)+ Q&A プロンプトへの
  §9.3 機微情報除外、の 3 点が揃うこと。
- **再評価条件**: 実データ本番化、または可用性/可搬性が要件化した場合、D5 の移行先(EC2/Fargate 等)へ移すかを別 ADR で再評価する。
