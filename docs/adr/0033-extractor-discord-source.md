# ADR-0033: extractor への Discord チャンネル履歴ソース追加(capped 漸進型)

- ステータス: proposed
- 日付: 2026-08-21
- 関連: ADR-0017 D7(本文の中間保存禁止・token locality)/ ADR-0018(チャンネル可視性ゲート)/
  ADR-0021・0022(members 対応表)/ ADR-0023(cap + 繰越)/ ADR-0026 D3(源泉日)/
  ADR-0027(人物帰属・機械ガード)/ ADR-0029(自動抽出は厳格側)/ design.md §6.3・P4

## 背景

/ask の検索コーパス(KB)に入る Discord 由来の知識は、現在 💡 capture・voice-memo・gap 回答の
3 経路 = すべてイベント駆動で、チャンネルでの議論そのものは誰かが 💡 を付けない限り失われる。
extractor の対象を Discord チャンネル履歴へ広げ、少しずつナレッジを抽出したい(ユーザ要望)。
設計原則 P4(網羅的事前文書化の禁止)に反しないよう、**cap 付き・カーソル前進型・オプトイン
allowlist** で漸進消化する。

前提制約: `DISCORD_TOKEN` は VM の stratum.env にのみ存在する。GitHub Actions secrets への複製は
ADR-0017 D7 が「露出面の拡大」として却下しており、この判断を維持する。

## 決定

### D1. extractor に統合し、discord ソースのみ VM systemd timer で実行する

新アプリ(discord-collector)は作らず extractor の機能とする(ユーザ裁定)。実行形態はソース別:
ファイルソース(minutes / interviews)= 従来どおり Actions 夜間、discord = VM 週次 timer。
**VM で動かす理由は token locality のみ**(bot.db は使わない — sqlite に履歴テーブルは無く、履歴は
Discord API から直接取る)。別 composition root(`dist/discord/index.js`)とし、Actions 経路の
env.ts / config.ts / run.ts には一切触れない。

### D2. 抽出単位は会話ウィンドウ、source はウィンドウ先頭メッセージの permalink 1 件

時間ギャップ(既定 30 分)/ 件数(既定 50)/ 文字数で区切った 1 ウィンドウ = 1 extract 呼び出し。
`extractionResultSchema` は fork しない(LLM に出典を出させない §9.5 の規律)。source は
`urlToSource(先頭メッセージの permalink)`(kind:"discord" の round-trip は kb-core provenance が
保証済み)。pr-miner の「PR 全候補で 1 source」と同型。

### D3. カーソルは `_meta/extractor-discord-state.json` を KB main へ直接 commit(毎 run 前進)

`{ version: 1, channels: { <id>: { last_message_id, last_processed_at } }, last_run_at }`。
バックログ消化では「抽出 0 件」run が常態のため、nightly の「PR に同梱・merge で前進」方式は
zero-yield でデッドロックする。機械状態の main 直 commit は gap-tracker の前例に倣う。
ナレッジは従来どおり PR 経由、**state は PR に同梱しない**。カーソル不動なら commit しない(no-op)。
commitFiles の non-FF(`GhClientError("CONFLICT")`・リトライ無し実装)は **1 回だけ再試行**し、
それでも失敗なら warn して次回 run に任せる(gap/freshness の main commit と同時刻に走った場合)。

### D4. 💡 capture との多層デデュープ(5 層)

① bot 発言 skip → ② 💡 リアクション付きメッセージ skip(人間が capture 済み/するはず)→
③ KB clone の discord permalink 索引(knowledge/ decisions/ questions/ を 1 パス)で既知 URL を
**LLM 呼び出し前に** skip → ④ reconcile の意味的重複判定 → ⑤ materialize の `sourceKey`
(discord 分岐 = URL 同一性)。収集後に 💡 が付いた場合の二重化は④⑤が受ける(残余リスク)。

### D5. Discord I/O は discord-bot の収集セッションモジュール経由(discord.js を 1 パッケージに閉じる)

