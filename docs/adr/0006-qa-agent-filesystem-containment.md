# ADR-0006: Q&A エージェントのファイルシステム封じ込め(cwd は境界でない)

- **ステータス**: proposed
- **日付**: 2026-06-17
- **関連**: design.md §9.5(プロンプトインジェクション耐性)・§6.2(Q&A Bot)・§5.1(Agent SDK)/
  ADR-0005 / PR-2(`packages/llm` の `agent.ts`)
- **備考**: PR-2 の敵対的レビューで判明した「design.md §9.5 の封じ込め前提」と「Agent SDK 0.3.179 の
  実挙動」の乖離を記録する。採択(`accepted`)は人間レビューで行う。`docs/design.md` は保護パスのため、
  §9.5 への補足転記は人間レビューで行う。

## 背景

design.md §9.5 は Q&A エージェントの許可ツールを Read/Grep/Glob に限定し、「文書内に指示が混入しても
**実行能力がない**」ことを封じ込めの根拠としている。しかし `@anthropic-ai/claude-agent-sdk@0.3.179` の
実型・JSDoc を確認した結果、この前提は不完全であることが分かった:

- `cwd`(sdk.d.ts:1358)は「セッションの作業ディレクトリ(既定 `process.cwd()`)」にすぎず、
  **Read/Grep/Glob の到達範囲を縛らない**。
- ツールのリスト制限は「サンドボックスではない。ファイルはディスク上に残り Read/Bash で到達可能」と
  SDK 自身が明記(sdk.d.ts:1894 付近)。
- `permissionMode:"dontAsk"` + `allowedTools:[Read,Grep,Glob]` では Read が**事前承認**されているため、
  cwd 外の絶対パス(`~/.ssh`、`/proc/self/environ`、兄弟 clone 等)も**プロンプトなしで読める**。
- 読み取った内容は `structured_output`(回答本文)に載るため、untrusted な議事録/リポジトリ内の
  プロンプトインジェクションが**任意ホストファイルの漏洩チャネル**になりうる。

したがって §9.5 の「Read/Grep/Glob 限定 = 実行能力なし」は、**Read 自体が読み取り能力**であるため
封じ込めとして不完全である。

## 決定

### D1. 封じ込めは deploy 層(OS/コンテナ FS サンドボックス)で担保する

本番(Phase 1b)では discord-bot プロセスを、**可視ファイルが clones(minutes / knowledge-base /
対象開発リポ)に限定された OS/コンテナの FS サンドボックス**内で実行する。これを Phase 1b デプロイ
(PR-6)の**必須要件**とする(Fly.io / 社内 Docker いずれでも、コンテナ FS・read-only マウント・
bind 範囲限定などで実現)。

### D2. コード側は cwd を境界と誤認させない

`packages/llm/src/agent.ts` のヘッダに「cwd は封じ込め境界ではない/本番は OS サンドボックス必須」を
明記する(実施済み)。`runAgentSearch` は引き続き `permissionMode:"dontAsk"` + `allowedTools` 限定 +
`settingSources:[]` + `disallowedTools` を保ち、`mcpServers`/`agents`/`hooks`/`canUseTool`/
`toolAliases`/`additionalDirectories` を未設定に維持する(多層防御の一層)。

### D3. Phase 1a は synthetic データに限定して進める(ADR-0002 と整合)

Phase 1a(ローカル MVP)は synthetic な minutes / knowledge-base に対してのみ /ask を実行する。
本物の社内データへの /ask は Phase 1b(OS サンドボックス整備後)に行う。

### D4. SDK レベルの permission deny は将来の defense-in-depth として別途評価

SDK の `settings`/`managedSettings` の `permissions.deny` で Read/Grep/Glob を clone root に制限する案は、
ルール構文の正しさ検証が必要で、誤れば「偽の安心」を生む。本 ADR では必須とせず、OS 隔離(D1)を主と
し、SDK deny は将来の追加層として別 ADR で評価する。

## 影響

- §9.5 の封じ込め根拠を「ツール限定のみ」から「ツール限定 + deploy 層 FS 隔離」に補強する必要がある
  (design.md §9.5 への転記は人間が行う)。
- Phase 1b のデプロイ(PR-6)に「FS サンドボックス必須」要件が追加される。
- Phase 1a の機能・テストは影響を受けない(synthetic データ + モックで検証)。

## 実装状況(PR-6 で更新)

- **D2(env 絞り込み)= PR-6a で実装済み**: `runAgentSearch` が `Options.env = buildAgentEnv()` を設定し、
  subprocess へ DISCORD_TOKEN 等の秘密を渡さない(`/proc/self/environ` 経由のトークン漏洩ベクタを遮断)。
  許可リスト + `ANTHROPIC_`/`CLAUDE_` 接頭辞のみ通す。**ただしこれは部分対策**(任意ファイル読み取り自体は
  依然可能)で、本丸の封じ込めは D1 の OS/コンテナ FS サンドボックスに依存する。
- **D1(FS サンドボックス)= PR-6c で方針提示・host 選定後に実現**: PR-6c はホスト非依存の最小イメージ +
  非 root + read-only root + `/data`(rw)・`/config`(ro)・clones のみ、という**方針**を `docs/deploy/README.md`
  に明記する。単一コンテナでは agent が bot と FS を共有するため、clones だけに限定する真のプロセス FS
  ジェイル(landlock / bubblewrap / 別サンドボックス subprocess)は **host 選定(§14 #2)後の follow-up**。
- status は **proposed のまま**(accepted は人間レビュー)。design.md §9.5 への転記も人間が行う。

## 却下した代替案

- **cwd を境界として信頼する(現状の暗黙前提)** → SDK の実挙動と矛盾し漏洩経路が残るため却下。
- **SDK `permissions.deny` だけで封じ込める** → ルール構文の検証コストと誤設定リスク(偽の安心)が高く、
  OS 隔離ほど堅くない。将来の追加層に留める(D4)。
- **許可ツールから Read を外す** → Q&A の agentic search が成立しない(Grep/Glob だけでは内容を読めない)
  ため却下。
