# Runbook: pr-miner 週次マイニングの開始(実 PR・§6.4 ③-c)

pr-miner が **実 PR** を knowledge-base に出す運用を始めるための手順。対象開発リポの直近マージ済み PR から
設計判断・ハマりどころを抽出し、週次で 1 本の提案 PR にまとめる。実行境界は extractor-nightly と同じ
エフェメラル runner([ADR-0013](../adr/0013-extractor-real-run-on-ephemeral-runner.md))。

## 0. 前提

- [ ] PR-P1〜P3 がマージ済み(gh-client の PR 読み取り API / extractor exports / pr-miner 本体)
- [ ] knowledge-base に validate CI(スキーマ検証)が付いている(§6.1・ADR-0004 D2)
- [ ] **§14#5 の対象リポ一覧が開発リーダーによって決定済み**(未決の間は `PR_MINER_TARGETS` を空 = 機能 OFF)

## 1. 読み取り用 PAT の発行(人間。最重要)

pr-miner は対象リポの PR 本文・レビューコメント・変更ファイルを **API で読む**。読み取りは
**fine-grained PAT** で行い、GitHub App のインストール先は knowledge-base のまま広げない
(**read = PAT / write = App** の hybrid・ADR-0013 D4 の流儀):

GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token:

- **名前**: `stratum-pr-miner-read`(用途がわかる名前)
- **有効期限**: 90 日以内(切れたら再発行)
- **Repository access**: **対象リポ(§14#5 で決めたもの)のみ**選択
- **Permissions**(対象リポ): **Pull requests: Read** + **Issues: Read**(会話コメント取得に必要)。
  それ以外は付けない(§9.1 最小権限)
- knowledge-base 側は App が据え置きで担当(**Contents / Pull requests: Read and write** = 提案 PR を作る)

> PAT が対象リポにアクセスできないと、`listMergedPullRequests` が 404/権限エラーになる。pr-miner は
> リポ単位で失敗を隔離する(1 リポの失敗で全体は落ちない)ので、権限の入れ忘れは「そのリポだけ空振り」で表面化する。
> `GH_READ_PAT` 未設定の場合、読み取りも App で行う(App を対象リポにインストールする従来案。どちらでも動く)。

## 2. Actions secrets / vars の投入(人間・knowledge-platform リポの Settings)

| 種別 | 名前 | 値 |
|---|---|---|
| secret | `ANTHROPIC_AWS_API_KEY` / `ANTHROPIC_AWS_WORKSPACE_ID` / `AWS_REGION` | Claude on AWS の実値(extractor と共用) |
| secret | `GH_APP_ID` / `GH_APP_PRIVATE_KEY` / `GH_APP_INSTALLATION_ID` | 提案 PR 作成用の App trio(extractor と共用) |
| secret | `GH_READ_PAT` | 手順 1 の対象リポ読み取り PAT |
| secret | `EXTRACTOR_PAT` | KB clone 用 PAT(KB に Contents: Read。extractor と共用) |
| secret | `DISCORD_OPS_WEBHOOK` | #stratum-ops の webhook URL(👍 マージ導線に必要) |
| var | `PR_MINER_KB_REPO` | `org/knowledge-base` 形式の実リポ名 |
| var | `PR_MINER_TARGETS` | 対象リポをカンマ区切り(例 `org/app,org/lib`)。**空 = 機能 OFF** |
| var(任意) | `PR_MINER_MAX_PRS` | 1 run で処理する PR 数の上限(全リポ合計)。**未設定なら 5**。繁忙 run の LLM コスト暴走防止 |
| var(任意) | `PR_MINER_WINDOW_DAYS` | 初回(カーソル無し)の遡及日数。未設定なら 7 |

`PR_MINER_KB_REPO` が空の間は workflow の KB checkout / config 生成 / 実行がすべてスキップされる(安全な既定)。

## 3. 初回の監督付き実行(ADR-0013 D1(d))

1. **dry-run 確認**: Actions → pr-miner-weekly → Run workflow(`PR_MINER_REAL` はコメントのまま)。
   ログで (a) pr-miner.yaml 生成(targets が正しいか)、(b) KB checkout 成功、(c) `dry-run: 実 PR は作成しません`
   と各リポの取得 PR 数・抽出サマリ(新規/追記/矛盾/skip)を確認。
2. **実 PR を1回**: workflow の `# PR_MINER_REAL: "1"` のコメントを外して commit → Run workflow。
3. 生成された knowledge-base の PR(ブランチ `pr-miner/<YYYY-Www>`)を人間がレビュー。**diff にコードが
   混ざっていないこと**(判断・理由だけになっているか)を特に確認する。
4. #stratum-ops の通知に **👍** → bot が squash マージすることを確認(validate 緑が前提)。
5. 問題なければ schedule(毎週月曜 07:00 JST)に任せる。

## 4. ロールバック / 停止

- **機能 OFF**: var `PR_MINER_TARGETS` を空にする(次回実行は disabled で即終了)。
- **dry-run に戻す**: workflow の `PR_MINER_REAL` を再コメントアウト。
- **完全停止**: Actions → pr-miner-weekly → Disable workflow。
- **PR 単位**: knowledge-base 側で Revert PR。

## 5. 運用上の注意

- **id-counter.json のコンフリクト**: extractor(日次)と pr-miner(週次)は同じ `_meta/id-counter.json` を
  提案 PR に含める。両方の PR が同時に open のまま片方がマージされると、もう片方は id-counter が
  コンフリクトする。後着の PR を人間が rebase(または close して次回実行で作り直し)する。
- **冪等**: 先週の pr-miner PR が未マージのまま翌週の実行が走った場合、pr-miner は
  「open な `pr-miner/*` PR がある」ことを検出して新規提案を**保留**する(reason: already-exists)。
- **1 run の PR 上限(`PR_MINER_MAX_PRS`・既定 5)**: 繁忙期に 1 run で大量の PR を LLM 抽出してコストが
  跳ねるのを防ぐ(extractor の `EXTRACTOR_MAX_FILES`・ADR-0023 と同型)。上限超過分は**次回へ持ち越し**
  (カーソルは処理済みの PR までしか前進しないので欠落しない)。PR 本文とログに「持ち越し N 件」が出る。
  cap があるときは**開始リポを日替わりでローテート**するため、config 後方のリポも順番に処理される
  (毎回同じ先頭リポだけが処理される飢餓を防ぐ)。上限を上げたい/外したいときは var を調整する。
  滞留した PR を先に処理すること。
- **カーソル**: 対象リポごとの `last_merged_at` は提案 PR に同梱される `_meta/pr-miner-state.json` で
  前進する。PR がマージされて初めてカーソルが進む(extractor と同方式)。
