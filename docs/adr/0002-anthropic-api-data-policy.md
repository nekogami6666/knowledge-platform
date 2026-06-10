# ADR-0002: Anthropic API データ利用ポリシーの確認記録

- **ステータス**: accepted
- **日付**: 2026-06-10
- **関連**: design.md §9.4(外部送信の整理)・§5.2(モデルの使い分け) / Phase 0
- **備考**: design.md §9.4 が「Anthropic API のデータ利用ポリシー(学習への不使用・保持期間)は
  実装着手時に公式ドキュメントで確認し、確認日付と内容を ADR-0002 として記録する」と定めた
  未起票 ADR。**ポリシー本文は本ドラフト作成時点で web から確定できないため、本 ADR は確認すべき
  項目・確認先・記入欄を備えたテンプレートとして起票する。** 各項目の「確認結果」「確認日」「確認者」は
  空欄であり、Phase 0 で人間が公式ドキュメント(または Anthropic との契約・DPA)を確認して記入し、
  全項目記入後に `accepted` へ昇格させる。空欄が残る間は本 ADR を採択しない。

## 背景

本プラットフォームは議事録・Discord メッセージ・音声書き起こしという社内データを Anthropic API
(Claude)に送信する(§3, §9.4)。これらは未公開の社内知識であり、モデル学習への流用やサービス側の
長期保持は機密性・コンプライアンス上のリスクとなる。送信を本格化する前に、Anthropic のデータ利用
ポリシーを一次情報で確認し、その結果を本 ADR に固定する必要がある。

確認は「記憶や二次情報ではなく、確認日時点の公式ドキュメント / 契約条項」に基づいて行うこと。
ポリシーは改定されうるため、確認日と参照 URL を必ず併記する。

## 確認すべき項目(テンプレート)

各行の「確認結果」「確認日」「確認者」は人間が記入する。`確認先 URL` は出発点であり、リンク切れ・
改定時は §付録B(design.md)および Console から最新を辿ること。

### (a) API 入出力がモデル学習に使われるか

- **確認したいこと**: API 経由で送信した入力・受信した出力が、Anthropic のモデル学習・改善に
  使用されるか。商用 API のデフォルトでオプトアウト扱いか、明示設定が必要か。
- **確認先 URL(候補)**:
  - 商用利用規約: https://www.anthropic.com/legal/commercial-terms
  - 利用ポリシー / プライバシー: https://www.anthropic.com/legal/privacy
  - 使用データに関するヘルプ: https://docs.claude.com/en/docs/legal-center （Console のデータ設定も確認）
- **確認結果**: Anthropic の商用利用規約上、API 等の商用 Services に送信される Inputs および Outputs は Customer Content とされ、Anthropic は Services からの Customer Content をモデル学習に使用しない旨が明記されている。したがって、通常の商用 API 利用では、入力・出力はデフォルトでモデル学習・改善に使用されない扱いと判断する。ただし、Development Partner Program 等、顧客が任意に参加・同意するプログラムでは、対象データが改善・学習目的で利用され得るため、本プロジェクトでは参加しない設定であることを Console / 契約上確認する。また、一般のプライバシーポリシーには、利用者がオプトアウトしない場合や安全審査・フィードバック送信時の利用に関する記載があるため、消費者向け Claude.ai と商用 API を混同しないよう注意する。
- **確認日**: 2026-06-10
- **確認者**: Shoma2231

### (b) データ保持期間

- **確認したいこと**: 入力・出力・ログがサービス側で保持される期間と、トラスト&セーフティ目的の
  保持の有無・期間。削除要求の可否と手段。
- **確認先 URL(候補)**:
  - 商用利用規約(データ保持条項): https://www.anthropic.com/legal/commercial-terms
  - データ保持に関するヘルプ: https://privacy.anthropic.com/
