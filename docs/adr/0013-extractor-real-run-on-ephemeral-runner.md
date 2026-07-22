# ADR-0013: extractor 実運用の暫定実行境界を GitHub Actions エフェメラル runner とする

- **ステータス**: accepted(2026-07-23。ユーザ承認「accept でok / 本番でok」で採択。D1 条件 (a)〜(e) 実装済み・GitHub App 発行済み。ただし実 PR 開始 `EXTRACTOR_REAL_PR=1` は precision≥0.80 + 監督付き dry-run の実行時ゲートを別途満たすこと=Phase D)
- **日付**: 2026-07-05(起案)/ 2026-07-23 採択
- **関連**: design.md §6.3(extractor)・§9.1(資格情報)・§9.5(封じ込め)・§11 Phase 2 DoD /
  ADR-0002(データポリシー・accepted)・ADR-0006(FS 封じ込め・proposed)・ADR-0011(auth-agnostic)・
  ADR-0012(実データローカル dry-run 例外・proposed)
- **備考**: 採択(`accepted`)および design.md への転記は人間レビューで行う。GitHub App(§14 #9)が発行された
  ため、認証は D4 の hybrid(PR/書き込み=App / clone・読み取り=PAT)へ更新した(D1(e) を上書き)。

## 背景

Phase 2 の DoD(§11 L700)は「2週間の運用で承認フローが回る」= extractor が**実 PR** を出す運用を要求する。
しかし [ADR-0012](0012-extractor-real-data-local-dry-run-exception.md) D3 は「実 PR・常駐は ADR-0006 D1 の
OS/コンテナ FS 隔離が整うまで行わない」と定めた。ADR-0006 の本丸(コンテナ FS ジェイル)はホスティング
選定(§14 #2)待ちで、このままでは Phase 2 が閉じられない。

一方、extractor の実行環境は常駐 bot と異なり **GitHub Actions のエフェメラル runner**(ジョブごとに使い捨ての
VM)である。そこには開発者のホームディレクトリも他プロジェクトの秘密も存在せず、可視 FS はほぼ
「checkout した knowledge-platform + 取得した clones + ランナーのツール」に限られる。残る漏洩ベクタは:

1. **checkout が `.git/config` に永続化する GITHUB_TOKEN**(actions/checkout の既定)
2. **clone URL に埋めたトークンが clone 先の `.git/config` に残る**(reconcile の agentic Read が到達可能)
3. **プロセス env の秘密が agent subprocess に渡る**(→ 既に `buildAgentEnv` が遮断: ANTHROPIC_*/CLAUDE_*/AWS_*
   と基本変数のみ許可。GITHUB_* / DISCORD_* は通らない・PR-6a 実装済み)

## 決定

### D1. エフェメラル runner を extractor 実運用(実 PR)の暫定実行境界と認める

以下の条件を**すべて**満たす場合、`EXTRACTOR_REAL_PR=1` の実運用を GitHub Actions 上で行ってよい:

- **(a)** checkout は `persist-credentials: false`(上記ベクタ1の遮断)
- **(b)** clone 先の `.git/config` にトークンを残さない(ベクタ2の遮断)。実装は repos.ts:
  clone 直後に `git remote set-url origin <トークン無しURL>`、fetch は URL を引数渡し(origin 設定に依存しない)
- **(c)** `buildAgentEnv` による agent subprocess への秘密遮断(ベクタ3・実装済み)を維持する
- **(d)** `EXTRACTOR_REAL_PR` は明示 opt-in(既定 dry-run)。初回は監督付き(workflow_dispatch)で実行し、
  生成 PR を人間がレビューしてから 👍 マージする
- **(e)** 認証は当面 **fine-grained PAT**(ADR-0011 の token 暫定): knowledge-base = contents rw + pull requests rw、
  minutes = contents read のみ。GitHub App(§14 #9)発行後に差し替える

### D2. ローカル・常駐での実運用は引き続き ADR-0012 D3 のゲートに従う

本 ADR が緩めるのは「エフェメラル runner 上の夜間バッチ」だけ。開発者ローカルでの実 PR 運用や
常駐プロセス化は、従来どおり ADR-0006 D1(OS/コンテナ FS 隔離)整備後とする。

### D3. リポ名・設定は Actions vars から生成(ハードコード禁止の維持)

`extractor.yaml` は gitignore 済みで CI に存在しないため、workflow が **Actions vars**
(`EXTRACTOR_MINUTES_REPO` / `EXTRACTOR_KB_REPO`)から生成する。リポ名はコードにも workflow にも
ハードコードしない(CLAUDE.md §12.2 を repo 設定側で満たす)。

### D4. GitHub App 発行後は「PR/書き込み=App / clone・読み取り=PAT」の hybrid とする(D1(e) を更新)

GitHub App(§14 #9)を発行したため、**gh-client 経由のすべて**(`createPullRequest` / `commitFiles` /
`mergePullRequest` の書き込みと `getFileContents` 等の API 読み)を **App** に移す。一方 **git clone / fetch**
(リポ内容の取得=検索・抽出の材料)は当面 **fine-grained PAT** を継続する。read=PAT / write=App の hybrid。

- **理由**: App の秘密鍵は git の clone URL には直接使えず、clone を App 化するには installation access token の
  都度発行(`actions/create-github-app-token` 等)が要る。「PR を立てる主体を組織所有(App)にする」目的は
  書き込み側を App にすれば達成でき、clone(読み取り)の PAT 依存は残余リスクが低い(下記)。
- **配線**: env に App trio を設定し、**`GITHUB_TOKEN`(PAT)フォールバックは張らない**。gh-client
  ([auth.ts](../../packages/gh-client/src/auth.ts) `resolveGhAuthFromEnv`)は App trio が揃えば App を使い、
  欠ければ AUTH で fail-loud する(誤って個人 PAT で PR を立てない)。clone の PAT は D1(b) の scrub を継続。
- **App 権限**: knowledge-base = Contents rw + Pull requests rw。minutes は App 不要(PAT で clone のみ)。
- **トレードオフ**: PAT は発行者個人に紐づくが、**clone(読み取り)のみ**に限定される。PR を立てる主体は
  App(組織所有)なので個人非依存。完全な App 化(clone も installation token)は上記1ステップの追加で可能=
  将来の軽い follow-up。gap-tracker / discord-bot も本番デプロイ時に同方針(gh-client=App / clone=PAT)で揃える。

## 影響・トレードオフ

- Phase 2 DoD(2週間運用)へ、GitHub App / コンテナ隔離を待たずに進める。
- エフェメラル runner は完全なジェイルではない(ジョブ内の他ファイル・プロセスは可視)。ただし可視物は
  本ジョブの成果物に限られ、(a)〜(c) で秘密の残留を遮断するため、残余リスクは「knowledge-platform リポ自体の
  内容を agent が読める」程度=既に LLM へ送っている情報と同等と評価する。
- PAT は発行者個人に紐づく(PR 作成者が個人名義になる)。App 発行までの暫定として受容する(ADR-0011 と同判断)。

## 却下した代替案

- **コンテナ FS ジェイル整備まで実運用を延期** → §14 #2/#9 の経営決定待ちで Phase 2 が無期限に閉じない。
  エフェメラル runner + 残留遮断で十分に限定されたリスクと判断。
- **self-hosted runner での実行** → 常駐マシンは可視 FS が広く、エフェメラルより条件が悪い。採らない。

## 検証

- repos.test.ts: clone 後の `remote set-url`(トークン除去)/ fetch の URL 引数渡しをユニットで固定。
- workflow_dispatch の dry-run で config 生成・clone・scrub を確認 → 人間 GO で `EXTRACTOR_REAL_PR=1` の
  監督付き1回 → 生成 PR レビュー → 👍 マージ → 2週間運用(手順は docs/runbooks/extractor-real-run.md)。

## 採択の根拠(2026-07-23 採択)

> ユーザ承認「accept でok / 本番でok」により accepted 化(備考の人間レビュー要件を満たした)。
> 実運用ロールアウト(Phase D)の上流ゲートとして、採択に必要な事実が揃っていることを整理する。

### D1 条件 (a)〜(e) の充足状況

| 条件 | 内容 | 状況 |
|---|---|---|
| (a) | checkout `persist-credentials: false` | ✅ `.github/workflows/extractor-nightly.yml`(ベクタ1遮断) |
| (b) | clone `.git/config` のトークン scrub | ✅ `apps/discord-bot/src/repos.ts`(clone 後 `remote set-url` / fetch は URL 引数渡し)。`repos.test.ts` で固定 |
| (c) | `buildAgentEnv` の秘密遮断 | ✅ 実装済み(PR-6a。ANTHROPIC_*/CLAUDE_*/AWS_* のみ許可) |
| (d) | `EXTRACTOR_REAL_PR` は既定 dry-run・初回監督付き | ✅ `apps/extractor/src/run.ts:398`(dry-run 分岐)+ workflow の `# EXTRACTOR_REAL_PR` コメントアウト |
| (e)→D4 | 認証 = read:PAT / write:App の hybrid | ✅ GitHub App(§14#9)発行済み。`packages/gh-client/src/auth.ts` `resolveGhAuthFromEnv` が App trio 必須・fail-loud |

→ **D1 の技術条件は (a)〜(e) すべて実装済み**。採択の残る作業は人間レビューによる確認のみ。

### 採択と別に扱う「実 PR 開始」の実行時ゲート(Phase D で消化)

- **抽出品質 precision ≥ 0.80**(§11 Phase 2 DoD)は ADR 採択とは別の**実行時ゲート**。監督付き dry-run の
  生成物をサンプル評価して満たすことを確認してから `EXTRACTOR_REAL_PR=1` にする(採択済みでも品質未達なら実 PR は開始しない)。

## design.md 転記リスト(人間レビュー・保護パス — 大半は反映済み)

- **§6.3(L476)**: 「本番・常駐・実 PR は ADR-0013(Actions エフェメラル runner)の実行境界に従う」— **反映済み**。
- **§9.5(L650)**: 「実運用の実行境界は GitHub Actions エフェメラル runner(ADR-0013)」— **反映済み**。
- **§11 Phase 2 DoD(L712)**: 「§6.3 受け入れ条件(precision 80%)+ 2 週間運用で承認フローが回る」は §6.3 経由で
  本 ADR を参照済み(追加編集不要)。read=PAT / write=App の hybrid(D4)は §9.1 の GitHub App 記述に含む。
