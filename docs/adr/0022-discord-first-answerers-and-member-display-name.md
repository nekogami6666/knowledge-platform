# ADR-0022: 回答者候補(assignee)を Discord 主キー化し、members.yaml に表示名(`name`)を追加する

- **ステータス**: accepted(2026-07-23 人間承認)
- **日付**: 2026-07-23
- **関連**: [ADR-0017](0017-expertise-mapper-actions.md) D3(members 単一ソース・assignees プール)/
  [ADR-0021](0021-members-schema-optional-github-and-alts.md)(`github` optional 化)/
  design.md §4.2(人物識別子)・§4.4(questions frontmatter)・§6.5(gap-tracker)/
  `apps/gap-tracker/src/{config,question,run,index,close}.ts`・`packages/kb-core/src/{schemas/members,members-io,schemas/question-log}.ts`
- **備考**: 採択済み(人間承認 2026-07-23)。design.md への転記は人間タスクとして残る。

## 背景

ADR-0021 で members.yaml の `github` は optional になり、GitHub 未所持メンバー(実データで 22 名中 10 名)を
名簿に載せられるようになった。しかし **gap-tracker の回答者候補(`assigneeSchema`)は `github` 必須**のままで、
GitHub 未所持メンバーを回答者プールに入れられない(ユーザ要望「回答者は全員(discord)で管理したい」に反する)。

調査で判明した設計上の好条件:
- **`assignee`/`asked_by` は kb-core で自由文字列**(`question-log.ts:14,19` = `z.string().min(1)`。GitHub 名は
  慣習であってスキーマ強制ではない)。`asked_by` には既に **`discord:<id>` 番兵形式**の実績がある(`question.ts:83`)。
- **依頼メンションは既に Discord ネイティブ**(`question.ts:155` `<@assignee.discord>`)。GitHub 依存は
  「選定 / 予約 / KB 記録 / リマインド逆引き / expertise 突合」の gap-tracker 内 5 系統に限局。
- **フルネーム(表示名)の構造化フィールドは現状ゼロ**(members.yaml は YAML コメントのみ)。Discord 通知は
  メンションで表示名が出るが、expertise レポート・GitHub PR 本文・KB 上は生の GitHub 名になる。

## 決定

### D1. 回答者候補を Discord 主キーにする(gap-tracker)

- `assigneeSchema`(`apps/gap-tracker/src/config.ts`): `discord` 必須のまま **`github` を optional 化**、`name` を許可。
- **選定 `selectAssignee`・予約(rate-limit subject `assignee:<discord>`)・tried セット**のキーを `github` → **`discord`** へ。
  bot.db の `rate_limits` は汎用テーブル(subject 文字列値)なので**スキーマ変更なし**。切替週は旧 subject 行が
  dead になりカウントが実質リセットされる(無害)。
- これにより GitHub 未所持メンバーも回答者プールに入り、全員が週 3 件ラウンドロビンの母集団になる。

### D2. KB 記録(`assignee`/`asked_by`)を「github あれば github、無ければ `discord:<id>`」に統一

- `buildQuestion` の `assignee` 値を `asked_by` と同一規約に: `githubForDiscord(discord) ?? \`discord:${discord}\``。
- リマインド/完了通知の逆引き(`close.ts`)は **二形式対応**: `discord:<id>` は直接メンション、GitHub 名は
  従来どおり `discordForGithub` で逆引き(**旧 github 値の後方互換**を保つ)。
- kb-core スキーマは自由文字列のまま(変更不要)。design.md §4.4 の「assignee=GitHub 名」規約のみ更新。

### D3. members.yaml に `name`(表示名・フルネーム)を追加する

- `memberSchema`(kb-core)に `name: z.string().min(1).optional()` を追加(`.strict()` へ宣言・後方互換)。
  helper `nameForDiscord` / `nameForGithub`(primary/別名両対応)を新設。
