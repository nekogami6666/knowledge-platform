# ADR-0012: extractor の実データローカル dry-run 例外(検証目的・限定)

- **ステータス**: accepted(2026-07-16。extractor の抽出品質人手評価(過去 10 件・precision ≥ 0.80)を実施する前提として採択・本 PR のレビューをもって確定)
- **日付**: 2026-07-05
- **関連**: design.md §6.3(extractor)・§9.3(機微情報除外)・§9.4(外部送信)・§9.5(封じ込め) /
  ADR-0002(Anthropic API データポリシー・accepted)・ADR-0006(Q&A エージェント FS 封じ込め・proposed)・
  ADR-0009(全 AI を Claude on AWS に統一)
- **備考**: 採択(`accepted`)および design.md への転記は人間レビューで行う。本 ADR は⑱(extractor 効率化 &
  品質改善)の検証手続きを固定するための記録。

## 背景

extractor の効率化 & 品質改善(⑱)では、**synthetic コーパス(`evals/fixtures/qa-corpus`)を before/after の
マージゲート**とし、加えて **実 `dev-minutes` 1件のローカル dry-run** を「任意のスポット確認」に使いたい
(実データでしか出ない密度・domain 分布・reconcile 速度を測るため。⑱ の3課題も実1件で判明した)。

しかし [ADR-0006](0006-qa-agent-filesystem-containment.md) D3 は「Phase 1a の agentic Read は synthetic 限定
(本物の社内データへは OS サンドボックス整備後)」と定める。これは agentic `Read/Grep/Glob` が `cwd` に縛られず、
untrusted 文書からのプロンプトインジェクションが任意ホストファイルの漏洩チャネルになりうる、という懸念に基づく。

extractor の2段は性質が異なる:

- **extract** は `allowedTools: []`(ツール無し・議事録本文を prompt にインライン)。FS へ到達する能力を
  **構造的に持たない**ため、ADR-0006 の漏洩ベクタの対象外。
- **reconcile** のみ既定の `Read/Grep/Glob`(KB clone を agentic search)を使う。ここが ADR-0006 D3 の射程。

一方 [ADR-0002](0002-anthropic-api-data-policy.md)(accepted)は、実社内データの API 送信を
**標準30日保持 + §9.3 機微除外**の下で許容している(送信自体は方針上 OK)。

## 決定

### D1. extract は構造的に安全(ADR-0006 の対象外)

extract は `allowedTools: []` で FS に到達できないため、Read が cwd 外(`~/.ssh`・`/proc/self/environ`・
兄弟 clone 等)へ達する ADR-0006 の漏洩ベクタを持たない。実データを extract に流すことは ADR-0002 の範囲内で許容する。

### D2. reconcile を含む実データローカル dry-run を検証目的で限定許可(ADR-0006 D3 への明示的例外)

次を**すべて満たす**場合に限り、開発者のローカルマシンで実 `dev-minutes` に対する extractor の dry-run を許可する:

- **(a) dry-run のみ**: `EXTRACTOR_REAL_PR` 未設定。PR 作成・push を行わず、**出力(抽出結果)を外部リポジトリへ
  出さない**(ローカルに留める)。
- **(b) ローカル封じ込めの人的担保**: 実行環境の可視範囲に、社内 clone(minutes / knowledge-base)以外の機微
  (認証情報・`~/.ssh` 等)を置かない前提で実行する。真の OS FS サンドボックスは未整備であることを理解して行う。
- **(c) synthetic を正式ゲートに保つ**: マージ可否は synthetic の before/after で判断し、実データ dry-run は
  補助的なスポット確認に留める。
- **(d) 送信は ADR-0002 準拠**: API 送信は標準30日保持 + §9.3 機微除外の下で行う。

### D3. 本番・常駐・実 PR は OS FS サンドボックス(ADR-0006 D1)整備後

実 PR を出す運用(`EXTRACTOR_REAL_PR=1`)や常駐実行は、ADR-0006 D1 の OS/コンテナ FS 隔離が整うまで**行わない**。
本 ADR は「検証目的の一時的なローカル dry-run」に射程を限定する。

## 影響・トレードオフ

- ⑱ の検証で、実1件の効果(timeout 非発生・新設 domain 減・reconcile 速度)を実データで確認できる。
- ADR-0006 D3 の「Phase 1a synthetic 限定」に、extractor 検証用の**狭い時限的例外**を加える(design.md §9.5/§9.3 への
  転記は人間)。恒久運用は D3 のゲートに従うため、封じ込めの本丸(OS 隔離)は据え置き。
- reconcile の agentic Read はローカル dry-run でも任意ファイルを読みうる(D2(b) は人的担保にすぎない)。この残存
  リスクを受容できるのは「dry-run で出力を外部へ出さない」+「synthetic がゲート」+「時限的」という限定ゆえ。

## 却下した代替案

- **synthetic のみで実データを一切使わない** → 実データ特有の密度・domain 分布を測れず、⑱ が解こうとした課題の
  効果測定が弱くなる。synthetic をゲートに保つことで安全性は確保しつつ、補助的な実データ確認を D2 で限定許可する。
- **実 PR まで通して検証** → 内部知識の抽出結果を queeenb-com/knowledge-base に出すことになり、FS 隔離・認証が
  未整備の現状ではリスクが高い。却下(D3 のゲートに従う)。

## 検証

- 本 ADR 自体は方針記録。実 dry-run は `EXTRACTOR_REAL_PR` 無しで実行し、**PR/push が発生しないこと**・
  抽出結果がローカルに留まることを確認する。
