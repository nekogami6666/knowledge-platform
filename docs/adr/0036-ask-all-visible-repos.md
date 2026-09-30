# ADR-0036: /ask の検索対象を「clone トークンで見える org リポ全部 − 除外リスト」にする

- ステータス: proposed
- 日付: 2026-09-30
- 関連: design.md §6.2(処理フロー step 2・検索対象)・§9.5(agentic search の読み取り面)・§14 #5 /
  ADR-0006(FS 封じ込め)・ADR-0013 D1(b)(トークンを .git/config に残さない)・ADR-0018(可視性で決める allowlist)・
  ADR-0033 追記(`all_visible` + `exclude` の前例)・ADR-0034(/ask ephemeral)・ADR-0035(時間予算・D6 探索予算)・
  ADR-0037(エージェントの読み取りを cwd に封じ込める・本 ADR の前提)

## 背景

`/ask` の検索対象は `repos.yaml` の静的な列挙で、実リポ切替(2026-07-24)以降
`knowledge-base` と `dev-minutes` の 2 つだけだった。このため `biz-minutes` の議事録や
`time-attendance-management` にしかない話題(例: 勤怠管理システム)は必ず `notFound` になり、
利用者から「根拠が見当たらないと言われる」と報告された(2026-09-30)。

社内会議(biz-minutes 2026-07-16 `minutes.md` L153)では検索対象の範囲を次のように整理済みだった:

> 奥村氏が見えているものは、原則としてメンバー全員に見えてよい範囲。ただし経営・採用系の内容が入る
> ミニッツや Board 関連は見せない。

本番の clone は `GIT_CLONE_TOKEN` で行っている。これは奥村氏の GitHub OAuth トークン(`gho_`・
scope `repo, workflow, read:org, gist`)で、org `queeenb-com` のリポ 87 件が見える(2026-09-30 実測)。
よって「奥村氏が見えるもの」=「このトークンで列挙できる org リポ」になる。
(`docs/deploy/env.example` は「knowledge-base と dev-minutes に Contents: Read の fine-grained PAT」と
説明しているが、実運用とずれている。本 ADR の実装時に説明を実態に合わせる。)

2026-09-30 時点の規模: 可視 87 件からアーカイブ 28・フォーク 3・下記除外 6 を除くと
**46 件・約 1.8GB(履歴込みの GitHub size)**。VM での `git fetch --depth=1` は 1 リポ約 0.9 秒。

### 段階的な導入(2026-09-30 決定)

1. **議事録を先に**: 会議の決定に照らして `biz-minutes` を `repos.yaml` に手動追加(設定変更のみ・実施済み)。
   `external-minutes` は投資家(VC)面談の議事録を含む = 経営系の内容のため対象外。`board-minutes` は明示的に対象外。
2. **利用者の限定**(D7)。
3. **読み取りの封じ込め**(ADR-0037)。全リポ化の前提条件。
4. **全リポ化**(D1〜D6)。

## 現状の実装(2026-09-30 確認)

本 ADR の設計が前提にする既存の挙動:

- `/ask` は受付のたびに `repos.yaml` の**全リポを直列で同期**(`fetch --depth=1` → `reset --hard` → `clean -fd`)
  してから検索する(`ask.ts` handleAskRequest → `repos.ts`)。**1 リポでも同期に失敗すると、その /ask 全体がエラー**になる。
- 引用の検証(`validateCitations`)は「**その回に同期したリポ**」の `SyncedRepo`(absDir・resolvedCommit)だけを許可する。
- `/ask` は bot 内の `SerialQueue`(/ask 専用)で直列化されている。一方、鮮度確認 DM への 👍🗑 の反映
  (`syncKbClone`)は**キューを通らず**に KB clone を同期し、作業ツリーに書き込む(ADR-0035 で既知のレース)。
- `/clones` は bot 専用。ホスト側 timer(gap-tracker・freshness・extractor-discord)は `clones-*` の別ディレクトリを使う。
- KB の clone 先 dir は `repos.find(r => r.repo === ops.kb_repo)?.dir ?? "knowledge-base"` で決まり、
  members 対応表・面談の topic・鮮度確認がこれに依存する。
- エージェントは cwd の外(`/config`・`/data/bot.db` 等)を Read できる(本番で確認)。→ ADR-0037 で塞ぐ。

## 決定

- **D1: 母集団は「`GIT_CLONE_TOKEN` で見える `org` のリポ全部」。** `repos.yaml` に
  `all_visible: { org, exclude, sync_on_ask }` を追加する(明示オプトイン・既定 OFF)。起動時と定期同期のたびに
  GitHub API(`GET /orgs/{org}/repos`)で列挙し、新しく作られたリポも自動で対象にする。既存の `repos:` 列挙は
  そのまま使え、両方ある場合は和集合にする(`repos:` 側が優先。KB は `repos:` に残し、dir 名 `knowledge-base` を固定する)。