- `name` は**表示専用**で、人物解決キー(github/discord)には使わない(フルネームを解決キーにすると逆引き不能に
  なるため。表示と解決を分離する)。
- 人間向けサーフェスは **`name ?? github ?? <@id>`** の優先で実名化: expertise レポート(`report.ts`/`run.ts`)、
  GitHub PR 本文の起票者/投稿者(`capture.ts`/`voice-pipeline.ts`。GitHub 上でメンションが inert な箇所)。
- Discord 通知はメンションで表示名が自動描画されるため無変更。
- members.yaml への `name` 追加は kb-core スキーマ更新を伴うため、KB validate CI のタグを **kb-core-v3** へ上げる
  (ADR-0021 → kb-core-v2 と同じ運用)。

### D4. expertise は GitHub 名のまま集計し、突合時に写像する

- `expertise.yaml` の `people[].name` は GitHub login(commit author / KB owner 由来)のまま。gap-tracker が
  `rankByExpertise`(GitHub 名)の結果を **`discordForGithub` で discord へ写像**してから discord 主キーの
  assignees と突合する。GitHub 未所持メンバーは expertise に載らない → ラウンドロビンで公平に回る(正常)。

## 影響・トレードオフ

- **利点**: GitHub を持たない全メンバーを回答者にできる。フルネーム表示の単一供給源(members.yaml `name`)が
  でき、expertise レポート等が人間可読になる。依頼メンションは既存のまま。
- **後方互換**: 既存 KB の `questions/*.md`(`assignee: nekogami6666` 等 GitHub 名)は D2 の二形式解決で無改修で動く。
  `name` は optional なので既存 members.yaml も無影響。gap-tracker の `assigneeSchema` は `.strict()` でないため緩い。
- **design.md §4.2 の「人物識別子=GitHub ユーザ名」は保持**(解決キーは github/discord のまま)。`name` は表示層の
  追加であって識別子の置換ではない。assignee 値のみ discord 番兵を許容する点を §4.4 に明記。
- **切替コスト**: gap-tracker の 5 系統 + テスト、kb-core の name、KB の name データ + タグ v3。

## 却下した代替案

- **フルネームを解決キー(assignee 値)にする** → `discordForGithub`/`discordForGithub` 逆引きが不能になりメンション
  欠落。表示と解決を混ぜない(D3)。却下。
- **gap.yaml assignee にだけ name を持つ** → gap-tracker ローカルに閉じ、expertise/PR 本文/KB に及ばない。
  members.yaml 単一ソース(D3)の劣化版。却下。
- **assignee 値を常に `discord:<id>` に統一(github があっても)** → KB frontmatter の可読性が落ち、既存 github 値との
  不整合が増える。「github あれば github」で既存規約と連続性を保つ(D2)。却下。

## design.md 転記リスト(人間レビュー・保護パス)

- **§4.2**: 「表示名(フルネーム)は `_meta/members.yaml` の `name` を唯一の構造化供給源とする(表示専用・解決キーは
  github/discord のまま)」を追記。
- **§4.4**: `assignee`(および `asked_by`)の値規約に「GitHub 名が引ければ GitHub 名、無ければ `discord:<id>`」を明記。
- **§6.5**: 回答者選定・予約・リマインドの主キーが Discord ID である旨(GitHub 未所持者も母集団)を追記。

## 検証

- kb-core: `members-io.test.ts` に `name` parse + `nameForDiscord`/`nameForGithub`(primary/別名/未設定)を追加。
  fixture `valid-kb/_meta/members.yaml` に `name` 付き行。
- gap-tracker: `config.test`(github optional)・`question.test`(selectAssignee discord キー・buildQuestion 値)・
  `run.test`・`expertise.test`(preferred の github→discord 写像)・`close.test`(discord:<id> と github 旧値の
  二形式メンション)を更新。
- E2E: nekogami6666(現行 github)→ 全員(discord・未所持者含む)の 2 段で dry-run→real。KB validate CI が
  kb-core-v3 で `name` を実検査して緑。