extractor に discord.js を直接追加せず、**discord-bot に `openCollectorSession` を新設して
subpath export**(`@stratum/discord-bot/collector`)する。gap-tracker/freshness/evals が使う
`./store` `./freshness` 等 4 本の既存前例と同型で、既にテスト済みの可視性判定
(`visibility.ts` の `gateInputFromChannel` + `isChannelAllowed`)をそのまま再利用できる。
- セッション: 短命 Gateway login(intents **[Guilds] のみ**・presence invisible)→ 可視テキスト
  チャンネル列挙 → REST ページング(`?after=<snowflake>&limit=100`・oldest-first)で履歴取得 → destroy。
- チャンネルゲート: `isChannelAllowed`(permanent_exclude(親 ID 含む)∧ botCanView)に加え、
  discord.yaml の **`targets`(新設のオプトイン allowlist・空 = 機能 OFF)** で開始する。
  ※ channels.yaml の旧 `allow` は ADR-0018 で廃止済み — targets は別物の新設キー。
- bot と同一 token の第 2 Gateway セッションになるが、Guilds intent のみで interaction を受けず、
  presence も invisible のため bot 運用への実害はない。deploy README の「単一インスタンス厳守」は
  bot アプリ(SQLite + 直列キュー)の話であり token の同時セッション数の話ではない。

### D6. fetch → extract → discard(本文は永続しない)

ADR-0017 D7 準拠。永続するのは KB エントリ + permalink + カーソル(snowflake ID)のみ。
(2026-10-01 追記: ADR-0038 で bot が /ask の検索用に本文を別ファイルへ保存するようになったが、extractor は
変更しない。extractor が REST の代わりに保存済み本文から読むかは ADR-0038 の未決事項。)
§9.3 の 4 カテゴリ完全除外は prompt 節 + `applyCandidateGuards`(ADR-0027 D2)の二層。
ADR-0029 の「自動抽出(人が明示的に選んでいない経路)は厳格側」を維持する。

### D7. コスト有界 = per-run caps + カーソル + 週次 timer

`max_channels`(既定 2)/ `max_messages_per_channel`(既定 200)/ `max_extract_calls`(既定 8)+
`EXTRACTOR_DISCORD_TIMEOUT_MS`(既定 300_000)・並列 4。LLM リトライは
`{ maxRetries: 1, shouldRetry: retryableExceptTimeout }`(全 LLM 経路の現行規約)。
cap 超過分は次回へ(カーソルの先に残る)。cap 到達時の対象ローテーションは pr-miner の
`rotateTargets` と同型(**同関数は cap 未設定だと identity になるため caps は必須設定**)。
1 run 最大 1 PR。**open な `extract-discord/*` PR がある間は新規提案もカーソル前進もしない**
(未マージ PR のエントリは③の permalink 索引に載らず、すり抜けるため)。ブランチ prefix
`extract-discord/` は nightly の冪等ガード(`startsWith("extract/")`)にマッチしない = 相互不干渉。
§7.3 の日次予算はリポ全体で未実装のため結合しない。

### D8. 著者の人名正規化(ADR-0031 の延長)

`buildNameResolver` は Discord snowflake を照合しない(設計どおり)ため、discord ソースでは
**収集時に `githubForDiscord ?? nameForDiscord ?? 表示名`**(kb-core members-io)でプロンプトの
著者ラベルを正規化し、LLM 出力には nightly と同じ **guards → `resolvePeople` → materialize** の
順序を適用する。`allowPeopleFallback` は **false(既定)のまま** — チャットの発言者は決定者では
ない(ADR-0027 D1 の思想。pr-miner の author=当事者 1 名とは根拠の強さが異なる)。

### D9. v1 スコープ

スレッドは対象外(v2 候補)。開始点は now − `backfill_days`(既定 90)から**前方のみ**
(全履歴バックフィルはしない)。頻度は週次(Tue 09:00 JST — 既存スロットと重複なし)。
targets 空 = OFF が既定(deploy 済みでも安全)。

