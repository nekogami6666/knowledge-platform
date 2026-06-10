# CLAUDE.md

社内ナレッジ管理プラットフォーム(`stratum`)のコード側モノレポ。ナレッジデータ本体は
別リポジトリ `knowledge-base` にあり、本リポジトリのアプリ群が PR 経由で読み書きする。

**設計の唯一の正は `docs/design.md`**。着手前に §2(設計原則)と該当コンポーネントの
§6、関連 ADR(`docs/adr/`)を読む。プロセス規約の全文は §12。
設計と実装が食い違う場合、実装を進めず人間に確認を求める。
アーキテクチャ変更はコードより先に ADR ドラフトを書く。

## コマンド

```sh
pnpm install / pnpm typecheck / pnpm lint / pnpm test / pnpm build
pnpm --filter @stratum/kb-core typecheck   # 単一パッケージ
pnpm vitest run packages/kb-core/src/foo.test.ts   # 単一テスト(全体実行を避ける)
```

## 構成

- `packages/kb-core` — zod スキーマ・frontmatter I/O・provenance。**型の唯一の正**
- `packages/llm` — モデル設定(`models.ts`)・プロンプトローダ・リトライ/コスト記録
- `packages/gh-client` — GitHub App 認証・Octokit ラッパ
- `apps/` — discord-bot のみ常駐、他は GitHub Actions cron バッチ。責務と受け入れ条件は design.md §6

## 鉄則(YOU MUST)

- LLM 呼び出しは `packages/llm` 経由のみ。`@anthropic-ai/sdk` の直接 import は packages/llm 内だけ
- knowledge-base の読み書きは `kb-core` 経由のみ(gray-matter / fs 直叩き禁止)
- モデル ID・プロンプト・チャンネル ID・リポジトリ名のハードコード禁止
- zod スキーマの変更は kb-core から。利用側で型を再定義しない
- シークレットの直書き・ログ出力禁止
- conventional commits / 1 機能 1 PR(400 行目安)/ design.md §11 の表の行単位で進める
- design.md §1.3 の非目標(ベクトル DB 等)を実装提案しない