- **D2: アーカイブ済みリポとフォークは常に除外する**(2026-09-30 奥村氏決定)。
- **D3: 除外リスト `exclude` の初期値**(2026-09-30 奥村氏決定):
  `board-minutes`・`Company-Management`・`fundraising-docs`・`financial-pack`・`governance`・`QB-Recruiting-Ops`
  (経営・採用・財務)と、`external-minutes`(投資家面談を含む経営系の議事録)。営業系・個人メモは 7/16 の原則どおり対象。
  除外は「clone しない」ことで実現する(読み取り面に置かない・§9.5)。`exclude` は列挙分にだけ効き、
  `repos:` の手動指定は明示の意図として残す。
- **D4: 対象から外れたリポの clone は削除する。** 除外に追加された・アーカイブされた・トークンで見えなくなったリポは、
  次の列挙で clones 配下から消す。削除対象は「bot が列挙由来(managed)として作ったと記録している dir」に限る
  (記録は bot.db に持つ)。`repos:` の手動指定分・KB・記録の無い dir(旧来の clone や手動配置)には触れない。
- **D5: 同期を `/ask` から切り離す(遅くしない)。** 46 件を毎回同期すると `/ask` 1 回あたり約 45〜50 秒増えるため:
  - 全リポの同期は bot 内で 10 分ごと(env `REPO_SYNC_INTERVAL_MS`)に `/ask` と同じ `SerialQueue` で行う
    (検索中に `reset --hard` が走らない)。
  - `/ask` のたびに同期するのは `repos:` の手動指定分と `sync_on_ask` に一致する列挙分だけ(例: `*-minutes`)。
  - **引用の許可リストは全対象リポの最新の `SyncedRepo` から作る。** その回に同期していないリポは、
    定期同期の結果(またはその場の `rev-parse HEAD`)を使う。これが無いとコードのリポへの引用がすべて破棄される。
  - **同期の失敗はリポ単位で扱う。** 失敗したリポはログに残して前回の状態のまま使い(clone が無ければ対象から外す)、
    /ask 全体は止めない。KB の同期失敗だけは従来どおりエラーにする。
  - 鮮度確認の `syncKbClone` も同じ `SerialQueue` に載せ、定期同期・/ask との競合をなくす。
  - 初回 clone(約 1.8GB)は起動後にバックグラウンドで行い、終わったリポから順に検索対象にする。
- **D6: 検索範囲をモデルが絞れるようにする。** system prompt 前置きのリポ対応表(manifest)に GitHub の description を載せ、
  プロンプト(qa/answer v4)で「まず KB と議事録、実装・仕様の話のときだけコードのリポ」と探索順を指示する。
  ADR-0035 D6 の探索予算(v3)は維持する。
- **D7: `/ask` の利用者を社内のチームロールに限定する。** `ops.yaml` の `ask_role_ids`(いずれか 1 つを持てば可)。
  初期値は Team QB・Team Tokyo・Team tohoku・Internal Dev・biz-dev-team(2026-09-30 奥村氏決定「全てのチーム」)。
  対象外には ephemeral で「社内メンバーのみ」とだけ返し、defer・検索・記録・レート予算の消費をしない。
  空なら従来どおり全員が使える(デプロイ順序の都合。本番では設定必須)。

## 影響・トレードオフ

- **所要時間**: 同期は D5 で現状維持の見込み。検索はコーパスが約 25 倍になり、広い質問ではターン数が増えうる。
  導入前後で本番相当の質問の所要時間・ターン数を比べ、悪化が大きければ除外・`sync_on_ask`・プロンプトを見直す。
  (golden eval は synthetic 3 リポのため、46 リポ規模の所要時間は測れない。)
- **鮮度**: コードのリポは最大 10 分遅れる(議事録・KB は /ask ごとに最新)。
- **範囲の正しさは GitHub 権限に依存する**: 奥村氏のアカウントの可視範囲がそのまま検索範囲になる。2026-09-30 時点で
  `board-minutes` は奥村氏から見えている(7/16 に「見えなくしてよい」とされた)ため、除外リストで防いでいる。
  新しく機密リポを作るときは、奥村氏に見えないよう権限を付けるか、除外リストへ足す運用が要る。
- **トークン**: 個人の OAuth トークン(書き込み権限を含む)に依存したまま。GitHub App の installation へ移すと
  「見える範囲」を App のリポ選択で管理でき、権限も読み取りに絞れる(将来課題)。
- **封じ込めが前提**: ADR-0037 が本番で有効になるまで D1 を本番で有効化しない。
- **ディスク**: VM の空きは 47GB で、clone の約 2GB は問題ない。
