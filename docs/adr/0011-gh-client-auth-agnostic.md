# ADR-0011: gh-client を auth-agnostic(GitHub App / token 両対応・注入式 Octokit)にする

- **ステータス**: proposed
- **日付**: 2026-06-30
- **関連**: design.md §3.2(L3 gh-client)・§6(バッチ群の PR 書き込み)・§9.1(資格情報・最小権限)・§5.1(Octokit) /
  ADR-0004(個人アカウント暫定措置・CI 読みの PAT)・ADR-0008/0009(Claude on AWS 統一)
- **備考**: 採択(`accepted`)および design.md §9.1 への転記は人間レビューで行う。

## 背景

design.md §11 Phase 2(extractor)以降のバッチ群(extractor / gap-tracker / pr-miner / expertise-mapper /
freshness-checker)は **knowledge-base へ PR を書く**ため、共通土台 `gh-client`(L3、GitHub 認証 + Octokit ラッパ +
PR ヘルパ)が必須。design.md §9.1 は本番認証を **GitHub App(PAT 禁止)** と定めるが、現状は個人アカウント運用で
**GitHub App は未発行**(ADR-0004 が個人アカウント暫定措置を規定。CI 間読み取りのみ fine-grained PAT を暫定許可)。

「F0(gh-client)を、認証が未整備でも**ブロックされずに実装・ユニットテストできる**形にする」必要がある。

## 決定

### D1. 認証は auth-agnostic(App / token 両対応)
`GhAuth = {kind:"app", appId, privateKey, installationId} | {kind:"token", token}`。`resolveGhAuthFromEnv` が
App trio(`GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`/`GITHUB_APP_INSTALLATION_ID`)を優先し、無ければ `GITHUB_TOKEN`、
どちらも無ければ `GhClientError("AUTH")`。**本番は GitHub App を正とし**(§9.1)、App 発行までの暫定として token を許す。
これは ADR-0004 の精神(本番 App・暫定は最小権限トークン)を **書き込み経路にも拡張**したもの。

### D2. Octokit は注入 seam(`OctokitLike`)の背後に置く
client.ts は実 SDK に依存せず、消費する REST 部分集合 `OctokitLike` のみに依存する(kb-core `IdCounterStore` /
llm `queryFn` と同趣旨)。`createGhClient(octokit)` に fake を渡してユニットテストし、**鍵・ネットワーク不要**で緑にする。
実生成は `createGhClientFromAuth` / `createGhClientFromEnv`(seam の外で `createOctokit` が App/token に応じ Octokit を作る)。

### D3. 公開操作は consumer が必要とする最小集合に絞る
`createPullRequest`(Git Data API で**複数ファイル1コミットの PR**)/ `listPullRequests`(冪等性=タイトル走査)/
`mergePullRequest`(将来の 👍 自動マージ)/ `getFileContents`(id-allocator CAS)。`putFileContents` 等は consumer が
必要になるまで足さない(extractor は createPullRequest に多ファイルを束ねるため不要)。

### D4. シークレット・リポ名の扱い(§9.1 / §12.2)
秘密鍵・トークンの**値はエラーメッセージ・ログに出さない**。リポジトリ名は**すべて引数**で受け取り、ハードコードしない
(consumer が config/env から渡す)。`@anthropic-ai/*` は import しない(gh-client は GitHub だけ)。

## 影響・トレードオフ

- **利点**: App 未発行でも F0 を完成・テストでき、後続 F1(extractor)を載せられる。テストは鍵不要で決定的。
- App 認証は実機(installation token 取得)でしか完全検証できないため、ユニットは seam(fake)で挙動を固定し、
  **実 PR 作成は GitHub App か書込みトークン用意後に検証**する(認証整備は運用タスク)。
- token を暫定許可する点は §9.1「PAT 禁止」と緊張するが、ADR-0004 と同様 **App 発行までの暫定**であり、
  発行後は App を既定運用にする(token は撤去可能)。

## 検証

- 鍵不要のユニット(fake Octokit)で createPullRequest の Git Data API 順序・list/merge/getContents・auth 解決を検証。
- ゲート緑(typecheck / lint / test)。`rg '@anthropic-ai' packages/gh-client` = 0、リポ名ハードコード無し、秘密ログ無し。
- 実認証(App or token)を用意でき次第、テストリポジトリへ実 PR 作成を1度通して疎通確認する(F1c で実施)。
