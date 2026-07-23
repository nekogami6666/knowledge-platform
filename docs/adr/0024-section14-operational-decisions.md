# ADR-0024: design.md §14 運用未決事項の決定(#3 予算 / #5 pr-miner 対象 / #8 members / #9 Org)

- **ステータス**: accepted(2026-07-23 人間承認)
- **日付**: 2026-07-23
- **関連**: design.md §14(運用上の未決事項)・§7.3(コスト記録)/ ADR-0016(ホスティング=§14#2)/
  ADR-0017・0021・0022(members 単一ソース)/ ADR-0013 D4(GitHub App=write / PAT=clone の hybrid)/
  `.github/workflows/{extractor-nightly,pr-miner-weekly,expertise-weekly}.yml`
- **備考**: 採択済み(人間承認)。design.md §14 表への転記は人間タスクとして残る。

## 背景

design.md §14 は運用開始前に人間・経営が決める未決事項を列挙する。本セッションで #3/#5/#8/#9 を確定した
(#1 STT=ADR-0015、#2 ホスティング=ADR-0016、#4 チャンネル=ADR-0018 は既決)。

## 決定

### D1. 月次 API 予算上限(§14#3)= 2〜3 万円 / 月

- LLM(Claude on AWS + STT の OpenAI)の月次コスト上限を **¥20,000〜30,000** とする。
- 監視: §7.3 の通り `packages/llm` がトークンをアプリ別・ロール別に記録し、バッチは週次サマリを
  #stratum-ops へ出す。自動遮断は未実装のため、当面は**週次サマリの目視 + 件数上限**
  (`EXTRACTOR_MAX_FILES` 等)でガードし、上限に近づく傾向が見えたら real バッチの頻度・件数を絞る。

### D2. pr-miner 対象リポ(§14#5)= 自 PAT で読める queeenb-com リポのうち external-minutes / board-minutes を除く

- リポ名はハードコードせず Actions var `PR_MINER_TARGETS`(カンマ区切り)で設定する(`pr-miner.yaml` も同形)。
- **external-minutes / board-minutes は対外・取締役会の機微情報のため除外**する。
- **初期セット(2026-07-23 確定・設定済み)**: 開発(コード)リポのみに絞り、`PR_MINER_TARGETS`
  (Actions var・**19 リポ**)へ登録済み = 製品/エンジニアリング repo(honda-liner-motion, MobileManipulator,
  tiago, filtration_platform, CellCulturePilot, Colony_Picker, doorbell-hack, dobot-no-code-app, lichtblick,
  docker_ws, knowledge-platform, google-drive-mcp-server, server_agent, article_agent, test-honda-dev, Website,
  mitsubachi-hp)+ `Software_Development_Policy` + `ai-coding-ops`。ノイズ源の minutes/docs/ops 系は初期除外。
- **有効化はまだ**: `PR_MINER_KB_REPO` 未設定のためジョブ全体が OFF(週次 LLM コスト発生なし)。
  KB リポを設定すると dry-run 稼働、`PR_MINER_REAL=1` で実 PR。予算(D1)を見て有効化タイミングを決める。

### D3. members マッピング(§14#8)= KB `_meta/members.yaml` が唯一の正(機構完成・**初版データ投入済み**)

- 機構は ADR-0017 D3 / 0021 / 0022 で完成済み(bot / gap-tracker が KB clone から都度読む。
  スキーマは `name`(表示名・任意)/ `github`(任意)/ `discord`(必須)/ `github_alts` / `discord_alts`)。
- **初版データ投入済み**: `knowledge-base/_meta/members.yaml` に 2026-07-23 時点の運用メンバー(22 エントリ /
  23 アカウント)を登録済み。以降の追加・更新は各自が PR で自分の行を編集する運用で維持する。

### D4. GitHub Organization 移行(§14#9)= ナレッジ共有エージェントの実稼働後まで延期

- Org 移行(Team 化・ブランチ保護強制・GitHub App の組織インストール)は、エージェントが実運用で回り
  価値が確認できてから行う。それまでの real 書き込みは現状の hybrid(ADR-0013 D4: GitHub App=PR/write /
  個人 PAT=clone/read)で運用する。

## 影響

- #3/#5/#8/#9 の確定で extractor / gap-tracker / pr-miner の real 化・運用が具体化できる。残るブロッカーは
  **実 E2E の実施**と、**死活監視・runbook の整備**。
- design.md §14 表への転記は人間タスク(design.md は編集ブロック)。
