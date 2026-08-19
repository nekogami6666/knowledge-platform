# ADR-0031: 人名正規化の一元化(LLM 出力にも resolver を通す)

- ステータス: proposed
- 日付: 2026-08-19
- 関連: ADR-0027 D1(人物帰属の厳格化)/ kb-core-v6 / design.md §4.2(members.yaml)・§6.3

## 背景

抽出 PR 通知の「関係者」欄と KB エントリの `people`/`owner` に、正規化されていない人名が
混入し続けている。実例(2026-08-18 の PR #38): 「宗石, 松本, 井出, 奥村, Nagata」(姓のみ・
漢字/ローマ字混在)。過去には「会議参加者」(集合名)、「根本くん」(敬称)、「Yosimara Muneishi」
(typo)も通知に出た。コードを追った結果、原因は表記ゆれではなく**配線の欠落**だった。

1. **関係者欄は LLM 生出力そのまま**。`run.ts` の `addPeople` が candidate の `deciders`/`people` を
   無加工で集合に入れ、PR body と Discord 通知に出している。skip された候補すら無条件に載る
   (「会議参加者」が通知に出たのはこれ)。
2. **ADR-0027 D1 で作った正規化はデッドコード**。`parseParticipants` + `buildNameResolver` の結果は
   `materializeOne` の `fallbackPeople` に渡るだけで、extractor は `allowPeopleFallback` を指定しない
   (D1 で出席者フォールバックを廃止した)ため一度も読まれない。
3. **resolver は members に `aliases` が無く漢字姓を解決できない**。さらに戻り値が
   `m.github ?? null` のため、github を持たないメンバー(22 人中 10 人)はフルネームが完全一致
   しても null(= 生名のまま)になる。
4. **`COLLECTIVE_DECIDER_NAMES` ガードは deciders のみ**。learning の `people` と `owner` は無防備で、
   `owner: "会議参加者"` が成立しうる。
5. 下流汚染: expertise-mapper(kb-collector)は `people`/`deciders` を GitHub ユーザ名前提で集計する
   ため、姓だけの名前がゴースト人物として専門性マップに蓄積される。

members.yaml の実データは 22 人・**姓の完全一致衝突ゼロ**(宗石→Muneishi、松本→Matsumoto、
井出→ide、奥村→Okumura、Nagata→Shoma Nagata がすべて一意)。ただし前方一致は
Nagai/Nagata・Matsumoto/Matsuhashi で衝突し、「最終トークン=姓」は Yoshikawa Hiroshi(姓が先頭)で
誤爆する。

## 決定

### D1. members.yaml に `aliases` を追加する(kb-core-v6)

`memberSchema` に `aliases?: string[]`(nonempty・optional)を追加する。**解決専用**の別表記
(漢字姓・旧表記・typo の吸収先)であり、表示には常に `name` を使う。スキーマは strict のまま。
破壊的変更として **kb-core-v6** を切り、前例(ADR-0026 → v4 / ADR-0027 → v5)どおり
「kb-core merge → タグ → KB `validate.yml` の ref 更新 → データ PR」の順でロールアウトする。
逆順(タグ反映前に aliases データ投入)は validate 赤で fail-closed になる。

### D2. resolver の戻り値を `github ?? name` にする

`buildNameResolver` はヒットしたメンバーの `github` が無ければ `name` を返す(現状は null)。
「members に載っている人は必ず正規名に揃う」を保証する。github を持たない 10 人が対象。

### D3. LLM 生出力(deciders / people)にも resolver を通す

ガード適用(`applyCandidateGuards`)直後の一点で、extraction の全候補の `deciders`/`people` を
`resolvePeople`(map + 解決失敗は生名保持 + dedupe)で正規化する。以降の materialize・関係者欄・
未解決の問い起票がすべて同じ規律に乗る。**members に無い名前は破棄しない**(外部出席者の保護。
ADR-0027 が「members 外の破棄」を却下した判断を維持する)。

### D4. materialize の people / owner にも人物ガードを広げる

`isValidDecider`(集合名・記号除去)を `isValidPerson` に一般化し、learning の `people` からも
集合名・非人物を除去する。`owner` は先頭の**有効な**人物(無ければ `unassigned`)。

### D5. 一意トークンの完全一致解決(補助)

各メンバーの `name`/`aliases` を空白で分割したトークンのうち、**全メンバーを通して一意なものだけ**を
完全一致キーとして resolver の索引に加える(「Nagata」→ Shoma Nagata)。衝突するトークンは索引に
入れない(解決しない=生名保持で安全側)。**前方一致・部分一致・「最終トークン=姓」の推測は恒久的に
禁止**(上記の衝突・誤爆例のため)。将来同姓が入社した時点でそのトークンは自動的に索引から消え、
aliases のデータ追加で回復できる。

### D6. プロンプトで人名表記を指示する(extract v4)

extract.md / extract-interview.md に「人名は参加者欄のフルネーム表記で書く。姓のみ・敬称・集合名・
愛称を書かない(システムが members.yaml で正規化する)」を追記し、既存の「固有名詞は議事録の
表記のまま」が**人名には適用されない**ことを明示する(現状この規定が姓だけ表記を正当化してしまう)。

## 却下した代替案

- **members に無い名前の破棄**: 外部出席者・未登録メンバーの帰属が消える。ADR-0027 の判断を維持。
- **前方一致・姓ヒューリスティクスによるコードのみの解決**: Nagai/Nagata 等で誤帰属する。誤った
  帰属は「無い」より悪い(expertise マップ・鮮度確認 DM の宛先を汚す)。漢字姓はデータ(aliases)で
  しか安全に解決できない。
- **通知側(notify)だけの整形**: KB エントリと問い起票の汚染が残る。上流一点(D3)で叩く。

## 実装・ロールアウト

1. kb-core: `aliases` 追加(v6)→ 人間がタグ → KB `validate.yml` ref 更新 PR → members.yaml へ
   aliases データ PR(宗石/松本/井出/奥村/根本 ほか一意性を検証して選定)。
2. extractor: resolver 強化(D2/D5)+ `resolvePeople` 配線(D3)+ materialize ガード(D4)+
   プロンプト v4(D6)。データ投入前でも後方互換(解決率が低いだけ)。

## design.md への転記(人間)

- §4.2 members.yaml: `aliases` の追加と「解決専用・表示は name」の規定。
- §6.3 extractor: 人名は抽出後に members.yaml で正規化される(LLM 出力を信頼しない)の一文。
