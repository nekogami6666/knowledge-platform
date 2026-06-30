# ADR-0009: 全 AI 操作を Claude on AWS に統一(第一者直叩きを撤去・judge も Agent SDK へ)

- **ステータス**: proposed
- **日付**: 2026-06-29
- **関連**: ADR-0008(Claude Platform on AWS を LLM プロバイダに採用)/ ADR-0007(Amazon Bedrock、誤認・superseded)/
  design.md §5.1(LLM の単発/agentic 経路)・§5.2(モデル)・§9.1(シークレット)・§10.2(golden eval)/
  ⑮(本プラン)
- **備考**: 採択(`accepted`)・`docs/design.md`(保護)§5.1/§5.2/§9.1 への転記は人間レビューで行う。

## 背景

ADR-0008 で LLM プロバイダを **Claude on AWS(Claude Code on AWS / Claude Platform on AWS)** に確定し、
bot の Q&A(`runAgentSearch`・Agent SDK 経路)は Claude on AWS で実稼働した(テストサーバーで §6.2 AC1/AC2 成功・
golden 出典一致 10/10)。

しかし golden eval の **回答妥当性採点(LLM-as-judge、§10.2(b))だけが第一者 API 直叩き**のまま残っていた:

- `packages/llm/src/messages.ts` が `@anthropic-ai/sdk`(`new Anthropic()` → `messages.create`)を使う単発経路で、
  `ANTHROPIC_API_KEY` を要求する。judge(`evals/src/judge.ts`)が唯一の利用者。
- Claude on AWS 環境(`ANTHROPIC_API_KEY` 不在)では judge が毎回失敗し、`run-qa.ts` の per-question try/catch が
  level 0 に握りつぶす → **validity は実質「死に指標」**になっていた(integration テストでも provider 条件で skip)。

「AI を使う操作はすべて、今動いている Claude on AWS に統一する」というユーザ決定により、**第一者直叩きを撤去し、
judge も Claude on AWS(Agent SDK)に載せ替える**。

## 決定

### D1. すべての AI 呼び出しを Claude on AWS(Agent SDK `runAgentSearch`)経由に統一する
Q&A(bot)・judge(eval)とも `runAgentSearch` を使う。LLM プロバイダは Claude on AWS の **1 本**に固定し、
プロバイダ切替の抽象(`resolveProvider` / `LlmProvider`)は撤去する。

### D2. 第一者直叩き(`@anthropic-ai/sdk`)を全削除する
- `packages/llm/src/messages.ts` / `messages.test.ts`(`generateStructured` ほか)を削除。
- `packages/llm/package.json` から `@anthropic-ai/sdk` 依存を削除。
- `packages/llm` の公開バレルから `generateStructured` 系・`resolveProvider` / `LlmProvider` の re-export を削除。
- これにより `@anthropic-ai/sdk` の import は **リポジトリから消滅**する(`@anthropic-ai/claude-agent-sdk` のみ残る)。

### D3. judge を `runAgentSearch`(ツール無し単発)で実装する
`evals/src/judge.ts` の transport を `generateStructured` → `runAgentSearch` に差し替える:
- `role: deep`(prompt frontmatter 駆動)・`outputSchema: judgeVerdictSchema`(0/1/2 + reasoning)。
- **`allowedTools: []`**(ツール無し)。judge は採点のみでファイル探索しないため、ツールを一切与えない。
  これにより被評価 answer に注入があっても **読み取り/実行能力を持たない**(§9.5、blast radius = 0)。
- `cwd` は実体不要だが `runAgentSearch` が要求するため OS の一時ディレクトリ(`os.tmpdir()`)を渡す。
- `maxTurns: 3`(ツール無しなら 1 ターンで verdict。暴走防止の上限のみ)。
- 注入テスト容易性のための seam(`generate` → `search`)は維持する。
- 新依存(`@anthropic-ai/aws-sdk` の `AnthropicAws`)・新認証は導入しない(実証済みの Agent SDK 経路を再利用)。

### D4. validity(回答妥当性)を Claude on AWS で復活させる
- `run-qa.integration.test.ts`: 認証ゲートを `ANTHROPIC_AWS_API_KEY` に統一し、provider 条件付き skip を撤去。
  出典一致(§6.2 AC1)に加え **`validity.counts.bad <= 2`(soft)を常時アサート**する。
- `.github/workflows/weekly-eval.yml`: secrets を Claude on AWS(`CLAUDE_CODE_USE_ANTHROPIC_AWS` /
  `ANTHROPIC_AWS_API_KEY` / `ANTHROPIC_AWS_WORKSPACE_ID` / `AWS_REGION`)に変更。

### D5. bot の env を Claude on AWS 必須にする(§9.1)
`apps/discord-bot/src/env.ts` から `ANTHROPIC_API_KEY` を削除し、Claude on AWS の 4 変数
(`CLAUDE_CODE_USE_ANTHROPIC_AWS`=必須かつ "1"/"true"、`ANTHROPIC_AWS_API_KEY`、`ANTHROPIC_AWS_WORKSPACE_ID`、
`AWS_REGION`)を必須にする。logger の値スクラブ・キー名リダクト対象を `ANTHROPIC_AWS_API_KEY` に統一する。

## 影響・トレードオフ

- **利点**: AI 経路が 1 本になり、認証・モデルID・構造化出力の挙動が bot と eval で完全一致。プロバイダ分岐の
  デッドコードが消え、validity が実測値として戻る(golden の二指標が両方生きる)。
- judge が Agent SDK のサブプロセス(+ ripgrep 等)を起動するコストは増えるが、週次 + ローカルのみで頻度は低い。
- `generateStructured`(単発 Messages)を再利用予定だった Phase 2 の extractor も、今後は `runAgentSearch`
  (必要なら `allowedTools:[]`)で実装する方針に倒す。第一者 single-shot が必要になったら ADR で別途復活させる。
- `maxTurns:3`・`allowedTools:[]` で verdict が安定して返ることは実機(鍵付き golden)で確認する。万一 no-tools
  単発で不調なら、フォールバックとして `packages/llm` に `@anthropic-ai/aws-sdk`(`AnthropicAws`)単発ラッパを
  置く(本 ADR では採用しない)。

## 検証

- 鍵不要のユニット/統合(全モック)は緑(judge の search seam・env の Claude on AWS 必須化・logger を含む)。
- `rg -i '@anthropic-ai/sdk'` がリポジトリで **0 件**(第一者直叩きの撤去を確認)。
- 鍵付き golden(Claude on AWS)で **出典一致 passCount>=8(目標 10/10)+ validity.counts.bad<=2** を確認する
  (judge が Claude on AWS で動くことの実機証明)。ADR-0002: コーパスは synthetic のみ。
