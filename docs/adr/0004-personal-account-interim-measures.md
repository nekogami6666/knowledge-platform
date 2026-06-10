# ADR-0004: 個人アカウント運用に伴う暫定措置

- **ステータス**: proposed
- **日付**: 2026-06-10
- **関連**: design.md §9.1(認証情報)・§10.1(CI)・§11 Phase 0/Phase 2 / ADR-0001
- **備考**: GitHub Organization(Team プラン)へ移行する前の、個人アカウント運用に起因する制約への
  暫定措置を記録する。本 ADR は design.md §9.1 の本番方針を変更するものではなく、移行までの
  期間限定の運用例外を明文化し、解消条件を固定するためのもの。採択は人間レビューで行う。

## 背景

design.md は本番アプリの認証を GitHub App・最小権限で行う前提(§9.1)で書かれており、CI による
スキーマ検証(§10.1)は knowledge-base 側で knowledge-platform のコード(`kb-core` 等)を参照
する構成を想定している。一方、現時点ではプロジェクトが GitHub 個人アカウントで運用されており、
以下の制約がある:

1. GitHub App による CI 間アクセスの整備は Phase 2(`gh-client` 実装)まで行われない。それ以前の
   knowledge-base CI が knowledge-platform を読む手段が必要。
2. GitHub 個人プランではプライベートリポジトリにブランチ保護ルールを強制できない(Team/Enterprise
   プランの機能)。design.md が暗黙に前提とする「validate が通らない PR はマージ不可」を技術的に
   強制できない。

これらは設計の本質を変えるものではなく、Organization 移行までの一時的な運用ギャップである。
ギャップを放置せず、暫定措置とその解消条件を本 ADR で固定する。

## 決定

### D1. CI 間読み取りは fine-grained PAT を暫定使用する

knowledge-base の CI から knowledge-platform を読み取る用途に限り、fine-grained Personal Access
Token を使用する。トークンの権限は以下に最小化する:

- **権限**: `Contents: read-only` のみ
- **対象**: knowledge-platform リポジトリ 1 つのみ(他リポジトリへのアクセスを付与しない)
- **保管**: knowledge-base の GitHub Actions secrets。ログ出力禁止(§9.1, §12.2)
- **有効期限**: 短期(例: 90 日)を設定し、失効時は再発行する

design.md §9.1 の「**PAT 禁止**・GitHub App」は**本番アプリ**(discord-bot 等が knowledge-base を
読み書きする経路)の方針であり、本 D1 はそれを覆さない。本 D1 が対象とするのは CI 間の読み取り
専用経路に限定される。

**解消条件**: Phase 2 の `gh-client` 実装時に、この CI 間読み取りを GitHub App 認証へ統一し、
PAT を失効させる。統一完了をもって D1 は失効する。

### D2. ブランチ保護は運用ルールで代替する

ブランチ保護を技術的に強制できない間、以下を**運用ルール**として遵守する:

- **「validate(CI スキーマ検証)が赤い PR はマージしない」** を全メンバーの運用ルールとする。
- PR は CI 結果を確認したうえで人間がマージする(§9.1 の最小権限・人間承認の精神を運用で担保)。
- このルールは design.md §10.1 の CI(lint → typecheck → unit test → KB スキーマ検証)の結果に
  対して適用する。

**解消条件**: Organization(GitHub Team プラン)へ移行し、knowledge-platform・knowledge-base 両
リポジトリに必須ステータスチェック付きのブランチ保護を設定した時点で D2 は失効し、技術的強制へ
切り替える。**移行の判断は経営マター**であり、本 ADR は移行を求めるものではなく、移行までの
暫定運用を定めるに留まる。

## 影響

- 個人アカウント段階でも CI スキーマ検証(Phase 0 DoD の前提)を回せる。
- 暫定措置は期間限定であり、D1 は Phase 2、D2 は Organization 移行で解消される。解消されるまでは
  本 ADR が design.md §9.1 に対する明示的な例外の根拠となる。
- D2 は技術的強制ではなく人間の規律に依存するため、ルール逸脱のリスクが残る。逸脱を減らすため、
  CLAUDE.md の鉄則(§12.2 相当)にも「validate が赤い PR はマージしない」を併記することが望ましい。

## 却下した代替案

- D1 で従来型 PAT(classic、リポジトリ全体スコープ)を使う案 → 権限が過大で対象を 1 リポジトリに
  絞れないため却下。fine-grained PAT で最小権限化する。
- D1 で Phase 2 を待たず即座に GitHub App を整備する案 → `gh-client` 未実装の段階で App 認証基盤を
  先行構築するのは Phase 計画(§11, §12.3)に反し、二重実装になるため却下。
- D2 で個人プランのまま擬似的なマージ制限スクリプトを作り込む案 → 強制力が中途半端で保守コストに
  見合わず、Organization 移行で不要になるため却下。運用ルール + CLAUDE.md 明記で代替する。
