# ADR-0026: エントリ ID をランダム化して `_meta/id-counter.json` を廃止し、エントリ日付は源泉日を使う

- **ステータス**: proposed
- **日付**: 2026-08-12
- **関連**: design.md §4.1(`_meta/id-counter.json`)・§4.2(ID 規約・`created`)・§4.3/§4.4(例示)・
  §6.1(`allocateId`)・§6.4(voice の ID カウンタ同梱)/
  [ADR-0003](0003-kb-core-frontmatter-schema.md)(counter 形式)・[ADR-0004](0004-github-app-and-validate-ci.md) D2 /
  KP issue #92(counter 巻き戻しによる ID 再利用事故)/ KP #103(extractor open-PR ガード)/
  `packages/kb-core/src/{schemas/common.ts,id-allocator.ts}`・書き手5経路(extractor / pr-miner /
  gap-tracker / capture / voice)

## 背景

KB へ PR を作る5つの書き手は全員が「連番 ID の採番結果 = `_meta/id-counter.json`」を PR に同梱する。
このため**同時に open な KB PR は、1本目のマージで残り全部が必ずコンフリクト**する(全 PR が同じ
counter 値から採番するため、counter 行と割当 ID の両方が衝突する)。実害:

1. extractor の夜間 PR が未マージのまま9本滞留(2026-07-26〜08-10)。ガード(#103)で自己増殖は
   止めたが、**異種書き手間(extractor × pr-miner × capture × voice × gap)の衝突は構造のまま**。
2. issue #92: KB のテストデータ巻き戻しで counter が後退し、**同じ ID が別質問に再発番**されて
   gap-tracker が無関係な質問を answered へ誤移動した(counter という「巻き戻り得る中央状態」が根因)。
3. capture は採番のためだけに GitHub API を往復し(`allocateCaptureId`)、materialize は採番順序性の
   ために逐次実行を強いられている。

また、エントリの日付(`created` / `date` / `last_verified`・ID の年)は**抽出を実行した日**になっており、
知識の実際の時点(議事録の日付)と乖離する(6月の会議の知見が `created: 2026-08-10` になる等)。

事前調査(2026-08-12)で、**ID の連番性・数値部分に依存するコードはゼロ**(ID は全コードで不透明
文字列。唯一の例外は ID から「年」を取る `yearOf()`)、**validateRepo は counter を一切参照しない**
(重複検査は実ファイル走査)ことを全数確認済み。

## 決定

### D1. エントリ ID を `<kind>-<YYYY>-<ランダム6文字>` にする(連番廃止)

- 形式: `kb-2026-a3f8x7` / `dr-2026-k0m2pq` / `q-2026-b7c1zx`。suffix は **base36(`[0-9a-z]`)6文字固定**。
  - 6文字の根拠: 年内 36⁶ ≒ 22億通り(年500件で衝突率 0.006%)。万一衝突しても KB validate CI の
    `duplicate_id` 検査が PR を赤にして止める(既存の検査がそのまま安全網になる)。
  - **旧形式(ちょうど4桁数字)と長さで機械判別**できる(4桁=旧連番 / 6文字=新ランダム)。
  - **suffix に `-` を含めない**(ファイル名 `<id>-<slug>.md` から ID を切り出す `ID_PREFIX_RE` の
    前方一致が slug に食い込まないための唯一の設計制約)。
  - **年は維持する**: `decisions/<年>/` の配置(`yearOf()`)と人間の当たり付けのため。時刻情報では
    なく粗い名前空間として使う。
- スキーマは**新旧の和**に緩和する(`/^kb-\d{4}-(\d{4}|[0-9a-z]{6})$/` 等)。**既存エントリの旧 ID は
  リネームせず恒久共存**(design.md §4.2「ID は不変」の原則どおり。`supersedes` / `resulting_kb` /
  bot.db 台帳 / Discord に残る依頼メッセージ内の q-ID もすべて有効なまま)。
- タイムスタンプ ID は不採用(却下理由は後述)。

### D2. `_meta/id-counter.json` と CAS 採番(`allocateId` / `IdCounterStore`)を廃止する

- kb-core に `newId(kind, deps?)`(乱数採番・約20行)を新設し、`allocateId` / `IdCounterStore` /
  `createLocalIdCounterStore` / `IdCounterConflictError` / `KbIdError` を削除する(**kb-core の破壊的
  API 変更 = `kb-core-v4` タグとして扱う**)。乱数はテスト決定性のため seam 注入(`now` 注入と同じ流儀)。
- 書き手5経路から「counter の読み込み・PR/commit への同梱」を削除する。副次効果:
  - capture の採番用 GitHub API 往復が消える(高速化)。
  - materialize の「採番順序性のための逐次実行」制約が消える(将来並列化可・本 ADR では変更しない)。
  - **KB を巻き戻しても ID が再発番されない** = issue #92 の事故クラスが構造的に消滅
    (gap_pr 台帳の `asked_at` 整合ガードは多層防御として維持)。
- **意図的に失う性質**: capture は「counter 競合 → mergeable_state != clean → 代理マージ拒否」を
  並行 💡 の直列化に流用していた(capture.ts 冒頭コメント)。本 ADR 後は**並行 💡 が両方そのまま
  マージ可能**になる(望ましい挙動)。重複「ID」は CI が防ぎ、重複「内容」は従来どおり人間レビューの責務。
- counter ファイルは当面**凍結**(誰も読まない。validateRepo は `_meta/` 非走査のため残置で無害)。
  デプロイ安定後に KB 側の小 PR で削除してよい。

### D3. エントリ日付は「源泉日」を使う(抽出日ではなく知識の時点)

- **extractor**: 議事録パス(`.../2026-06/2026_06_11_from_18-59_.../minutes.md`)から日付を**機械的に
  パース**し(LLM 不使用・パース不能時は従来どおり実行日にフォールバック)、
  - KnowledgeEntry の `created` / `last_verified` = 議事録の日付
  - DecisionRecord の `date` = 議事録の日付(「会議で決めた日」— 従来の抽出日は実質不正確)
  - **ID の年も源泉日由来**(年またぎ抽出でも `kb-<知識の年>-…` になる)
- **pr-miner**: 源泉日 = 対象 PR の `mergedAt`。
- **gap 回答・💡 capture・voice は変更なし**(発言・録音の時点 = 現在なので `now()` が正しい)。
- duplicate(sources 追記)は既存エントリの `created` を維持。supersede の新エントリは新しい源泉日。
- 副作用(意図された挙動): 古い議事録から抽出した知識は `last_verified` が古くなるため、freshness の
  鮮度確認が実態どおり早く回ってくる。バースト分は `daily_limit_per_owner`(既定2)が吸収する。

## 影響・トレードオフ

- **利点**: 同時 open な KB PR が互いに独立になり、マージ順序の制約・コンフリクト・「後着 close →
  再生成」の運用が消える。ID 再利用事故の構造的消滅。capture 高速化。正味 −400 行の純減。
  日付が知識の実時点を指す(検索・鮮度管理・監査の正確性向上)。
- **コスト**: kb-core 破壊的変更(v4 タグ + knowledge-base 側 validate.yml の ref 更新の 2 リポ協調)。
  テスト9本の書き換え。ID から連番の「若さ/古さ」感は読めなくなる(順序は `created` を見る)。
- **ロールアウト順序(必須)**: ①スキーマ緩和を先に merge → `kb-core-v4` タグ → KB validate.yml を
  v4 へ(この時点で旧 ID も新 ID も緑)→ ②書き手を新採番へ切替。逆順だと新 ID の初回 PR が旧 CI で赤。

## 却下した代替案

- **タイムスタンプ ID(`kb-2026-0812-143059` 等)**: 書き手は cron で同時刻に発火するため衝突が
  時刻相関で集中する / extractor は 1 run で約40件をミリ秒ループ採番するため結局「同時刻の枝番」=
  連番管理が縮小復活する / 採番時刻 ≠ 知識の時刻で ID が嘘をつく(D3 と矛盾)/ ID 順ソートに依存する
  コードが存在せず利点を使う場所がない。却下。
- **マージ時採番(サーバ側リネーム)**: PR 本文・通知・gap_pr 台帳が採番前の ID を参照しており、
  マージ後リネームは参照を全て壊す。ステートフルで複雑。却下。
- **書き手ごとの counter 分割**: ファイル衝突は減るが ID 空間の分離(形式変更)が結局必要で、
  中央状態(巻き戻り事故)も残る。D1 の下位互換。却下。
- **ULID / UUID**: ソート可能性は不要(上記)・26〜36文字はファイル名/Discord 通知/出典表示で
  可読性を損なう。却下。
- **既存エントリの新形式への一括リネーム**: 参照(supersedes / resulting_kb / 台帳 / Discord 内
  メッセージ)を壊すリスクに対して得るものが無い。旧 ID 共存で十分。却下。

## design.md 転記リスト(人間レビュー・保護パス)

- §4.1(:212): `id-counter.json` の行を削除。
- §4.2(:220): `id` コメントを「`kb-<年>-<ランダム6文字>`(旧: 4桁連番も有効)」へ。`created` の
  意味論を「源泉日(議事録の日付等)」と明記。
- §4.3(:270)/§4.4(:302,305): 例示 ID を新形式に(旧形式併記)。
- :340: 「採番」の記述を削除ないし更新。
- §6.1(:423): `allocateId` → `newId`(乱数・CAS 不要)へ書き換え。
- §6.4(:491): 「ID カウンタ同梱」を削除。

## 検証

- ユニット: `newId`(形式 `/^(kb|dr|q)-\d{4}-[0-9a-z]{6}$/`・`-` 不含・seam 決定性)/ スキーマ新旧
  両受理(5文字・大文字・`-` 入りは拒否)/ `minutesDateFromPath`(正常・変則→null)/ materialize の
  日付3種 + ID 年 / 書き手5経路の PR files に `_meta/id-counter.json` が**含まれない**こと。
- 実機: 💡 capture → 新形式 ID・counter 非同梱・validate 緑。**capture PR を open のまま夜間
  extractor PR と併存させ、片方をマージしてももう片方が CLEAN のまま**(本 ADR の目的の直接実証)。
  6月議事録由来のエントリが `created: 2026-06-XX` / `id: kb-2026-…` になる。
- 既存 KB(旧 ID 49件)が kb-core-v4 の validate で緑のまま(後方互換の実証)。
