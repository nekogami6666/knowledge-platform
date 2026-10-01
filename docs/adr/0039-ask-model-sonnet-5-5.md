# ADR-0039: /ask の回答生成モデルを claude-sonnet-5-5 にする(役割 `qa` を追加)

- ステータス: proposed
- 日付: 2026-10-01
- 関連: design.md §5.2(モデルの使い分け)・ADR-0008 / ADR-0009(Claude on AWS)・ADR-0035(時間予算・段階 1-3)・
  qa/answer v6(PR #168)

## 背景

- /ask の所要時間は本番 61 件で中央値 57 秒・p90 124 秒。目標は「30 秒〜1 分で、しっかりした回答」。
- 標準の役割(`standard`)は `claude-sonnet-4-6`。VM ホストの Claude Code に配られた組織設定
  (`enforceAvailableModels`・`availableModels` が sonnet-5 以降)では `claude-sonnet-4-6` が許可されておらず、
  ホストで動くバッチでは `claude-sonnet-5` に無通知で置き換わっていた(本番コンテナには組織設定が無く
  `claude-sonnet-4-6` のまま)。組織の方針としては sonnet-4-6 を使わない意図と読める。
- `claude-sonnet-5-5` / `claude-opus-5-5` / `claude-sonnet-5` は組織の制限下でも指定どおりに使えることを確認済み。

### 比較実験(段階 1-3・2026-10-01)

本番と同じ 3 リポ(knowledge-base / dev-minutes / biz-minutes)・同じプロンプト(qa/answer v5)で、
6 構成 × 6 問(事実・最新議事録・進捗・KB・KB と議事録の横断・存在しない情報)を 1 回ずつ実行(36 回・$2.08)。

| 構成 | 平均 | 最大 | 1 問の平均費用 |
|---|---|---|---|
| claude-sonnet-4-6・設定なし(現本番) | 32.7 秒 | 62.0 秒 | $0.083 |
| claude-sonnet-4-6・effort medium・最大 12 ターン | 32.2 秒 | 43.3 秒 | $0.084 |
| **claude-sonnet-5-5・設定なし** | **12.7 秒** | **17.7 秒** | **$0.041** |
| claude-sonnet-5-5・effort medium・最大 12 ターン | 12.1 秒 | 16.8 秒 | $0.029 |
| claude-sonnet-5-5・effort low・最大 12 ターン | 12.5 秒 | 17.8 秒 | $0.033 |
| claude-opus-5-5・effort low・最大 12 ターン | 21.0 秒 | 26.5 秒 | $0.076 |

- 全構成で「存在しない情報」は正しく未回答、答えられる質問の誤った未回答は 0、引用はすべて検証を通過。
- 回答本文の読み比べ: 進捗の質問で opus-5-5(effort low)だけが古い議事録(8/17)で止まり最新を見落とした。
  横断の質問で sonnet-5-5 は KB の記事 1 件で答え終え、議事録の新しい方針を拾えなかった
  → qa/answer v6(PR #168)で「KB で見つかっても新しい議事録を 1 回確認」を追加し、再測定(sonnet-5-5・6 問 × 2 回)で
  横断の質問が議事録まで確認するようになった(引用 1 → 2 件・8 → 11〜12 秒)。全問 17 秒以内。
- 少数回の実行のため、p95 の改善は断言しない(本番の完了ログ・段階 1-1 で確認する)。

## 決定

- **D1: /ask の回答生成だけ `claude-sonnet-5-5` にする。** `ModelRole` に `qa` を追加し(`models.ts` が唯一の正)、
  `createQaSearch` の役割を `standard` から `qa` に変える。effort / maxTurns は既定のまま
  (effort を下げても速さはほぼ変わらず、品質リスクだけが増えるため。`ASK_EFFORT` / `ASK_MAX_TURNS` で調整は可能)。
- **D2: バッチ(抽出・PR マイニング・矛盾検出・gap など)は `standard`(claude-sonnet-4-6)のまま。**
  これらの品質は未検証のため、golden eval・抽出レビューで確かめてから別途判断する。
- **D3: golden eval(`evals/` の run-qa)も `createQaSearch` を使うため `qa` で走る。** baseline との比較は
  次回の weekly-eval で行い、低下が 10pt を超えれば本 ADR を見直す。

## 影響・トレードオフ

- 速さ・費用: 上の実験で約 2.5 倍速く、費用は約半分(見込み。本番の完了ログで確認する)。
- `isModelSubstituted` の警告(PR #162)は、本番コンテナでは出ない見込み(sonnet-5-5 は組織の許可リストにある)。
- Claude Sonnet 5.5 は `thinking: {type: "disabled"}` を受け付けない(400)。`ASK_THINKING=disabled` を設定しないこと
  (未設定なら SDK 既定で問題ない)。
- ロールバック: `models.ts` の `qa` を `claude-sonnet-4-6` に戻す(1 行)。

## design.md への転記(人間)

- §5.2 の表に `qa` 行(/ask の回答生成・claude-sonnet-5-5)を追加し、`standard` の用途から「Q&A 回答生成」を外す。
