# ADR-0021: members.yaml スキーマを拡張し、GitHub 未所持メンバー(`github` 省略可)と複数アカウント(`github_alts` / `discord_alts`)を表現する

- **ステータス**: accepted(2026-07-23。ユーザ承認「accept でok」で採択。GitHub/Discord 両側の別名対応を含む)
- **日付**: 2026-07-23
- **関連**: [ADR-0017](0017-expertise-mapper-actions.md) D3(members スキーマの定義元 — 本 ADR で拡張)/
  design.md §4.2(人物識別子 = GitHub ユーザ名)・§4.6(`_meta` の性格)・§14#8(マッピング表・各自申告)/
  `packages/kb-core/src/schemas/members.ts`・`members-io.ts`・`validate-repo.ts`(検証)/
  ADR-0019(freshness の owner→discord 逆引き)・ADR-0014/0016(gap-tracker consumer)
- **備考**: 採択(`accepted`)および design.md への転記は人間レビューで行う(ADR-0017 D3 の流儀)。
  本 ADR に伴うスキーマ実装・実 KB の members.yaml 初版はいずれも**未コミット**(working tree)。

## 背景

実 KB `queeenb-com/knowledge-base` の `_meta/members.yaml` を初版作成(運用メンバーが Discord 24 アカウントを
一括登録・§14#8)しようとしたところ、現行スキーマ([ADR-0017](0017-expertise-mapper-actions.md) D3 で定義)が
実在の人員構成を**表現できない**ことが判明した:

```ts
// 現行(schemas/members.ts)
memberSchema = z.object({ github: z.string().min(1), discord: z.string().min(1) }).strict();
```

1. **GitHub 未所持メンバー**(初版 22 エントリ中 10 エントリ): `github` が**必須・非空**のため、省略も `null` も
   空文字も不可。「Discord アカウントをすべて登録し、GitHub の無い人も除外しない」要件と正面から衝突する。
2. **1 人が複数 GitHub アカウント**を持つケース(実データ: Kazuki Nemoto = `kazu-nemoto` + `nimotougou`):
   `github` が単一 string のため、片方しか載せられない。勝手に片方を削除するのは同一人物性の欠落。
3. **1 人が複数 Discord アカウント**を持つケース(実データ: 原島寛之 = Discord 2 アカウント):
   `discord` が単一 string のため、片方しか載せられない(同上)。

このまま現行スキーマで進めると、(a) GitHub 未所持者を名簿から除外(freshness/gap の対象から漏れる)か、
(b) 空文字/架空ユーザ名で埋める(データ汚染・逆引き誤爆)しか手が無く、どちらも受け入れられない。
ADR-0017 D2 が speaker_labels について確立した方針(**スキーマ拡張は kb-core + validateRepo + fixture の
再波及とセットで、silent drop しない**)に倣い、スキーマを拡張する。

## 決定

### D1. `github` を optional 化する(GitHub 未所持メンバーの表現)

- `github: z.string().min(1).optional()`。GitHub を持たないメンバーは `github` を**省略**する(`discord` のみ)。
- design.md §4.2「人物識別子 = GitHub ユーザ名」は **GitHub を持つ人に適用**する。未所持者は **Discord ユーザ ID を
  識別子**とする(§4.2 転記対象)。
- consumer への影響は無い(下記 D4): `githubForDiscord` は元から `string | undefined` を返し、呼び出し側は
  `?? "unassigned"` 等で undefined を処理済み。

### D2. 別名アカウントを追加する(GitHub / Discord 両側の複数アカウント表現)

- `github_alts: z.array(z.string().min(1)).nonempty().optional()`(primary = `github`)。
- `discord_alts: z.array(z.string().min(1)).nonempty().optional()`(primary = `discord`。1 人が複数 Discord
  アカウントを持つ場合)。
- **逆引きは primary / 別名のどちらでも本人へ解決する**: `discordForGithub` は `github`/`github_alts` の
  どちらでも primary discord を返し、`githubForDiscord` は `discord`/`discord_alts` のどちらでも github を返す。
  KB エントリの `owner`/`people` が別名で書かれても解決でき、DM ウォーム(`warmDmChannels`)は primary + 別名の
  両 Discord を温める(1 人 2 アカウントのリアクションを両方受ける)。

### D3. 不変条件: `github_alts` は primary の `github` がある場合のみ

- `.refine(m => m.github !== undefined || m.github_alts === undefined)`。「別名だけあって本体が無い」不整合を弾く。

### D4. consumer 影響と後方互換(型の唯一の正 = kb-core からのみ変更)

- **`members-io.ts`**: `discordForGithub` を `github_alts` 対応・`githubForDiscord` を `discord_alts` 対応に
  更新(返り値型は不変)。
- **`warmDmChannels`(discord.ts)**: primary + `discord_alts` の両 Discord を DM ウォーム対象にする。
- **他の消費者(gap-tracker / freshness / capture / voice)**: すべて helper 経由で `string | undefined` を受け、
  既に undefined をフォールバック処理(`"unassigned"` / `discord:<id>`)しているため**コード変更不要**。
- **gap-tracker の `assignees`**(gap.yaml 由来・`assigneeSchema`)は kb-core Member とは**別型**なので影響外。
- **validateRepo**: 「`_meta/members.yaml` は存在すれば検証・不在は許容」(ADR-0017 D3)を維持。fixture に
  「github 省略」「github_alts あり」「alts-without-github(不正)」を追加してガードする。
- 既存の valid fixture(`fixtures/valid-kb/_meta/members.yaml`。github 付き 2 名)はそのまま通る(後方互換)。

## 影響・トレードオフ

- 「`github` 単一必須」という単純さを手放す代わりに、実在の人員(GitHub 未所持・複数アカウント)を正しく表現できる。
- **design.md §4.2 の canonical identifier 前提が緩む**(github があれば github が正、無ければ discord)。転記が必要。
- **expertise-mapper(C6)への影響は中立**: C6 は KB の `owner`/`people` と commit author(いずれも GitHub 名)を
  集計する。GitHub 未所持メンバーはそもそも github 空間に現れないため集計対象外のまま(現状と同じ・悪化なし)。
  `github_alts` を C6 の名寄せに使うのは将来の余地(本 ADR スコープ外)。
- `_meta/members.yaml` の性格(人間が編集する名簿)は ADR-0017 D4 の射程限定のまま。

## 却下した代替案

- **`github` に空文字/プレースホルダを入れる** → データ汚染。`discordForGithub` の逆引きが空文字で誤爆する。却下。
- **GitHub 未所持者を名簿から除外** → freshness/gap の対象から漏れ、「全員登録」要件に反する。却下。
- **`github` を `string[]`(単一 → 配列)に変更** → 全 consumer の型を破壊し「primary」概念を失う。
  optional + `github_alts` の方が波及が最小(逆引きだけ 1 箇所更新)。却下。
- **discord-only メンバーを別ファイルに分割** → ADR-0017 D3 の「単一ソース」の趣旨に反する。却下。

## design.md 転記リスト(人間レビュー・保護パス)

- **§4.2**: 「人物識別子 = GitHub ユーザ名」に、**GitHub 未所持者は Discord ユーザ ID を識別子とする**旨と、
  複数アカウントは `github_alts` で表す旨を追記。
- **§14#8**: 申告フォーマットに「`github` は省略可(未所持者)・複数アカウントは `github_alts`」を追記。

## 検証

- `packages/kb-core/src/members-io.test.ts`: (a) `github` 省略(discord のみ)/ (b) `github_alts` /
  (c) `discord_alts` を parse できる / (d) `discordForGithub` が `github_alts` で・`githubForDiscord` が
  `discord_alts` で本人へ解決する / (e) alts-without-github が `SCHEMA_VIOLATION` になる、を追加。
- `validate-repo` は members あり/なし/壊れの既存検証を維持(新形も通ることを確認)。
- 実 KB の初版 `members.yaml`(23 Discord アカウント / 22 エントリ)を `parseMembers` で通し、
  github 省略 10 エントリ・`github_alts` 1 件・`discord_alts` 1 件を確認。
- `pnpm typecheck` / `pnpm lint` / 全テストが green。
