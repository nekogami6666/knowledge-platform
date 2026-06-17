# prompts/

全プロンプトの置き場(design.md §8.1)。`prompts/<app>/<name>.md` に置き、frontmatter に
バージョン・想定モデルロール(`fast` / `standard` / `deep`)・変更履歴を持つ。`packages/llm` の
ローダ(`loadPrompt`)が読み込む。**コード内へのプロンプト直書きは禁止**(CLAUDE.md §12.2)。

- プロンプト変更の PR は、§10 のゴールデンテスト結果(変更前後の比較)を PR 本文に貼る(§8.1)。
- system prompt には §8.2 の共通規定句(出典規律 / 不明の宣言 / 機微情報除外 / 日本語出力)を必ず含める。

初版で作成予定の主要プロンプト(§8.3):

| ファイル | ロール | 責務 |
|---|---|---|
| `prompts/qa/answer.md` | standard | /ask の回答生成(検索エージェントの system prompt) |
| `prompts/extractor/extract.md` | standard | 議事録 → 構造化抽出 |
| `prompts/extractor/reconcile.md` | standard | 抽出候補と既存 KB の照合 |
| `prompts/capture/triage.md` | fast | 💡スレッドのナレッジ候補判定 |
| `prompts/capture/draft.md` | standard | スレッド/音声メモ → エントリ草案 |
| `prompts/gap/request.md` | fast | 専門家への依頼文生成 |
| `prompts/expertise/cluster.md` | deep | トピック増分クラスタリング |
| `prompts/interview/questions.md` | deep | インタビュー質問リスト生成 |
