# ADR-0007: LLM プロバイダを Amazon Bedrock にする(Claude on AWS)

- **ステータス**: superseded by ADR-0008(2026-06-24。実際の調達は Amazon Bedrock ではなく Claude Platform on AWS だった。Bedrock 用コード/設定は削除済み)
- **日付**: 2026-06-23
- **関連**: design.md §5.1(ホスティング/Agent SDK)・§5.2(モデル選定)・§9.1(シークレット)・§14 #2/#3 /
  ADR-0002(データポリシー)・ADR-0006(FS 封じ込め)・PR-1/PR-2(`packages/llm`)・PR-6a(`buildAgentEnv`)
- **備考**: ホスティング(§14 #2)が **AWS** に確定し、LLM も **Amazon Bedrock 経由の Claude** を使う方針となった
  ことを記録する。採択(`accepted`)・`docs/design.md`(保護パス)§5.1/§5.2/§9.1 への転記は人間レビューで行う。

## 背景

現状の実装は **Anthropic 第一者 API 直叩き**を前提にしている:

- 単発呼び出し([packages/llm/src/messages.ts](../../packages/llm/src/messages.ts))は `@anthropic-ai/sdk` の `Anthropic` クライアント。
- agentic search([packages/llm/src/agent.ts](../../packages/llm/src/agent.ts))は `@anthropic-ai/claude-agent-sdk` の `query()`。
- 認証は `ANTHROPIC_API_KEY`(env、§9.1)。モデルIDは第一者形式(`claude-opus-4-8` 等、[models.ts](../../packages/llm/src/models.ts))。

「Claude on AWS」には **Amazon Bedrock**(AWS 運用・partner)と **Claude Platform on AWS**(Anthropic 運用)の
2種があり、本プロジェクトは **Amazon Bedrock** を採用する。Bedrock はクライアント・モデルID・認証が第一者と異なる。

## 決定

### D1. `packages/llm` をプロバイダ切替可能にする(env 駆動)

LLM 呼び出しは引き続き **`packages/llm` 経由のみ**・`@anthropic-ai/*` の import は **`packages/llm` 内のみ**(CLAUDE.md 鉄則維持)。
プロバイダは env(`CLAUDE_CODE_USE_BEDROCK` 系のフラグ + `AWS_REGION`)で `bedrock | anthropic` を切り替える。
利用側(discord-bot / evals)はプロバイダを意識しない。

### D2. 単発呼び出しは Bedrock Mantle クライアントを使う(messages.ts)

`@anthropic-ai/sdk` の代わりに **`@anthropic-ai/bedrock-sdk` の `AnthropicBedrockMantle({ awsRegion })`**(Messages API 版)を使う。
`AnthropicBedrock` 無印は旧 InvokeModel 経路のため使わない。`messages.create` + **`output_config.format`(構造化出力)は Bedrock 対応**
のためそのまま使える。新依存 `@anthropic-ai/bedrock-sdk` は **`packages/llm` の dependency** とする(import は packages/llm 内のみ)。

### D3. agentic search を Bedrock に向ける + agent env に AWS を通す(agent.ts / PR-6a)

Agent SDK は **`CLAUDE_CODE_USE_BEDROCK=1` + AWS 認証情報 + `AWS_REGION`** で Bedrock を使う(`ANTHROPIC_API_KEY` 不要)。
⚠️ **PR-6a の `buildAgentEnv` は現状 `AWS_*` を subprocess に通していない**(許可リストは固定セット + `ANTHROPIC_`/`CLAUDE_` 接頭辞のみ)。
Bedrock では agent subprocess が Bedrock に認証できるよう、**`AWS_` 接頭辞を許可リストに追加**する
(`AWS_REGION`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`/`AWS_PROFILE`/`AWS_CONTAINER_CREDENTIALS_*` 等)。
`CLAUDE_CODE_USE_BEDROCK` は既存の `CLAUDE_` 接頭辞で通る。

### D4. モデルIDをプロバイダ対応にする(models.ts)

`modelIdFor(role)` を **プロバイダ対応**にする。Bedrock 時は `anthropic.` 接頭辞付き
(`anthropic.claude-opus-4-8` / `anthropic.claude-sonnet-4-6` / `anthropic.claude-haiku-4-5`)。
モデルID直書き禁止(§5.2 鉄則)は維持し、対応表は `MODELS` で一元管理する。

### D5. 認証・シークレット(env.ts / §9.1)

Bedrock では `ANTHROPIC_API_KEY` 不要。AWS 標準クレデンシャルチェーン:
- **本番(ECS/Fargate)**= IAM **タスクロール**(静的キーをイメージ・env に置かない)。
- **ローカル検証** = `AWS_*` env または共有プロファイル。
`env.ts` のスキーマを **プロバイダ条件付き**にする(Bedrock 時 `ANTHROPIC_API_KEY` を必須から外す)。
AWS クレデンシャルも **ログ出力禁止**(§9.1。logger の値スクラブ対象に含める)。

### D6. デプロイ(ADR-0006 連動)

デプロイ先は **ECS/Fargate**。タスクロールに **Bedrock の InvokeModel 相当権限**(Mantle: `bedrock-mantle:*` / 旧: `bedrock:InvokeModel`)を付与し、
`AWS_REGION` を設定する。FS サンドボックス方針(ADR-0006: 非 root・read-only root・clones 限定)は不変。

## 影響・トレードオフ

- **Bedrock の機能制約**(platform-availability):自動プロンプトキャッシュ・server-side tools(web search/fetch/code execution)・
  Files/Batches/Models API は **Bedrock 非対応**。本 bot は agent の **Read/Grep/Glob(client-side)** + 単発 `messages.create` のみ使うため**影響は限定的**。
- **§14 #3 予算**は Bedrock の課金・クォータ(既定 2M input TPM)に基づく。
- **ADR-0002(データポリシー)**:データ処理主体が Anthropic 第一者 → AWS/Bedrock に変わる。Phase 1a が synthetic のみである点は不変だが、
  本物データを扱う前に **Bedrock のデータ取扱いでポリシーを再確認**(人間)。
- 第一者 API のままにしたい開発者向けに D1 のプロバイダ切替を残す(ローカルで鍵だけで動かせる退避路)。

## 実装上の確定事項(2026-06-23・公式/裏取り)

- **認証=Bedrock API キー(ベアラトークン、`AWS_BEARER_TOKEN_BEDROCK`)**。社内から渡されたのはこの単一キー。
  SigV4 のアクセスキーペアではない。
- **bot の /ask は Agent SDK 経路のみ**を使う(`generateStructured`/messages.ts を import するのは `evals/judge.ts` だけ。
  ask.ts/index.ts/qa-search.ts は judge 不使用=確認済み)。**Agent SDK はベアラ対応**(`AWS_BEARER_TOKEN_BEDROCK` +
  `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_REGION`)。→ **この1個のキーで bot は稼働できる**。
- **judge(messages.ts / `@anthropic-ai/bedrock-sdk`)はベアラをネイティブ非対応**(裏取り)。これは **eval の妥当性採点専用**で
  bot 稼働には不要。Bedrock 対応は **PR-8b**(標準 Anthropic クライアント + `baseURL`+ベアラの回避策、または SigV4 キー)として分離。
- **`buildAgentEnv`**:`CLAUDE_CODE_USE_BEDROCK` は既存 `CLAUDE_` 接頭辞で通るが **`AWS_REGION`/`AWS_BEARER_TOKEN_BEDROCK` は通らない**
  → **`AWS_` 接頭辞を許可リストに追加**(D3)。`AWS_BEARER_TOKEN_BEDROCK` は秘密 → logger の値スクラブ対象に追加(§9.1)。
- **モデルIDはリージョン依存**:Bedrock は `anthropic.claude-…` の他に**地域 inference profile**(`us.anthropic.claude-…` 等)を
  要求する場合がある。`modelIdFor` の Bedrock 値は **env で上書き可能**にし(既定 `anthropic.<base>`)、コード改変なしに調整できるようにする(D4)。
- **モデルアクセス**:Bedrock コンソールで **Anthropic モデルの利用申請**(リージョン単位・一度)が必要。

### 分割
- **PR-8a(bot 稼働の最小)**:agent 経路の Bedrock 化 — `buildAgentEnv` の `AWS_` 追加 / `modelIdFor` の Bedrock 値(env 上書き可)/
  `env.ts` を provider 条件付き(Bedrock 時 `ANTHROPIC_API_KEY` 任意)+ `AWS_BEARER_TOKEN_BEDROCK` スクラブ。**これで bot + golden 出典一致が動く**。
- **PR-8b(eval 妥当性)**:judge(messages.ts)の Bedrock 対応。bot 稼働後でよい。

## 検証

- 鍵不要のユニット/統合(全モック)は従来どおり緑(provider 判定・`buildAgentEnv` の `AWS_` 通過・`modelIdFor` の Bedrock 値を単体で検証)。
- **Bedrock API キー付き**で手動 /ask と golden eval([run-qa.integration.test.ts](../../evals/src/run-qa.integration.test.ts))を
  **Bedrock 経由**で実走し、出典一致 ≥8/10(§6.2 AC1)と agent が壊れないこと(PR-6a R1)を確認する。モデルID形式(地域 profile 要否)はここで確定。