- **確認結果**: Anthropic API については、入力・出力は受領または生成から30日以内にバックエンドから自動削除される。ただし、Files API 等のより長い保持期間を伴うサービスを利用する場合、別途契約で合意した場合、利用ポリシーの執行のため長期保持が必要な場合、または法令遵守上必要な場合は例外となる。利用ポリシー違反として Trust & Safety 分類器によりフラグされた場合、入力・出力は最大2年間、Trust & Safety 分類スコアは最大7年間保持され得る。フィードバックやバグレポート等を送信した場合、その送信に関連するデータは5年間保持され得る。Claude for Work / Enterprise / Console 等、会話の保存・継続が可能な商用製品では、製品体験提供のためチャットやコーディングセッションが製品内に保持される。会話はダッシュボードから削除可能で、削除時は履歴から即時削除され、バックエンドからは30日以内に削除される。Enterprise ではカスタムデータ保持期間を設定できるが、最小保持期間は30日である。
- **確認日**: 2026-06-10
- **確認者**: Shoma2231

### (c) Claude Fable 5 固有の保持ポリシー

- **確認したいこと**: 本プロジェクトで利用予定のモデル(§5.2、Fable 5 / Opus / Sonnet / Haiku)の
  うち、Claude Fable 5 に (a)(b) と異なる固有の学習利用・保持ポリシーがあるか。プレビュー/特定
  バージョン固有の例外条項の有無。
- **確認先 URL(候補)**:
  - モデル一覧 / モデルカード: https://docs.claude.com/en/docs/about-claude/models
  - 利用規約のモデル別注記: https://www.anthropic.com/legal/commercial-terms
- **確認結果**: Claude Fable 5（claude-fable-5）は、2026年6月9日から Claude API、Claude Platform on AWS、Amazon Bedrock、Vertex AI、Microsoft Foundry で一般提供されている、Anthropic の広く公開されている中で最も高性能なモデルとされている。学習利用については、通常の商用 API 利用では (a) と同様に、Customer Content はモデル学習に使用されない扱いと判断する。一方、保持ポリシーについては注意が必要である。Anthropic は Mythos-class models および同等能力として指定される Covered Models について、責任ある提供のため、プロンプトおよび出力を Trust & Safety 目的で30日間保持・レビューするポリシーを2026年6月9日から適用している。公式説明では、Claude Fable 5 は Claude Mythos 5 と同じ基盤モデルを共有し、サイバー・バイオ領域等の追加セーフガードを備えるとされているため、ZDR 環境で Fable 5 を利用する場合は、この Covered Models / Mythos-class 向けの30日安全目的保持の対象となる可能性が高い。したがって、固有ポリシーは「学習利用は (a) と同一。ただし ZDR 利用時の保持については (b) と異なり、Covered Models として Trust & Safety 目的の30日保持が必要となる場合がある」と整理する。最終的には、Console の Workspace > Manage > Privacy Controls および契約・営業担当への確認により、当該ワークスペースで Fable 5 が Covered Models 扱いか、ZDR と併用可能かを確認する。
- **確認日**: 2026-06-10
- **確認者**: Shoma2231

### (d) ZDR(Zero Data Retention)との関係

- **確認したいこと**: ZDR が本アカウント/契約で利用可能か、利用に申請・プラン要件があるか、
  対象となる API・モデルの範囲。ZDR 有効時に (b) の保持がどう変わるか。本プロジェクトで ZDR を
  採用すべきか(採否の判断と理由)。
- **確認先 URL(候補)**:
  - ZDR の説明: https://privacy.anthropic.com/ （「Zero Data Retention」で検索)
  - 商用利用規約 / エンタープライズ条項: https://www.anthropic.com/legal/commercial-terms
