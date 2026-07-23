# ADR-0023: extractor は 1 ファイルの失敗で落とさず、上限 N 件 + 持ち越し(pending カーソル)で完走する

- **ステータス**: accepted(2026-07-23 人間承認。§6.3 転記は人間タスクとして残る)
- **日付**: 2026-07-23
- **関連**: design.md §6.3(C2 抽出フロー)・§4.1.2/§7.1(state.json カーソル)/
  ADR-0009(Claude on AWS)・ADR-0013(Actions エフェメラル runner の実行境界)・ADR-0004 D2(push 前 validateRepo)/
  #84(`spawn git ENOENT` = clonesDir mkdir 修正・本 ADR の前提)

## 背景

extractor-nightly が一度も完走していない。失敗は 2 層:

1. `spawn git ENOENT`(clonesDir を作る前に `git clone` を spawn)→ **#84 で修正済み**。
2. **本命**: `extractFromMinutes`(議事録 1 ファイルの agentic 抽出・per-call 5 分タイムアウト)が
   [run.ts](../../apps/extractor/src/run.ts) の per-file ループで **try/catch されておらず**、1 ファイルのタイムアウト
   (withRetry 2 試行とも失敗)で `runExtractor` が throw → プロセス exit 1。reconcile は候補単位で
   skip する耐障害設計があるのに、その 1 段外側の extract は fail-fast のまま残っていた。

さらに `_meta/state.json` が `{}`(両スキーマ不適合 → `readState`=null)のため毎回 **全 `*.md`** を再処理し、
完走しないので state が永遠に進まない悪循環になっていた(実 dev-minutes: `*.md` 70 件)。

カーソルは source(minutes / interviews)ごとに **単一 SHA を無条件で head へ前進**する設計
([run.ts](../../apps/extractor/src/run.ts))。このため「1 run で N 件だけ処理」「失敗ファイルを skip」を
素直に入れると、**未処理ファイルが次回の diff(`since..head`)から永久に消える**(静かなデータ欠落)。

## 決定

### D1. 抽出失敗はファイル単位で skip して完走する(reconcile と同型・粒度はファイル)

per-file 処理を 2 段の try/catch にする:
- **読み込み失敗**(`readFile`)= 削除/改名された持ち越しファイル等 → warn して**破棄**(pending に残さない。無限再キュー防止)。
- **抽出失敗**(`extractFromMinutes` throw = タイムアウト等)→ warn + `skippedFiles` に記録し、**次回へ持ち越す**(pending 再キュー)。

エラー正規化・ログ流儀は reconcile の候補 skip([run.ts](../../apps/extractor/src/run.ts))に合わせる。

### D2. 部分進捗の表現 = カーソル(SHA)+ `pending`(持ち越しパス)

`state.json` の source カーソルに **`pending: string[]`(任意)** を追加する。各 run の work list =
`dedupe(前回 pending ++ changedSourceFiles(since..head))`(pending 先頭 → diff 順)。**カーソルは常に head へ
前進**し、未処理分(D3 の上限超過 + D1 の失敗)を `pending` に明示保存する。単一 SHA では部分進捗を
表せない問題の、最小変更での一貫解(HEAD 前進 + 例外リスト)。`state.json` は extractor ローカルの JSON
(kb-core 非依存 = validateRepo 不問)なので **KB validate CI に影響せず kb-core タグ更新も不要**。

### D3. 1 run の処理上限 = attempted 件数(`EXTRACTOR_MAX_FILES`)

夜間 1 回で処理するファイル数に上限を設け、バックログをコスト/時間有界で少量ずつ消化する。上限は
**extract に入った件数**で数える(read 失敗・抽出失敗も 1 件消費 = 毒ファイル 35 件の夜に無制限に燃やさない)。
**コード既定は無制限**(現挙動不変)、CI(workflow env)で opt-in する。あわせて `EXTRACTOR_TIMEOUT_MS` を
5 分 → 10 分に延ばす(観測: 5 分×2 試行で不足。延長は D1 の補完であり根治ではない)。

### D4. skip / 持ち越しを可視化する

カーソル前進で未処理が静かに消える唯一の面が PR 本文・ログ。`RunSummary` に `skippedFiles` /
`deferredCount` を足し、**PR 本文・抽出サマリログ・完了ログ**に出す(`NotifyCounts` は触らず、Discord 定型
文言や候補粒度の `skip` と混同しない)。

## 影響・トレードオフ

- **利点**: 1 ファイルの失敗が夜間ジョブ全体を殺さない(完走保証)。上限 N 件で LLM コストが有界。
  reconcile の既存 skip パターンの素直な鏡映で新規面が小さい。
- `pending` は state ローカル拡張のみ。legacy union・`{}`→null の挙動は不変。
- **dry-run では state が main に届かない**(PR を作らないため)。`EXTRACTOR_REAL_PR=1` 化まで夜間 run は
  毎回同じ先頭 N 件を再処理する(既知・運用ノートで扱う。ADR-0013 の実 PR ゲート通過後に解消)。
- 恒常的にタイムアウトする「毒ファイル」は毎晩 pending 先頭で 1 スロットを消費し続ける。D4 の skip 表示で
  気づけるので、その場合は extractor.yaml の `minutes.exclude`(basename)で除外するのが escape hatch。

## 却下した代替案

- **タイムアウト延長だけ**: 遅い 1 件を救えても別の遅い 1 件で落ちる。完走保証にならない。延長は併用するが根治ではない(D3)。
- **失敗ファイルをカーソル前進で捨てる(pending 無し)**: 静かなデータ欠落。上限 N 件(D3)と両立不可(未処理が消える)。
- **カーソルをファイル単位 SHA / 全処理済みリストに置換**: 単一 SHA の単純さ(§7.1)を捨てる。`pending` は差分を保ったまま例外だけ持つので変更が最小。
- **reconcile と同じく `counts.skip` に畳む**: ファイル粒度(重い抽出)と候補粒度(軽い reconcile)を混同し PR 本文の意味がぶれる。`RunSummary` 専用フィールドにする(D4)。

## 検証

- ユニット([run.test.ts](../../apps/extractor/src/run.test.ts) の fake 流儀): (a) extract が 1 件目で throw → 完走 +
  2 件目 materialize + `skippedFiles=[1件目]` + state の pending に 1 件目 + カーソル head、(b) changed 3 件 +
  `maxFilesPerRun:2` → 2 件処理 + `deferredCount:1` + pending に 3 件目、(c) state に pending 1 件 + diff 空 →
  pending が処理される(no-changes にならない)/ pending が read 失敗 → 破棄、(d) [cursor.test.ts](../../apps/extractor/src/cursor.test.ts) で pending round-trip・後方互換。
- E2E: `gh workflow run extractor-nightly`(dry-run)→ 完走(exit 0)・「今回 N 件処理 / 持ち越し M 件」・
  タイムアウトが出ても skip して継続、をログで確認。
