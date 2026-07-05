# Runbook: extractor 実運用の開始(実 PR・ADR-0013)

extractor が **実 PR** を knowledge-base に出す運用を始めるための手順。実行境界は
GitHub Actions のエフェメラル runner([ADR-0013](../adr/0013-extractor-real-run-on-ephemeral-runner.md)、
条件: persist-credentials:false / clone トークン scrub / buildAgentEnv 遮断 / 明示 opt-in)。

## 0. 前提

- [ ] ADR-0013 が人間レビューで accepted になっている
- [ ] 抽出品質の人手評価(docs/runbooks/extract-review.md)で **precision >= 0.80** を確認済み(Phase 2 DoD)
- [ ] knowledge-base に validate CI(スキーマ検証)が付いている(§6.1・ADR-0004 D2 の構造ガード)

## 1. fine-grained PAT の発行(人間・ADR-0013 D1(e))

GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token:

- **名前**: `stratum-extractor-interim`(App 発行後に revoke する前提の命名)
- **有効期限**: 90 日以内(短め推奨。切れたら再発行)
- **Repository access**: 対象2リポのみ選択(minutes リポ + knowledge-base リポ)
- **Permissions**:
  - knowledge-base: **Contents: Read and write** / **Pull requests: Read and write**
  - minutes: **Contents: Read-only**
  - それ以外は付けない(§9.1 最小権限)

## 2. Actions secrets / vars の投入(人間・knowledge-platform リポの Settings)

| 種別 | 名前 | 値 |
|---|---|---|
| secret | `ANTHROPIC_AWS_API_KEY` / `ANTHROPIC_AWS_WORKSPACE_ID` / `AWS_REGION` | Claude on AWS の実値 |
| secret | `EXTRACTOR_PAT` | 手順1の PAT |
| secret | `DISCORD_OPS_WEBHOOK` | #stratum-ops の webhook URL(任意だが 👍 マージ導線に必要) |
| var | `EXTRACTOR_MINUTES_REPO` | `org/minutes` 形式の実リポ名 |
| var | `EXTRACTOR_KB_REPO` | `org/knowledge-base` 形式の実リポ名 |

## 3. bot 側の準備(👍 代理マージ・C1 拡張)

- [ ] **Discord Developer Portal** → Bot → Privileged Gateway Intents → **Message Content Intent を ON**
      (webhook 通知の本文から PR URL を読むため。100 サーバ未満は審査なしで有効化可)
- [ ] bot の実行環境に `apps/discord-bot/config/ops.yaml` を配置(ops.yaml.example 参照):
      `channel_id`(#stratum-ops の ID)+ `kb_repo`(knowledge-base の org/name)
- [ ] bot の env に `GITHUB_TOKEN`(手順1の PAT)を追加 → bot 再起動
- [ ] 起動ログの `config loaded` に `proxyMerge: true` が出ることを確認

## 4. 初回の監督付き実行(ADR-0013 D1(d))

1. **dry-run 確認**: Actions → extractor-nightly → Run workflow(EXTRACTOR_REAL_PR はコメントのまま)。
   ログで (a) extractor.yaml 生成、(b) clone 成功、(c) `dry-run: 実 PR は作成しません` と抽出サマリ
   (候補数 / 新設 domain / timings)を確認。
2. **実 PR を1回**: workflow の `# EXTRACTOR_REAL_PR: "1"` のコメントを外して commit(または一時的に
   workflow_dispatch 用に env を付けた実行)→ Run workflow。
3. 生成された knowledge-base の PR を人間がレビュー(§6.3: 新規/追記/矛盾のサマリ + 近接 domain 警告)。
4. #stratum-ops の通知に **👍** → bot が squash マージすることを確認(✅ reply + validate 緑が前提)。
5. 問題なければ schedule(毎晩 03:00 JST)に任せ、**2週間の運用**で承認フローが回ることを確認(Phase 2 DoD)。

## 5. ロールバック / 停止

- **PR 単位**: knowledge-base 側で Revert PR(通常の GitHub 操作)。
- **運用停止**: workflow の `EXTRACTOR_REAL_PR` を再コメントアウト(dry-run に戻る)。緊急時は
  Actions → extractor-nightly → Disable workflow。
- **鍵漏洩疑い**: PAT を即 revoke(fine-grained なので影響は2リポに限定)。

## 6. 品質の継続観測(§10.3)

- 人間が**修正してからマージした** extractor PR に `edited-before-merge` ラベルを付ける。
- 月次で `修正マージ率 = edited-before-merge 数 ÷ extractor PR 総数` を確認し、悪化したら
  extract-review(過去10件評価)を再実施してプロンプトを改善する。

## GitHub App への移行(§14 #9 決定後)

App 発行・組織インストール後: secrets に `GH_APP_ID` / `GH_APP_PRIVATE_KEY` / `GH_APP_INSTALLATION_ID` を
投入(App trio は PAT より優先される・ADR-0011)→ 動作確認 → `EXTRACTOR_PAT` を削除し PAT を revoke。
コード変更は不要。