- **確認結果**: ZDR は商用 API のデフォルト設定ではなく、Claude Platform / Claude API または Claude Code for Enterprise の一部顧客が、Anthropic の承認を受けて個別に利用できる契約上の取扱いである。ZDR 契約下では、法令遵守またはミスユース・危害への対処に必要な場合を除き、Anthropic は入力・出力を保存しない。ただし、利用ポリシー執行のため User Safety 分類器の結果は保持される。ZDR が適用される範囲は、適格な Anthropic API、商用組織 API キーを用いる Anthropic 製品、API 経由の Claude Code、Claude Code for Enterprise 等に限定される。ZDR の適用は組織単位で審査・付与されるため、複数 Organization がある場合は対象 Organization を明示して Sales Team に確認する必要がある。Claude Platform では Settings > Privacy Controls > Data retention period で ZDR 適用状況を確認できる。一方、Covered Models / Mythos-class models については、ZDR 組織であっても Trust & Safety 目的で入力・出力の30日保持が必要となる場合がある。Claude Fable 5 は Mythos 5 と同一基盤モデルを共有する旨の公式説明があるため、Fable 5 利用時には ZDR が完全な非保持として機能しない可能性を前提に、利用可否・保持条件を事前確認する。
- **確認日**: 2026-06-10
- **確認者**: Shoma2231
- **ZDR 採否の判断**: 採用方針(申請ベース)。本システムが扱う議事録・Discord・音声書き起こしには、未公開の技術情報・開発ノウハウ・取引先や顧客に関する事業情報が含まれ得るため、保持最小化の価値が高い。なお人事評価・採用候補者情報等は §9.3 により取り込み対象外であり、ZDR の有無にかかわらず API へ送信しない。Fable 5(Covered Models)は ZDR 下でも30日の安全目的保持が残る可能性があるため、「ZDR + Fable 5」の実際の保持条件は Anthropic Sales / Console で確認する。ZDR 承認までは、標準の30日保持 + §9.3 除外を前提に運用する(D3)。

## 決定

- D1. 通常の商用 API 利用において、入力・出力(Customer Content)はモデル学習に使用されないことを一次確認済み(2026-06-10)。Development Partner Program 等のオプトイン型プログラムには参加しない。不参加であることを Console / 契約上で確認して運用する。
- D2. 許容する保持期間は標準の「30日以内の自動削除」とする。Trust & Safety 違反フラグ時の長期保持(最大2年等)は利用ポリシーの遵守により回避する前提とし、§9.3 の機微情報除外をAPI 送信前の必須統制とする。これを超える保持要件が生じた場合は、ZDR の適用または送信前マスキングで対応する。
- D3. ZDR は採用方針とし、Anthropic(Sales / Console の Privacy Controls)へ適用可否を確認・申請する。ただし ZDR は承認制であり、かつ Fable 5 は Covered Models として ZDR 下でも30日の安全目的保持が残る可能性があるため、**ZDR の承認を Phase 1 開始の前提条件にはしない**。承認までは「標準30日保持 + §9.3 除外」で運用し、Fable 5 の30日安全保持は受容する。
- D4. 確認結果は design.md §9.3 / §9.4 の前提と整合する(設計改訂は不要)。なお当初の (d) 記入に §9.3 で取り込み禁止と定めた情報種別を送信前提とするかのような記述があったため、記入時に修正した(修正後の判断は (d) ZDR 採否の判断を参照)。

## 影響

- 本 ADR が `accepted` になるまで、社内データの API 送信を伴う本番運用(Phase 1 以降)は開始しない。
  開発・テストは合成データまたは送信可と判断したデータに限定する。
- 確認結果は §9.4 の「データ利用ポリシーの確認」要件を満たす一次記録となる。
- ポリシー改定時は本 ADR を更新するのではなく、新規 ADR で版を重ね、確認日を更新する。

## 却下した代替案

- 確認を省略し「商用 API は学習に使われない」という一般論で運用する案 → 一次情報による確認を
  §9.4 が明示要求しており、社内機密データを扱う以上、記憶・二次情報での運用はリスクが高いため却下。
- 本 ADR を空のまま `accepted` にする案 → 確認の実体がないまま記録だけが残り、監査上無意味な
  ため却下。空欄が埋まるまで `proposed` を維持する。
