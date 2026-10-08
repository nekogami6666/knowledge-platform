# Runbook: Discord 本文検索の有効化(ADR-0038)

/ask が Discord の直近の議論を検索できるようにする機能(Discord 本文インデックス)を本番で有効化する手順。
コードは main に入っている(#172・ADR-0038 / 📢 の制限は #174・ADR-0040)が、**既定 OFF** で、
`discord-index.yaml` の `enabled: true` で初めて動く。本番への反映はオーナーの指示後(ADR-0038 D9)。

仕組みの要点(詳細は ADR-0038):

- bot が見えるチャンネル(permanent_exclude を除く)の本文を **bot.db とは別ファイル**
  (コンテナ内 `/data/discord-index.db` = VM の `~/stratum/data/discord-index.db`)に保存する
- 同期 = イベント(投稿・編集・削除)+ 起動時の取り込み(カーソルが無いチャンネルは直近 90 日)+
  定期照合(6 時間ごと・直近 7 日を取り直す)。180 日を過ぎた本文は定期照合で削除
- /ask のたびに「質問者が閲覧できる(ViewChannel ∧ ReadMessageHistory)∩ いま bot が見える ∩
  ¬permanent_exclude」のチャンネルだけを検索範囲にし、`discord_search` ツールとしてエージェントに渡す
- Discord の引用は、今回ツールが返した permalink だけを受け付ける

## 0. 前提チェック

- [ ] **VM のコードが #172・#174 を含む**(含まなければ先に `./docs/deploy/update.sh`)
  ```sh
  ssh stratum-vm
  cd ~/knowledge-platform
  git merge-base --is-ancestor ca18432 HEAD && echo OK   # ca18432 = #174(ADR-0040)。#172 はその祖先
  ```
- [ ] **Message Content intent は有効化済み**(追加作業なし)。bot は既に `MessageContent` を含む intents で
  ログインしている(`apps/discord-bot/src/discord.ts` の `BOT_INTENTS`。無効なら現行の bot が起動できない)。
  本機能に必要な intents は既存の Guilds / GuildMessages / MessageContent で足りる(ADR-0038 D3)
- [ ] **ディスク**: 見込みは 180 日で 100MB 未満(1 日 500 件・平均 150 字の試算・ADR-0038)。
  過去に `--build` の残骸でディスク 97% に達したことがあるため、空きを確認する
  ```sh
  df -h ~/stratum/data
  ```
- [ ] **bot.db には影響しない**: 本文は別ファイル(env `DISCORD_INDEX_DB_PATH`。Dockerfile の既定
  `/data/discord-index.db`)。OFF のときはファイル自体を作らない。ホスト側 timer(gap-tracker・freshness・
  stats・extractor-discord)はこのファイルを読まない
- [ ] **データの置き場所**: compose の `STRATUM_DATA`(既定 `~/stratum/data`)。deploy.sh が生成した
  リポルートの `.env` で確認する
  ```sh
  grep '^STRATUM_DATA=' ~/knowledge-platform/.env
  ```
- [ ] **bot が何を読んでいるか**: 起動ログの `visible channels(ADR-0018 監査)` に出るチャンネルが保存対象の
  上限(ここから permanent_exclude・VC 等の種別・private thread を除いたもの)。意図しないチャンネルが
  混ざっていれば、有効化の前に bot の閲覧権限を外すか `channels.yaml` の `permanent_exclude` に入れる
  ```sh
  docker compose logs bot | grep 'visible channels' | tail -n 1
  ```
- [ ] **#knowledge_sharing の閲覧者**が `ops.ask_role_ids` のロールと揃っている(📢 共有の前提・ADR-0040)
- [ ] 下の周知文を **有効化の前に** #knowledge_sharing へ投稿済み(§1)

### 設定ファイル

`~/knowledge-platform/apps/discord-bot/config/discord-index.yaml`(gitignore 済み・コンテナへは
`/config` として読み取り専用でマウント)。雛形 `discord-index.yaml.example` をコピーし、`enabled` だけを変える。
既定値は `apps/discord-bot/src/config.ts` の `discordIndexConfigSchema` と同じ:

```yaml
enabled: true
backfill_days: 90 # カーソルが無いチャンネルの初回取り込み(extractor と同じ)
retention_days: 180 # これより古い本文は削除(backfill_days 以上)
reconcile_interval_hours: 6 # 停止中の編集・削除を反映する定期照合の周期
reconcile_window_days: 7 # 定期照合で取り直す範囲(retention_days 以下)
max_results: 20 # discord_search 1 回で返す上限(最大 100)
max_fetch_per_channel: 10000 # 1 周期でチャンネルあたりに取得する上限
```

`retention_days < backfill_days` や `reconcile_window_days > retention_days` は起動時の検証で拒否される。

## 1. メンバーへの周知文(下書き・有効化の前に #knowledge_sharing へ)

> 📣 **ナレッジ共有エージェント: Discord の会話も /ask で探せるようにします(<日付> から)**
>
> 「昨日 #dev で決めた件」のような、まだナレッジ化されていない最近の議論も /ask で答えられるようにします。
>
> **保存するもの**: bot が見えるチャンネル(とその公開スレッド・フォーラム投稿)のメッセージ本文。
> 経営が指定した除外チャンネル、bot・webhook・システムのメッセージ、プライベートスレッド、添付だけの投稿は保存しません。
> 有効化の時点で直近 90 日分を取り込み、**180 日を過ぎた本文は自動で消えます**。メッセージを編集・削除すると、
> 保存側にも反映されます。保存先は社内 VM 上のファイルで、/ask の検索以外には使いません。
>
> **見えるのは誰か**: /ask の回答は質問した本人にだけ表示されます。さらに、**質問した人が Discord 上で読めるチャンネル**の
> 発言だけが検索されます(自分が入っていない非公開チャンネルの内容が回答に出ることはありません)。
>
> **検索されたくないチャンネルがあるとき**: 管理者に「除外リスト(permanent_exclude)に入れてほしい」と伝えてください。
> または、そのチャンネルを非公開にして bot のロールに閲覧権限を与えないでください。
> 人事・給与・健康などの話題は、これまでどおり除外チャンネルか bot のいない非公開チャンネルでお願いします。
>
> **📢 共有について**: Discord の発言を引用した回答は 📢 で共有できません(引用元を読めない人がいるかもしれないため)。
> 手元に残したいときは 📌 で自分の DM に保存できます。
>
> 質問・懸念はこのスレッドへどうぞ。

## 2. 有効化(VM)

非対話の ssh で docker を呼ぶときは、rootless Docker の PATH と `DOCKER_HOST` を通す
(`docs/deploy/set-anthropic-key.sh` と同じ):

```sh
export PATH="$HOME/bin:$PATH" DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
```

```sh
ssh stratum-vm
cd ~/knowledge-platform/apps/discord-bot/config
cp discord-index.yaml.example discord-index.yaml
sed -i 's/^enabled: false/enabled: true/' discord-index.yaml
grep '^enabled' discord-index.yaml          # => enabled: true

cd ~/knowledge-platform
# 回答中の /ask があれば少し待つ(update.sh と同じ確認。ホストに node と build 済みの dist が必要)
DB_PATH=~/stratum/data/bot.db node apps/discord-bot/dist/inflight-cli.js
docker compose restart bot                  # 設定だけの変更は再起動で反映(admin-guide §3)
```

コードの更新も同時に行う場合は `./docs/deploy/update.sh`(git pull → build → `docker compose up -d`)でよい。
再起動時、処理中の /ask は最大 60 秒待ってから中断・再質問の案内になる(ADR-0035 追記)。

### 見るログ

```sh
docker compose logs -f bot | grep -E 'config loaded|discord-index|Discord 本文|/ask: 完了'
```

| msg | 意味・見る項目 |
|---|---|
| `config loaded` | `discordIndex: true` になっていること |
| `Discord 本文インデックスは有効です(ADR-0038)` | 起動時に 1 回。`backfillDays` / `retentionDays` / `reconcileIntervalHours` / `reconcileWindowDays` |
| `discord-index: 同期が完了しました` | 起動直後(ClientReady)と 6 時間ごと。`guilds` / `fetched` / `upserted` / `deleted` / `purgedByVisibility` / `purgedByRetention` / `cappedChannels` / `failedChannels` / `messages`(保存件数の合計)/ `channels`(**保存済みチャンネル数**。周期で処理した数ではない) |
| `discord-index: チャンネルの同期に失敗しました` | warn。`channelId` ごと。`failedChannels` に計上され、次の周期で再試行 |
| `discord-index: チャンネル一覧の取得に失敗しました` / `discord-index: 同期に失敗しました(次の周期で再試行)` | warn。続くなら Discord 側の障害か権限を確認 |
| `discord-index: 見えなくなったチャンネルの本文を削除しました` / `discord-index: 対象外になったチャンネルの本文を削除しました` | 権限変更・permanent_exclude 追加で本文を消した(`purged`) |
| `discord-index: <処理名> の処理に失敗しました` / `discord-index: <処理名> に失敗しました` | イベント処理の warn(bot は落ちない。取りこぼしは次の照合で拾う) |
| `/ask: 完了` | `discordSearch: { calls, hits }`(ツールの呼び出し回数と返した件数。OFF なら null) |

初回の取り込みはチャンネル数 × 90 日分を直列に REST で取るため、最初の `同期が完了しました` まで時間がかかる
(1 チャンネル 1 周期あたり最大 `max_fetch_per_channel` 件で打ち切り、`cappedChannels` が 0 でなければ残りは次の周期で続ける)。
取り込み中も /ask は使える(その時点までの本文が検索される)。

保存件数とファイルサイズの確認(読み取り専用):

```sh
ls -lh ~/stratum/data/discord-index.db*
sqlite3 -readonly ~/stratum/data/discord-index.db "SELECT COUNT(*) FROM messages; SELECT COUNT(*) FROM channels;"
```

## 3. 実機確認(権限の異なる 2 人)

用意: A と B(どちらも `ask_role_ids` のロールを持つ)。テスト用の **private チャンネル X**(A と bot のロールは閲覧可・
B は閲覧不可)と、テスト用の **除外チャンネル Y**(bot が見える・`channels.yaml` の `permanent_exclude` に入れて再起動済み)。

> 注: trigram の全文検索は 3 文字以上の語で一致する(1〜2 文字は LIKE で補う)。合言葉は 3 文字以上の
> 他で使われない語にする。bot の投稿は保存されないため、合言葉は**人間が**投稿する。

1. **質問者の権限で絞られる**: A が X に「合言葉 `XQZ-Alpha-0001` の担当は A」と投稿する。
   A と B がそれぞれ #knowledge_sharing で `/ask XQZ-Alpha-0001 の担当は誰?` を実行する。
   - A: X の発言を出典(Discord の permalink)にして答える
   - B: X の内容を含まず、X の permalink を出典に持たない回答(未回答で可)。B の `/ask: 完了` ログの
     `discordSearch.hits` は件数だけなので補助として見る(合言葉が他チャンネルに無ければ 0 のはず)
2. **permanent_exclude は検索されない**: A が Y に合言葉 `XQZ-Beta-0002` を投稿し、A が /ask で聞く → Y の内容は出ない
   (保存も検索もされない。Y を permanent_exclude に入れる前の本文は、再起動時の照合で削除され
   `purgedByVisibility` に計上される)。
3. **編集・削除の反映**: 1 の投稿を編集して合言葉を `XQZ-Alpha-0003` に変える → A の /ask で新しい内容が引かれる
   (稼働中は MessageUpdate で即時)。次に投稿を削除 → A の /ask で出なくなる(MessageDelete で即時)。
   bot の停止中に行った編集・削除は、起動直後と 6 時間ごとの照合(直近 7 日)で反映される。
4. **📢 が出ない**: 1 で A が受け取った Discord 引用付きの回答に「📢 共有」ボタンが無いこと(👍👎📌 はある)。
   KB だけで答えた回答には 📢 が出ること。
5. 後片付け: テスト投稿を削除し、X・Y を消すか元の設定に戻す(Y を permanent_exclude から外したら再起動)。

## 4. ロールバック(ADR-0038 D10)

1. `discord-index.yaml` を `enabled: false` にして `docker compose restart bot`(ツールは渡されず、同期も止まる)。
   `config loaded` の `discordIndex: false` を確認
2. 本文を消す(本文はこのファイルにしか無い。bot.db・KB には影響しない):
   ```sh
   rm -f ~/stratum/data/discord-index.db ~/stratum/data/discord-index.db-wal ~/stratum/data/discord-index.db-shm
   ```
   1 の再起動の**後に**消す(bot がファイルを開いたままにしない)。

既に保存された回答(bot.db の `queries.answer`)には、回答に要約・引用された本文が残りうる(ADR-0038 D8)。

## 5. 未決事項(ADR-0038)

1. private thread を対象にするか(参加者一覧の取得と質問時の照合が要る)
2. 機能 OFF の /ask でも discord 引用を厳格化するか(D7)
3. extractor(ADR-0033)が REST の代わりに保存済み本文から読むか(ホストをまたぐファイル共有の方式)
4. アーカイブ済みスレッドの停止中の編集・削除の照合(`threads.fetchArchived` の追加コスト)。
   なお現行の実装は、取り込み・照合ともスレッドを**アクティブなものだけ**列挙する
   (`discord-index-discord.ts` の `fetchActiveThreads`)ため、有効化の時点で既にアーカイブされたスレッドの過去本文は取り込まれない
5. 保持期間 180 日の妥当性(利用実績を見て短縮を検討)
6. §9.3 の機微情報を保存段階で検出する仕組み(現状はプロンプトのみ)を入れるか
7. `discord_search` の呼び出し回数・件数を /ask の完了ログに出すか — 実装では `/ask: 完了` に `discordSearch { calls, hits }` が出ている
   (ADR 側の更新が残っている)
