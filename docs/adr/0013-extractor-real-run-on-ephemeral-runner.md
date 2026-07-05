# ADR-0013: extractor 実運用の暫定実行境界を GitHub Actions エフェメラル runner とする

- **ステータス**: proposed
- **日付**: 2026-07-05
- **関連**: design.md §6.3(extractor)・§9.1(資格情報)・§9.5(封じ込め)・§11 Phase 2 DoD /
  ADR-0002(データポリシー・accepted)・ADR-0006(FS 封じ込め・proposed)・ADR-0011(auth-agnostic)・
  ADR-0012(実データローカル dry-run 例外・proposed)
- **備考**: 採択(`accepted`)および design.md への転記は人間レビューで行う。GitHub App(§14 #9)発行後は
  認証を App へ差し替える(本 ADR の実行境界の議論はそのまま有効)。

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
