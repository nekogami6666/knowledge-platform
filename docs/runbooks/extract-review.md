# Runbook: 抽出品質の人手レビュー(§10.3 / §6.3 受け入れ条件)

extractor のリリース前ゲート。**過去議事録 10 件の抽出結果を人手レビューし、
precision(抽出されたもののうち妥当な割合)>= 0.80** を確認する(recall は初期は問わない)。

## 前提

- Claude on AWS の 4 変数(`CLAUDE_CODE_USE_ANTHROPIC_AWS` / `ANTHROPIC_AWS_API_KEY` /
  `ANTHROPIC_AWS_WORKSPACE_ID` / `AWS_REGION`)。
- minutes リポジトリのローカル clone(例: `apps/extractor/.clones/dev-minutes`)。
- 実議事録を使う根拠は [ADR-0012](../adr/0012-extractor-real-data-local-dry-run-exception.md):
  抽出は `allowedTools: []`(ツール無し)で **D1 の安全経路のみ**。reconcile(agentic Read)は回さない。
  出力(`evals/.review/`)は実内容を含むため **gitignore 済み・コミット禁止・チャットにも貼らない**。

## 手順

```sh
pnpm -r build   # dist を最新化

# 1) 生成: 最新 10 件を抽出しレビュー表を evals/.review/ へ
CLAUDE_CODE_USE_ANTHROPIC_AWS=1 ANTHROPIC_AWS_API_KEY=... \
ANTHROPIC_AWS_WORKSPACE_ID=... AWS_REGION=... \
pnpm --filter @stratum/evals run eval:extract-review generate \
  -- --minutes-dir apps/extractor/.clones/dev-minutes \
     --kb-root apps/extractor/.clones/knowledge-base   # 既存 domain をヒントに使う(任意)

# 2) 人間: evals/.review/*.yaml の各項目の verdict に ok / ng を記入
#    判定基準: 議事録に書かれている内容を正しく抽出しているか(捏造・歪曲・機微情報混入は ng)。
#    ng の理由は note に残す(プロンプト改善の材料になる)。

# 3) 集計: precision を算出(< 0.80 または未記入ありで exit 1)
pnpm --filter @stratum/evals run eval:extract-review score
```

## 合否と記録

- **PASS**: 全項目判定済み + precision >= 0.80 → Phase 2 DoD の品質要件を満たす。
  **数値のみ**(total / ok / ng / perKind / precision)を PR か issue に記録する。内容は貼らない。
- **FAIL**: note に集まった ng 理由を分類し、`prompts/extractor/extract.md` を改善 →
  synthetic before/after(⑱ の手順)で回帰確認 → 再度 generate から。

## 運用後の代理指標(§10.3)

リリース後は「extractor PR のうち**人間が修正してからマージした割合**」を品質の代理指標とする。
運用: 修正してからマージした PR に `edited-before-merge` ラベルを付け、月次で
`gh pr list --label edited-before-merge --state merged` の件数 ÷ 全 extractor PR 数を確認する。