### 追記(2026-08-26): `all_visible` モード(D5/D9 の補足)

初回ロールアウト後の運用決定「基本的に全チャンネルを対象にしたい」を受け、v1 で対象外としていた
「全可視チャンネル既定」を**明示オプトイン**として追加した(`discord.yaml` の `all_visible: true`)。

- 母集団 = bot が閲覧できるテキストチャンネル全部(ID 昇順でローテーション・新設チャンネルも自動で対象)。
  `targets` は無視。除外は 2 層: `exclude`(本ソース専用・雑談等)と channels.yaml の `permanent_exclude`
  (bot 全体・ADR-0018 の信頼境界。/ask・💡 にも効くため、本ソースだけ外したいものは `exclude` に置く)。
- P4(網羅的事前文書化の禁止)との整合: per-run cap(`max_channels` / `max_messages_per_channel` /
  `max_extract_calls`)と 1 run 1 PR・未マージ PR 中の見送りは据え置き。全チャンネルを一度に読むのでは
  なく、cap の範囲でローテーション消化する(20 チャンネル前後なら 5 × 週 2 回 ≒ 2 週間で一巡)。
- timer は火 09:00 週次 → **火・金 09:00 週 2 回**に変更(レビュー負荷は「未マージ PR がある間は見送り」で
  自然に減速する)。
- 既定は従来どおり `all_visible: false` + `targets: []` = OFF(deploy 済みでも安全)。

## 影響・トレードオフ

- 通知(notify.ts)はソース種別ラベルを持たないため `label?: string` を追加する(既定 = 従来文言。
  nightly の通知文は不変)。
- KB main への直 commit 主体が gap / freshness / expertise に加えて 1 つ増える。書くファイルは
  それぞれ別なので通常は非競合、同時刻の non-FF は D3 の再試行で吸収。
- チャット由来はファイルソースより低精度になりやすい → 厳格 prompt + guards + 小 cap +
  人間レビュー(PR)で抑える。REAL 化前に dry-run ログで `window_gap_minutes` を調整する。
- Discord REST の 429 は discord.js の内部キューが処理し、caps がリクエスト総量も抑える。

## 却下した代替案

- **別アプリ discord-collector**: ユーザ裁定で extractor 統合(candidate/guards/reconcile/
  materialize/notify を内部 import でそのまま使える利点)。
- **Actions cron**: DISCORD_TOKEN の Actions secrets 複製 = 露出面拡大(ADR-0017 D7 の却下を維持)。
- **extractor へ discord.js を直接追加**: discord.js 依存が 2 パッケージに広がり、テスト済みの
  可視性判定(visibility.ts)を再実装することになる。subpath export の既存パターンに反する。
- **カーソルの PR 同梱(nightly 方式)**: zero-yield run でカーソルが進まずデッドロック。
- **VM ローカルのみのカーソル**: 監査不能・VM 消失で再読(重複抽出)。
- **extractionResultSchema への per-candidate URL 追加**: LLM に出典を出させない §9.5 に違反。
- **raw-REST での権限計算(ADR-0018 D6 案)**: 未テストの独自実装より、bot で実証済みの
  Gateway 判定(visibility.ts)を短命セッションで流用する。
- **本文の中間保存**: ADR-0017 D7 違反。
- **全可視チャンネルを既定対象にする**: P4 違反。targets オプトインで開始する。

## design.md への転記(人間)

- §6.3(C2 extractor): discord ソースの責務・受け入れ条件(cap・デデュープ・カーソル)。
- §7.1 カーソル表: `_meta/extractor-discord-state.json`(main 直 commit・毎 run 前進)。
- §9.2: collector も bot と同一のチャンネルゲート(permanent_exclude ∧ botCanView + targets)。
- §11: 行追加(discord ソース)。
- デプロイ節: VM timer 一覧に stratum-extractor-discord(Tue 09:00 JST)。
