# ADR-0016: 常駐 bot の実行方式を rootless Docker + compose にする(ADR-0010 D1 の supersede)

- **ステータス**: accepted(2026-07-12。本 ADR PR のレビューをもって採択)
- **日付**: 2026-07-12
- **関連**: design.md §5.1(技術選定・ホスティング行)・§3.1(構成図)・§7.4(監視/再起動)・§9.1(シークレット)・§14#2 /
  ADR-0010(社内 VM systemd user — 本 ADR は D1 の実行方式のみ差し替え、ホスティング先は維持)・
  ADR-0006(FS 封じ込め — 本 ADR で前進)・ADR-0014(gap-tracker の VM systemd timer — D4 で維持)・
  ADR-0015(voice-memo 実データ E2E が実データゲートの直近の適用先)
- **備考**: design.md への転記(§5.1 ホスティング行・§14#2 の文言更新ほか)は同日の design 転記 PR
  (docs/design-sync)で実施。ADR-0010 側にも D1 supersede の注記を本 PR で付す。

## 背景

ADR-0010 は「当該 VM は **Docker 導入不可・sudo/root なし**」を制約として systemd user サービスを
選んだ。状況が変わった:

- ユーザ方針(2026-07-12)で VM の Docker 化を決定し、root を要する**一度きり作業 3 つ**を実施済み:
  (1) `uidmap` / `dbus-user-session` / `slirp4netns` / `fuse-overlayfs` の apt 導入、
  (2) AppArmor の userns プロファイル(`/etc/apparmor.d/home.vm.bin.rootlesskit`)、
  (3) compose plugin の配置(`~/.docker/cli-plugins/`)。
  → **rootless Docker 29.6.1 が動作**し、`docker run` で bot の起動を実証した
  (`config loaded` → `discord-bot started` → `slash commands registered`。synthetic corpus +
  `stratum.env` + config yaml マウント)。0010 の却下理由は崩れている。
- 0010 D3 は「実データ(機微情報)投入前に rootless サンドボックスで可視範囲を clones に限定」を必須と
  していた(bubblewrap 等を想定)。**コンテナ化はこれをより強い形で満たす**: bot プロセスの可視 FS は
  イメージ(read-only)+ 明示マウント(/config・/clones・/data)だけになり、`~/.ssh` や兄弟ディレクトリ
  には到達しない。voice-memo の実データ E2E(ADR-0015 検証)を控え、このゲートを Docker で満たす。
- VM 検証で判明した実挙動(repo 未反映):
  1. pnpm 10 では `pnpm deploy` が失敗し **`--legacy` フラグが必要**。
  2. deploy 後の /app に better-sqlite3 の **native が付いてこない**(pnpm 10 のスクリプト抑止)→
     deploy 後の rebuild が必要。
  3. rootless の uid 写像で、コンテナ内 `node`(uid 1000 → host subuid 約 100999)は bind mount した
     `~/stratum/data`(host uid 1000 所有)に**書けない**(`unable to open database file`)。検証は
     `--user 0` で回避した(rootless ではコンテナ内 uid 0 = ホストユーザ)。

## 決定

### D1. 常駐 bot は rootless Docker + compose で実行する(0010 D1 の実行方式を差し替え)

- `stratum-bot.service`(systemd user)直実行 → **`docker compose up -d`** に変更。ホスティング先
  (社内 Ubuntu VM)・外向き通信のみ・`~/stratum/stratum.env`(chmod 600)は 0010 D2 のまま
  (外向き宛先は 0010 の 3 つ + **OpenAI API(音声の文字起こしのみ・ADR-0015 D3)** の計 4 つ)。
- 0010 D3 の実データゲートは**コンテナ境界で満たす**: read-only rootfs + 明示マウントのみ。
  bubblewrap の個別検証は不要になる。

### D2. データは bind mount `~/stratum/{data,clones}` を継続し、コンテナは uid 0 で実行する

- 理由: gap-tracker(ADR-0014 D1)が**同じ bot.db を別ホストプロセスとして開く**
  (`stratum-gap-tracker.service` の `DB_PATH=__DATA_DIR__/data/bot.db`、WAL + busy_timeout)。
  named volume にするとファイルが subuid 所有になり、ホスト側バッチが読み書きできなくなる。
- rootless では **uid 0 = ホストユーザ(特権昇格なし)**。今日の systemd user サービスと同一のホスト
  権限であり、bind mount の所有はホストユーザのまま → gap-tracker 無変更・bot.db の移行も不要。
- イメージの既定 `USER node` は**維持**(ホスト非依存イメージ、rootful/K8s では node のまま安全)。
  uid 0 は **VM の compose 側 `user: "0"` でのみ**指定し、rootless 前提である旨をコメントで明示する。

### D3. compose の堅牢化

- `read_only: true`(rootfs)+ 書き込みが要る箇所だけ明示: `/tmp` と HOME(Agent SDK subprocess が
  書く)は tmpfs、`/clones`(起動時 git 同期)・`/data`(bot.db)は bind rw、`/config` は bind **ro**。
- `cap_drop: [ALL]`・`security_opt: [no-new-privileges:true]`・`restart: unless-stopped`・
  `env_file: stratum.env`。受信ポートは開けない(`ports` なし。0010 D2 の外向きのみを維持)。

### D4. バッチは現行のまま(ADR-0014 維持。実行形態は 3 系統と整理)

- gap-tracker は systemd user timer + ホスト node のまま。D2 により bot.db 共有は無変更で成立する。
- 整理: **常駐 = コンテナ / bot ローカル状態に触る oneshot バッチ = VM systemd(ホスト node)/
  リポジトリで完結するバッチ = GitHub Actions**(ADR-0014 の判断基準を継承)。
- freshness-checker(ADR-0018 予定)の設計時に、VM バッチを `docker compose run --rm` へ寄せるかを
  再評価する。

### D5. 起動保証と更新手順

- 自動起動: rootless の `docker.service`(systemd --user)+ `enable-linger`(0010 の既存)+
  `restart: unless-stopped`。bot 個別の unit は廃止(compose に委譲)。
- 更新: `git pull → docker compose build → docker compose up -d`(docs/deploy/README.md の Docker 節
  と update.sh に反映)。イメージ/ビルドキャッシュの `docker system prune` を運用手順に含める。
- 背景 3 点の Dockerfile 修正(`--legacy` / deploy 後 rebuild / env コメントの ADR-0009 追随)は
  本 ADR に紐づく build PR で反映する。

### 記録(既知の注意)

- zod peer 不整合: `@anthropic-ai/claude-agent-sdk` は zod@^4 を希望、repo は 3.25.76 固定。ビルドは
  通る。実行時に zod 起因の不具合が出たらまずこれを疑う。

## 影響・トレードオフ

- **利点**: FS 封じ込めが 0010 D3 の想定(bubblewrap)より強い形で入り、実データゲートを満たす。
  イメージはホスト非依存で可搬性(0010 D5)が前進。デプロイが宣言的になり手順書が短くなる。
- **欠点/コスト**: VM に Docker デーモン(rootless)の運用が増える(ディスク prune・バージョン追随)。
  イメージビルドが VM 上で走る(CI ビルド → レジストリ pull は将来オプション)。
- **`user: "0"` は誤解されやすい**: 「コンテナ内 root」に見えるが rootless では非特権(ホストユーザと
  同一)。compose のコメントと本 ADR で明示し、rootful 環境へ流用しないこと。
- 実行形態が 3 系統になる(D4)。判断基準を README に明記して緩和。

## 却下した代替案

- **named volume + `USER node` + 起動時 chown**(検証時の当初方針)→ gap-tracker(ADR-0014)が
  bot.db をホストプロセスとして開けなくなる。バッチも全て compose 化すれば解けるが、運用立ち上げ期の
  変更範囲が過大。ADR-0018(freshness-checker)時に再評価。現時点は却下。
- **ホスト dir を subuid へ chown**(`chown 100999 ~/stratum/data`)→ 今度はホストユーザ(gap-tracker)
  が書けない。却下。
- **systemd user サービス継続(現状維持)** → 実データゲート(0010 D3)を bubblewrap で別途検証・
  運用する必要が残り、ユーザ方針(Docker 化)にも反する。却下。
- **rootful Docker** → root 常用になり 0010 のセキュリティ前提から乖離。rootless で要件を満たす。却下。

## 検証 / 解消条件

- VM で: `docker compose up -d` → 起動ログ(`config loaded` の機能フラグ)→ `/ask` 1 回(Agent SDK
  subprocess が tmpfs HOME で動くことの確認)→ 母艦再起動後の自動復帰 → gap-tracker timer 手動 1 回で
  bot.db 共有(WAL)が問題ないこと。
- 実データゲート: D1(コンテナ境界)+ ADR-0002/§9.3(データポリシー・機微除外)の再確認をもって
  0010 D3 を満たしたと見なす(voice-memo E2E の前提)。
- 再評価条件: バッチの compose 化(ADR-0018 時)・CI ビルド化・EC2/Fargate 移行(0010 D5)は将来
  オプションのまま残す。
