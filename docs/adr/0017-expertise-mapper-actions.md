# ADR-0017: expertise-mapper は GitHub Actions で実行し、人物統合は GitHub ユーザ名 + KB `_meta/members.yaml` 単一ソースとする

- **ステータス**: accepted(2026-07-16。#38〜#49 マージ済み・EXPERTISE_REAL 稼働開始・転記リスト反映・本 PR のレビューをもって採択)
- **日付**: 2026-07-13(起案)/ 2026-07-14 改訂 — 初稿の D3(mapper 設定に写し・二重管理)を
  ユーザ裁定(2026-07-13)で撤回し、**KB `_meta/members.yaml` 単一ソース化**に差し替え。D7(Discord
  発言収集)を初版スコープ外へ格下げ。push 前のため履歴は amend
- **関連**: design.md §4.2 L260(人物識別子 = GitHub ユーザ名 — 本 ADR で保存先を改訂)・
  §4.1.2 L210-212(`_meta/` 構成図)・§4.6 L337(`_meta` の性格)・§4.5(expertise.yaml)・
  §6.6 ⑤-a(要件と AC)・§9.2/9.3・§14#8(マッピング表)/
  ADR-0009(deep = Claude on AWS)・ADR-0013(Actions の REAL ゲート・vars→yaml 生成)・
  ADR-0014(実行基盤の判断基準)・ADR-0016(実行形態 3 系統)
- **備考**: 採択(`accepted`)および design.md への転記(下記「design.md 転記リスト」)は人間レビューで行う。

## 背景

§6.6 ⑤-a は expertise-mapper の入力を「議事録の発言者・knowledge-base の people・対象リポの
commit author・Discord 技術チャンネル発言(90 日)」と定めるが、次が未確定だった:

1. **実行基盤**: §3.2 は「GitHub Actions cron」とするが、gap-tracker は ADR-0014 で VM に移った
   前例があり、判断基準(bot ローカル状態に触るか)での再確認が必要。
2. **人物の統合方法**: 4 つの evidence ソースの識別子がバラバラ(議事録 = 日本語の発言者ラベル /
   KB = owner・people / commit = author / Discord = ユーザ ID)。
3. **対応表の置き場**: github↔discord の写像は discord-bot の `members.yaml`(§4.2 L260)にあるが、
   実値ファイルは VM 上(gitignored)で Actions からは読めない。本 ADR の初稿は「mapper 設定に
   写しを持つ(二重管理)」としたが、**ユーザ裁定(2026-07-13)で単一ソース化が確定**した。
4. **expertise.yaml の書き込み経路**: 自動生成物(手編集禁止・§4.5)を PR にするか直 commit にするか。

裁定の理由: ①§14#8「各自申告」を PR という既存手続きに乗せられる ②freshness-checker /
interview-kit も同じ表を必要とするため一度払えば回収できる ③二重管理のドリフトを構造的に排除。

## 決定

### D1. 実行基盤は GitHub Actions(週次 cron + workflow_dispatch)

- 入力は KB(checkout)・GitHub API・(将来)minutes checkout / Discord REST で**リポジトリ/API で
  完結**し、bot.db に触れない → ADR-0014 の判断基準どおり Actions(ADR-0016 の 3 系統の「リポ完結バッチ」)。
- extractor/pr-miner の確立パターンを踏襲: 設定は vars から CI 生成(ADR-0013 D3。**ただし members
  対応表は vars に置かない — D3**)、**`EXPERTISE_REAL` ゲート・既定 dry-run**(コメントアウト)、
  初回は監督付き(ADR-0013 D1(d) 流儀)。

### D2. 人物識別子は GitHub ユーザ名。初版(v1)の evidence は「KB + commit」の 2 ソースに限定

- **KB エントリ**: knowledge/ と decisions/ の frontmatter `owner`・`people`(GitHub ユーザ名・既定)
  → そのまま使う。questions/ は対象外(回答は answered エントリ化された時点で owner/people に
  現れる — 二重計上を避ける)。
- **commit author**: `git log` の email 写像は行わず、**GitHub API の author login** を使う
  (gh-client の読み取り API。email→人物の推測写像という誤りやすい層を丸ごと排除)。
- **この 2 ソースはどちらも初めから GitHub ユーザ名 → 対応表(D3)が空でも v1 は完全に動く。**
- 議事録の発言者ラベル(日本語名)の写像 `speaker_labels` は **v1 のスキーマに載せない**。
  議事録 evidence コレクタを足す将来 PR で、スキーマ拡張(kb-core・validateRepo・fixture の再波及)
  とセットで導入する。導入時は未登録ラベルを silent drop せずレポートに列挙する方針を維持。

### D3. members 対応表は KB `_meta/members.yaml` を唯一の正とする(ユーザ裁定 2026-07-13)

- **スキーマは kb-core に新設**(型の唯一の正): `membersSchema` =
  `{ members: [{ github: string(min1), discord: string(min1) }] }`(`.strict()`)+ 純関数
  `parseMembers(raw)`(js-yaml `JSON_SCHEMA` → zod)。
- **validateRepo は「存在すれば検証・不在は許容」**(expertise.yaml と同型。§14#8 未決で空の期間が
  あるため)。`not_a_kb` 判定のシグナルには含めない。
- **consumer の読み方**:
  - mapper(Actions): KB checkout から `parseMembers` で読む。
  - discord-bot: ローカル `apps/discord-bot/config/members.yaml` を**廃止**し、KB clone
    (`CLONES_DIR/<kb dir>/_meta/members.yaml`)から **capture/voice 実行のたびに都度読み**。
    起動時 1 回 load にしない — KB clone の同期は `/ask` ごと(ask.ts)で起動時には走らず、
    起動直後は clone が無いことがあるため。不在・読取失敗・parse 失敗は**空の対応表 + 警告ログ**で
    続行(owner は従来どおり `"unassigned"` にフォールバック)。
  - **GitHub API 読みは却下**: 認証と障害点を増やす割に clone 読みへの優位が無い。
  - **Actions vars に対応表は置かない**: 申告が Settings 操作になり PR レビューに乗らない。
- **反映ラグ**: KB へ commit → 次の `/ask` で clone 更新 → 以後の capture/voice に反映(数分)。
  bot 再起動は不要。fresh boot から初回 `/ask` までは空表 + 警告(許容)。
- **gap-tracker の `assignees` は統合しない**: あれは「回答依頼を振ってよい人の curated プール」
  (週 3 件ラウンドロビンの母集団)であり全員名簿とは別概念。単純置換は selectAssignee の母集団を
  全メンバーに広げてしまう。ただし **既知の課題として記録**: gap-tracker は質問者の discord→github
  解決にも assignees を流用しており(index.ts の githubForDiscord/discordForGithub)、assignees に
  居ない質問者の `asked_by` が `discord:<id>` に落ちる。単一ソース化後は本表へ付け替える
  (**C6 範囲外・C6 完了後の独立 PR**。依頼メンション用 discord ID を assignees に残すかもその PR で判断)。
  - **解決済み(2026-07-22)**: `githubForDiscord`/`discordForGithub` とも members 優先 + assignees
    フォールバックへ付け替え(`question.ts` の resolve*、`close.ts` の `resolveAskerMention`)。
    判断: **依頼メンション用 discord ID は assignees に残す**(依頼 ping の正は gap.yaml、
    質問者通知・リマインドの逆引きは members 優先)。`selectAssignee` の母集団は assignees のまま。

### D4. なぜ人物マスタを KB `_meta/` に置くのか(射程の限定)

`_meta/` の従来の中身はカーソル(state.json)と採番(id-counter.json)= **機械が生成 commit する
内部状態**であり(§4.6 L337)、validateRepo も走査しない。そこに人間が編集する名簿を置くのは
性格の混在なので、判断を明示する:

- **置く理由**: (a) bot・mapper・freshness-checker・interview-kit の全 consumer が KB を
  読む/checkout する — 全員に見える共有場所はここしかない。(b) 各自申告(§14#8)を KB への PR と
  いう既存のレビュー手続きに乗せられる。(c) ナレッジエントリではない(frontmatter スキーマ対象外)
  ため knowledge/ 配下には置けず、`_meta` = 「KB 本体ではない付帯データ」の既存区画が最も近い。
- **射程の限定**: 今後 `_meta/` に「アプリが読む設定的データ」を置いてよいのは、
  **(a) 複数 consumer が KB 経由で読む価値があり、(b) PR レビューに乗せるべき組織横断データ**、
  の両方を満たすものに限る。bot 固有の運用設定(channels/ops/voice 等)は置かない。
- **validateRepo 上の扱い**: 「`_meta/` は走査しない」原則は保ちつつ、`members.yaml` **のみ名指しで
  検証**する(人間が編集する例外ファイルのため構造ガードが要る。機械専用の cursors/counters は
  従来どおり非検証)。

### D5. 出力は main 直 commit(PR にしない)+ validateRepo 前条件

- `expertise/expertise.yaml` と `expertise/reports/<date>.md` は**自動生成物・手編集禁止**(§4.5)
  なので人間レビュー(PR)の対象にせず、gap-tracker の questions commit(ADR-0014 D4)と同じく
  `commitFiles` で main へ直 commit する。**push 前にローカル validateRepo を通す**ことを前条件とする。
- 冪等: 生成結果が現状と同一なら commit しない(再実行安全・§7.1)。
- risk:high のトピックは `DISCORD_OPS_WEBHOOK` で #stratum-ops に通知し、インタビュー実施を提案(§6.6)。

### D6. クラスタリングは deep の増分更新、指標はコードで決定論的に

- LLM(deep・ADR-0009)がやるのは**トピックへの割当と新 topic の命名だけ**。既存 expertise.yaml の
  トピック一覧(topic/label)を必ず入力に与え、**増分更新**する(毎回ゼロから再生成しない —
  トピック名の週跨ぎ安定 9 割が AC・§6.6)。
- `evidence_count`・`last_active`・`bus_factor`・`documented_kb_count`・`risk` は**コードで算出**する。
  risk 規則は §4.5 のコメントを正典化: **bus_factor = 1 かつ documented_kb_count < 5 → high**
  (それ以外は low/medium をしきい値で決め、実装 PR で定数化)。

### D7. Discord 発言収集は初版スコープ外(将来 PR)

- **v1 には含めない**。理由: 対応表(D3)が空のうちは Discord ID → GitHub 名が引けず、集計しても
  誰の evidence か分からない。表が埋まる前に bot トークンの露出だけ買う理由がない。
- **追加の条件**: `_meta/members.yaml` が実際に埋まり discord→github が引けること。その時点で
  bot トークンを Actions secret に追加する(露出面の拡大が発生することを明記)。
- 導入時の方針は維持: 対象は channels.yaml と同じ allowlist・直近 90 日(§9.2)、保存は
  **集計値(人×チャンネルの件数・最終発言日)のみ**でメッセージ本文は残さない(§9.3 を
  データ構造で遮断)。

## 影響・トレードオフ

- **利点**: 対応表の二重管理を構造的に排除。§14#8 の申告が PR レビューに乗る。C8/C7 も同じ表を
  再利用できる。v1 は GitHub 名空間で完結するため**表が空でも今日から動く**。
- **波及を前払いする**: kb-core スキーマ + validateRepo + bot 読み替え(Phase M として C6 本体の
  前段に実施)。KB リポ(別リポ)側にも雛形 + README 申告手順が必要。
- **members 鮮度が `/ask` の clone 更新に従属**: bot は起動時に sync しないため、fresh boot から
  初回 `/ask` までは空表。空表フォールバック(unassigned)が安全なので許容。
- **`_meta` の性格が混在する**(機械状態 + 人間編集の名簿)。D4 の射程限定でスコープクリープを防ぐ。
- v1 の evidence は KB + commit のみで、Discord・議事録の貢献は当面計上されない(将来 PR で拡張)。

## 却下した代替案

- **mapper 設定に写しを持つ二重管理(本 ADR 初稿の D3)** → ドリフトが構造的に発生し、§14#8 の
  申告が PR に乗らない。ユーザ裁定(2026-07-13)で撤回。
- **Actions vars に対応表を置く** → 申告・変更履歴が Settings 操作になりレビュー不能。却下。
- **bot が GitHub API で members.yaml を読む** → 認証・レート・障害点が増える割に clone 読みへの
  優位が無い(反映ラグは D3 の都度読みで十分短い)。却下。
- **git log の author email → GitHub ユーザ写像** → noreply・複数メール・表記揺れの写像表を人間が
  維持することになる。GitHub API の login で代替可能。却下。
- **VM systemd で実行(gap-tracker 相乗り)** → bot.db に触れないため VM に置く理由がない。却下。
- **expertise.yaml を PR 経由で更新** → 自動生成物に週次の承認負担(P3 違反)。validateRepo
  前条件で構造ガード。却下。
- **Discord メッセージ本文の保存・埋め込み検索** → §1.3 非目標 + §9.3 リスク。却下。

## design.md 転記リスト(人間レビュー・保護パス)

- **§4.2 L260**: 「マッピングテーブルを discord-bot の設定(`apps/discord-bot/config/members.yaml`)に
  持つ」→ **KB `_meta/members.yaml` 単一ソース**に(正面から矛盾する筆頭)。
- **§4.1.2 L210-212**: `_meta/` 構成図に `members.yaml`(人間が申告で編集する名簿)を追記。
- **§4.6 L337**: `_meta` の性格説明に members 名簿の例外を追記(D4 の要旨)。
- **§14#8**: 申告先を「KB `_meta/members.yaml` に各自 PR」に更新。
- **§3.2 C6 行**: 実行基盤 = GitHub Actions の確定。

## 検証

- Phase M: kb-core は valid/invalid fixture(members あり・なし・壊れ)で validateRepo を検証。
  bot は fake clone dir で「members あり/なし/壊れ → owner 解決 / 空表 + 警告 / unassigned」を検証。
- C6 v1: 各コレクタは fixture/fake(集計値の断言)。クラスタリングは fake LLM で既存トピック保持
  (名前安定)を検証。risk 算出は純関数テスト。**members 空で v1 が完走する**ことをテストで担保。
- dry-run(実データ読み取り・書き込みゼロ)で expertise.yaml 差分を目視 → `EXPERTISE_REAL` は
  監督付き初回の後に有効化(ADR-0013 D1(d) 流儀)。
- AC(§6.6): 手編集なしの週次更新 + トピック名の週跨ぎ安定 9 割(数週の運用で観測)。
