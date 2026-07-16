# ADR-0008: LLM プロバイダを Claude Platform on AWS にする(Claude Code on AWS)

- **ステータス**: accepted(2026-07-16。ADR-0007 を supersede・全 LLM 呼び出しが本経路で稼働・§5.1/§5.2/§9.1 転記済み)
- **日付**: 2026-06-24
- **関連**: ADR-0007(Amazon Bedrock、誤認)/ ADR-0009(全 AI 操作を Claude on AWS に統一・第一者直叩き撤去)/
  design.md §5.1(ホスティング/Agent SDK)・§5.2(モデル)・§9.1(シークレット)・§14 #2/#3 /
  PR-8a(`feat/bedrock-provider`)・⑪/⑫(統合・構造化出力フォールバック)
- **備考**: 採択(`accepted`)・`docs/design.md`(保護)§5.1/§5.2/§9.1 への転記は人間レビューで行う。

## 背景

ADR-0007 は「Claude on AWS = Amazon Bedrock」と想定したが、これは**誤り**だった。社内の 6/11 打ち合わせ及び
インフラ担当(永田さん)の説明により、利用するのは **Claude Platform on AWS(= "Claude Code on AWS")** —
**Anthropic 運用**・AWS Marketplace 課金・本家と同日パリティのプラットフォーム — であり、AWS 運用の **Amazon Bedrock とは別物**
であることが判明した(担当者本人が「これは Bedrock じゃない」と明言)。

支給された API キー(`AEAA…`、132 字)は **Claude Platform on AWS のワークスペース API キー**であり、壊れていない。
Bedrock として叩いた際の `403 "Invalid API Key format: Must start with pre-defined prefix"` は、Claude Platform on AWS の
キーを Bedrock のエンドポイント/認証フローに投げたために起きた(両者はエンドポイント・認証・IAM 名前空間が別)。
リトライ地獄による 120 秒タイムアウトも全てこの認証失敗の二次症状だった。

### 実機確認(スモークテスト 2026-06-24)
`@anthropic-ai/claude-agent-sdk` の `query()` を下記 env で実行したところ、**403 が消え、約16.6秒で `subtype:"success"` /
`structured_output` populate(`has_structured=true`)/ 出典付きの正しい回答**が返った:
```
CLAUDE_CODE_USE_ANTHROPIC_AWS=1
ANTHROPIC_AWS_API_KEY=<ワークスペース API キー>
ANTHROPIC_AWS_WORKSPACE_ID=wrkspc_…
AWS_REGION=ap-northeast-1
```
→ **Agent SDK は Claude Platform on AWS をサポートし、構造化出力も本家パリティで動く**ことを確認。

## 決定

### D1. LLM プロバイダは Claude Platform on AWS とする
agent 経路(`runAgentSearch`)・将来の単発経路(judge)とも Claude Platform on AWS を既定とする。Bedrock サポートは
コードに残す(provider 切替の退避路)が、本デプロイの採用先は Claude Platform on AWS。

### D2. 有効化は env で行う(`CLAUDE_CODE_USE_ANTHROPIC_AWS`)
- `CLAUDE_CODE_USE_ANTHROPIC_AWS=1` / `ANTHROPIC_AWS_API_KEY`(ワークスペースキー)/ `ANTHROPIC_AWS_WORKSPACE_ID`(必須)/ `AWS_REGION`(必須)。
- **`CLAUDE_CODE_USE_BEDROCK` は外す**(残ると Bedrock が優先され切り替わらない)。

### D3. モデル ID は素の第一者 ID(`anthropic.` 接頭辞なし)
Claude Platform on AWS は本家パリティのため `claude-sonnet-4-6` / `claude-opus-4-8` をそのまま使う。
`modelIdFor` は `CLAUDE_CODE_USE_BEDROCK` 未設定時に素 ID を返すため**変更不要**(Bedrock 用 `anthropic.` 接頭辞は Bedrock 時のみ)。
→ 6/11 で諦めた **Opus 4.8 も当日から利用可能**(あの制約は Bedrock 固有だった)。

### D4. agent subprocess への env 透過は既存の許可リストで足りる
`buildAgentEnv`(PR-6a)は `ANTHROPIC_` / `CLAUDE_` / `AWS_` 接頭辞を通す。Claude Platform on AWS の4変数はすべてこれに該当するため**変更不要**。

### D5. シークレット(§9.1)
`ANTHROPIC_AWS_API_KEY` は秘密。`env.ts` で受け取り、logger の値スクラブ対象に追加。`ANTHROPIC_API_KEY` 必須要件は
Claude Platform on AWS 有効時も解除する(`env.ts` superRefine)。

## 影響・トレードオフ

- Bedrock 固有だった制約(自動プロンプトキャッシュ無し・server tools 無し・旧モデルIDの inference profile 等)は**該当しない**(本家パリティ)。
- ⑫ の `extractStructured`(result テキストからの JSON フォールバック)は Claude Platform on AWS では不要(structured_output が入る)だが、
  プロバイダ非依存の保険として残す。
- ADR-0002(データポリシー):処理主体は Anthropic 運用(AWS 認証/課金経由)。本物データを扱う前にポリシー再確認(人間)。
- 必須値(workspace ID・region)が無いと起動できない。シートにはキーのみだったため別途取得した。

## 検証

- 鍵不要のユニット/統合(全モック)は緑(env の Claude Platform on AWS relax を含む)。
- 実機:上記 env でスモーク成功済み。bot を同 env で起動し、テストサーバーで §6.2 AC1/AC2/AC3 を手動確認する。
