# ADR-0032: expertise クラスタリングの割当キャッシュ(増分の実体化)

- ステータス: proposed
- 日付: 2026-08-19
- 関連: ADR-0017(expertise-mapper)/ ADR-0023(有界コストと繰越)/ design.md §6.6

## 背景

2026-08-16 の expertise-weekly がクラスタリングのタイムアウト(300s)で失敗した。実測から
所要時間は **material 件数にほぼ比例(≈2.1 秒/件)** する: 07-26 は 104 件で 4m52s、08-16 は
KB の伸長(抽出 PR の連続マージ)で 210 件に達し 300s を超過した。応急処置(timeout 900s・
リトライ増幅の停止・計測ログ)は入れたが、**KB は数ヶ月で倍増した実績があり、総量比例の構造の
ままではいずれ必ず再発する**。

構造の核心: 現行の「増分クラスタリング」(ADR-0017 D6)は**トピック名の引き継ぎ**だけで、
material は毎週**全件**を LLM に再送している。per-material の割当(material → topic)は
どこにも永続化されないため、前回と同じ 200 件を毎週ゼロから再割当するしかない。律速は
出力側(assignments 配列の生成 ∝ N)なので、プロンプト側の切り詰めでは解決しない。
なお `window_days` は commit evidence の人物活動窓にのみ効き、material 件数とは無関係
(短縮してもタイムアウトは解消しない)。

## 決定

### D1. 割当を `_meta/expertise-assignments.json` に永続化する

KB リポの `_meta/` に `{ version: 1, assignments: { <materialId>: <topicId> } }` を置き、
expertise-mapper が run ごとに読み書きする。**自動生成・手編集禁止の派生物**であり、消えても
次回の全再クラスタで完全に再構築できる。material id(`kb:<エントリID>` / `repo:<owner/name>`)は
不変(ADR-0026: ID は永久固定)なのでキャッシュキーとして安全。`_meta/` は validateRepo の
走査対象外(members.yaml 以外)なので KB の validate CI に影響しない。`_meta` JSON の fs
直読み書きは extractor の `_meta/state.json`(cursor)と同じ前例で、kb-core 経由の対象外。

### D2. LLM へは「新規・未割当の material だけ」を送る

run は materials をキャッシュと突合して cached / uncached に分割し、`runClustering` には
uncached のみ渡す(0 件なら LLM 呼び出し自体をスキップ)。指標算出(computeTopics)は
cached ∪ LLM 結果をマージした全 materials で行う — evidence_count / documented_kb_count の
決定性は従来どおり保たれる。有効なキャッシュは「割当先 topic が現行マップに存在するもの」に
限定し、消滅した topic への割当・KB から消えた material の割当は無効化(eviction)する。
**未割当(unassigned)はキャッシュしない** — 毎回再挑戦させる(件数が少ないうちは無害で、
新トピックの成立とともに自然に収束する)。

これにより所要時間は「KB 総量」比例から「週次差分」比例に変わる(定常時 210 件 ≈ 7 分 →
週の新規 5〜20 件 ≈ 1 分未満)。

### D3. キャッシュ破損は warn + 全再クラスタで自己修復する

parse 失敗・スキーマ不一致は **warn を出して空キャッシュとして続行**(= その週は全件
再クラスタ)。expertise.yaml 本体の parse 失敗が fail-loud(ADR-0017)なのと非対称だが、
本体は「壊れたマップを黙って上書きしない」ための停止であるのに対し、キャッシュは**いつでも
捨てられる派生物**であり、停止よりも自己修復が正しい。

### D4. 全再クラスタの逃げ道を常設する

`EXPERTISE_FULL_RECLUSTER=1`(env)でキャッシュを無視して全件を再クラスタする
(workflow_dispatch から手動実行)。一度割り当てた material が二度と見直されない
「割当の固定化」への対処として、**四半期に 1 回程度の全再クラスタ**を運用に組み込む
(runbook に記載)。トピックの統廃合や命名の見直しをしたい場合もこれを使う。

## 却下した代替案

- **window_days の短縮**: material 件数に無関係(上記)。効果ゼロ。
- **material 件数 cap + 古い順 drop**: drop した material が指標から消え、トピックの消滅・
  安定率 AC の破壊を招く。データを失う削減はしない。
- **チャンク分割投入**: 1 回あたりは timeout を割るが総時間はむしろ増え、チャンク順で結果が
  変わり決定性が落ちる。恒久策にならない。
- **出力スキーマの圧縮**(`groups: [{topic, material_ids[]}]`): 出力トークンを 1/2〜1/3 に
  できる有効な補助策だが、D2 で入力が週次差分に縮めば効果が限定的。C1 で入れた elapsedMs
  計測を数週観測して、必要なら別 PR で採用する(保留)。

## 実装

- 新規 `apps/expertise-mapper/src/assignments-cache.ts`: zod スキーマ + read(D3)+ serialize +
  partition / evictAndMerge の純関数群(手本: extractor `cursor.ts`)。
- `run.ts`: 分割 → uncached のみ LLM → マージして computeTopics → 変化時のみ commit files に
  `_meta/expertise-assignments.json` を追加。ログに cached / uncached 内訳。
- env: `EXPERTISE_FULL_RECLUSTER`。runbook: キャッシュ意味論・全再クラスタ手順・破損時挙動。

## design.md への転記(人間)

- §6.6: クラスタリングは割当キャッシュによる増分(新規・未割当のみ LLM へ)である旨と、
  `_meta/expertise-assignments.json` の位置づけ(自動生成・手編集禁止)。
