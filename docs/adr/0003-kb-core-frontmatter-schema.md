# ADR-0003: kb-core frontmatter スキーマの確定事項

- **ステータス**: accepted
- **日付**: 2026-06-10
- **関連**: design.md §4.2〜4.5, §6.1 / Phase 0(`kb-core` 実装 PR)
- **備考**: ADR-0001(本設計の採択)・ADR-0002(API データポリシー確認)は未起票。本 ADR は
  `kb-core` 実装時に design.md §4.2〜4.5 の曖昧点を人間承認の上で確定したものを記録する。
  確定内容は design.md §4.2 本体への反映が必要だが、`docs/design.md` は保護パスのため
  本 ADR を先行ドラフトとし、design.md への転記は人間レビューで行う。

## 背景

`kb-core` は knowledge-base の「型の唯一の正」(design.md §6.1)。実装にあたり §4.2〜4.5 の
frontmatter スキーマを zod 化したところ、design.md の記載が曖昧・未定義な点が複数あった。
スキーマは今後 7 アプリ全てが依存する契約のため、実装前に各点を確定した(`/component` 起票時の
AskUserQuestion で人間が選択)。

## 決定

### D1. `sources` の kind 別形状(§4.2)

design.md は `meeting`(repo/path/lines)と `discord`(url)のみ例示。残り 4 種を **種別ごとに
最適化した discriminated union** として確定する:

| kind | 形状 |
|---|---|
| `meeting` / `voice-memo` / `interview` | `{ repo, path, lines?, ref? }` |
| `pr` / `issue` | `{ repo, number }` |
| `discord` | `{ url }`(discord.com permalink) |

`sources` は 1 件以上必須(P2)。

### D2. provenance 用の任意 `ref`(§4.2)

真の GitHub permalink(commit SHA 固定)生成のため、ファイル系 source に任意 `ref` を追加する
(additive、既存を壊さない)。指定時は SHA 固定 URL、省略時は呼び出し側が渡す default branch で
URL を生成する。`pr`/`issue` の URL(`/pull/N`・`/issues/N`)はそれ自体が permalink のため
`ref` を持たない。

### D3. `knowledge/` 内の `type: decision`(§4.2 注記との整合)

type enum には `decision` を残す(型の単一性)。一方 §4.2 注記「decision の本体は `decisions/`」
を守るため、`validateRepo` が `knowledge/**` 内の `type: decision` をエラーとして検出する。

### D4. `review_interval_days` の `decision`=∞ と `learning` 既定(§4.2)

- `∞`(鮮度確認対象外)は **キー省略(`null`)** で表現する。
- §4.2 のデフォルト一覧に `learning` の記載が欠落しているため、**`learning`=180**(`fact` と同値)
  を採用する。確定値: `procedure=90, fact=180, learning=180, failure=365, decision=null`。

### D5. expertise.yaml 検証のための `js-yaml` 依存追加(§4.5)

`expertise.yaml` は frontmatter ではなく純 YAML のため gray-matter の用途外。`validateRepo` で
検証するため `js-yaml`(gray-matter の推移的依存。実体は既にインストール済み)を明示依存に追加する。
外部「サービス」追加ではないため §9.4 の ADR 必須対象外だが、依存追加の経緯として記録する。

### 付随する実装上の取り決め(design.md 未記載・将来の参照用)

- frontmatter は strict(未知キー拒否)。`serializeEntry` も未知キーで throw し、無言のデータ消失を防ぐ。
- 日時はオフセット必須 ISO 8601(§7.5)。日付/日時は YAML タイムスタンプ暗黙変換を避けるため
  `js-yaml` の `JSON_SCHEMA` で文字列として読む。
- `_meta/id-counter.json` は `{ kind: { 年: 連番 } }`。年は JST 基準、4 桁(9999)上限。
- `validateRepo` は fail-closed: 不在パス・KB レイアウトに見えないディレクトリ・想定外配置の
  迷子ファイルをエラーとする。

## 影響

- `kb-core` の zod スキーマが上記で確定。利用側は型を再定義せず `@stratum/kb-core` から参照する。
- **design.md §4.2 への転記が必要**(本 ADR が先行)。特に sources の kind 別形状・`ref`・
  `learning` デフォルト・decision の表現。人間レビューで design.md を更新すること。

## 却下した代替案

- sources を全 kind 共通の緩い形状にする案 → `pr`/`issue` の `number` を表現できず provenance
  変換が弱くなるため却下。
- `learning` を `decision` と同じ「対象外」にする案 → 学び系も陳腐化するため鮮度確認対象に含める。
