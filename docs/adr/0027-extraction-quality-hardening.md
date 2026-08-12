# ADR-0027: 抽出品質の堅牢化 — 人物帰属の厳格化・不確実性/安全の機械ガード・open question の接続

- **ステータス**: proposed
- **日付**: 2026-08-12
- **関連**: design.md §6.3(C2 抽出フロー)・§4.2(人物識別子)・§4.4(questions)/
  [ADR-0023](0023-extractor-resilient-partial-processing.md)・[ADR-0026](0026-random-entry-ids-and-source-dates.md)/
  KP issue #104(deciders 汚れ)/ knowledge-base PR #30 の人間レビュー所見(2026-08-12)/
  `apps/extractor/src/{run,materialize,candidate}.ts`・`prompts/extractor/*`

## 背景

初の本格的な実 PR(KB #30・52候補)の人間レビューで、抽出品質の構造的問題が確定した:

1. **人物帰属の汚染**: `parseParticipants` が空白で氏名を分割し(`Shoma Nagata` → `Shoma`+`Nagata`)、
   記号(`/`)・録音 bot(`QB`・`Recorder`)・番号・括弧注記が「人物」として deciders/owner に混入。
   さらに deciders 空の decision に**参加者全員を補完**(旧⑰D5)し、people 空の learning に
   **参加者先頭を owner に設定**(旧⑰D6)していた — プロンプトの「決定者は通常1〜3名・出席者全員は
   禁止」と実装が矛盾し、根拠のない帰属を量産した。
2. **未確定事項の確定化**: 「可能性が高い・想定・見込み・温度感・検討する」等の未確定表現が
   accepted な DecisionRecord / fact になる。曖昧な数値(「5〜60万円」= 誤記疑い)も素通し。
3. **安全情報の無ゲート確定**: AC100V 配線・空気圧(MPa)等の安全に関わる記述が、会議の1〜2行だけを
   根拠に procedure / confidence:high として登録される。
4. **open question の喪失**: 抽出された「未解決の問い」(#30 では28件)が件数カウントのみで捨てられる
   (旧⑰D7 の意図的 defer が実運用で価値損失と判明)。
5. **検証状態の不在**: `last_verified` は源泉日(ADR-0026 D3)= 内容の as-of 日であり、「人間が検証した」
   ことを表すフィールドが無い。機械生成エントリと人間検証済みエントリを区別できない。
6. **contradiction の過剰判定**: 「より具体的な知見・別条件の結果・分類の追加」を既存ナレッジへの
   矛盾(supersede)と誤判定しうる。

方針: **プロンプトだけに頼らず、決定的にテストできる機械ガード層を candidate 検証に新設する**
(プロンプトは LLM への一次指示、機械ガードは最終防衛線。ユニットテストは後者を検証する)。

## 決定

### D1. 人物解析と帰属の厳格化(旧⑰D4-D6 を廃止)

- `parseParticipants`: 区切りを **`,`・`、`・`/`** に限定し**氏名内の空白を保持**。括弧注記
  (`Pascal Pama (Paco)`)は注記を除去して本体名を採る。数字のみ・記号のみ・1文字トークンは除外。
- **録音 bot 等の非人物は設定で除外**: `extractor.yaml` に `participants_exclude: string[]`
  (コードに人名をハードコードしない)。
- **members.yaml で正規化**: KB clone の `_meta/members.yaml`(kb-core `parseMembers`)と照合し、
  `name`/`github`/別名に一致すれば **GitHub ユーザ名へ正規化**(§4.2)。一致しない名前は生のまま保持
  (外部出席者を消さない)が、専門性マップ等への流入は正規化済みのみとする(将来課題)。
- **deciders 空 → 参加者全員の補完を廃止**。決定者を特定できない decision は materialize せず
  **open question へ回す**(D3。D3 実装前の暫定は skip + PR 本文へ明記)。`会議参加者`・`全員`等の
  集合名 decider は機械拒否。
- **owner**: `candidate.people[0]`(LLM が明示した人物)のみを owner 候補とし、無ければ
  `unassigned`。**単なる出席者を owner にしない**。
- pr-miner の「PR author を deciders/owner のフォールバックにする」は**維持**(author は出席者では
  なく当該変更の当事者1名 = 根拠のある帰属)。materialize は `allowPeopleFallback`(呼び出し側
  opt-in)で区別する。

### D2. 不確実性・安全の機械ガード(candidate 検証層の新設)

- **不確実性ガード**: decision の title/decision 本文が不確定表現(可能性が高い・想定・〜でもよい・
  〜の方向・見込み・温度感・未確認・検討する・かもしれない 等。語彙は `prompts/extractor/` 隣接の
  設定ではなくコード定数 + テストで管理)にマッチしたら、**decision として materialize せず
  open question に降格**する。
- **安全ガード**: 電圧・電源・配線・AC100V・圧力・MPa 等の安全関連語彙を含む candidate は、
  sources に一次資料・実験条件の裏付けが無い限り: (a) `procedure` を `learning` に降格、
  (b) `confidence` を **low に強制**、(c) `要確認` タグ付与、(d) 確認用 open question を併発する。
  会議の発言だけを根拠に「安全基準」を確定させない。
- **confidence 規則**(プロンプト + ガード): 伝聞・外部事実は high 禁止。実測でも実験条件・測定方法の
  記載が無ければ medium 以下。
- 曖昧数値(桁が飛ぶレンジ「5〜60万円」等)は確定値として採らず確認質問へ。

### D3. open question を questions/open へ接続する(旧⑰D7 の反転)

- extractor の `openQuestions` を **QuestionLog として materialize** し抽出 PR に同梱する
  (q- 乱数採番・`asked_by` は機械起票を示す規約値・status: open・本文に元議事録の
  repo/path/ref/lines・関連 domain・質問理由)。
- gap-tracker に **open スイープ**を追加: `status: open` かつ assignee 未設定の質問へ回答依頼を送る
  (これで KP issue #92 の「open 停留が永遠に放置される」問題も解消)。担当は members / 内容から
  解決し、不能なら `gap.yaml` の **`fallback_assignees`**(複数・日替わりローテーション。
  特定個人名をコードへハードコードしない)へ送る。

### D4. 検証状態の明示(kb-core スキーマ v5)

- KnowledgeEntry に `verification_status?: "unverified" | "verified"` と `verified_by?: string` を追加
  (optional・既存エントリは無指定 = legacy)。**機械生成エントリは常に `unverified`** で作られ、
  人間の確認をもって `verified` に更新される。`last_verified` は「内容の as-of 日(源泉日)」で
  あって人間検証日ではない、と意味を確定する(ADR-0026 D3 の明確化)。
- DecisionRecord に `supersedes?: string` を追加(新決定 → 旧決定の追跡。ADR-0026 D8 の見直し)。
- スキーマ変更のため **`kb-core-v5` タグ + knowledge-base validate.yml の ref 更新**(v3→v4 と同運用)。

### D5. contradiction ≠ 詳細化(reconcile 規則)

- reconcile プロンプトに明記: 「より具体的な知見・別条件の結果・分類方法の追加」は矛盾ではなく
  **duplicate(出典追記)または new**。contradiction は「同じ条件・同じ対象について両立しない主張」に
  限定する。LLM 判断そのものはユニットテストできないため、再生成 PR の人間レビュー + 将来の
  golden 評価で監視する(機械ガードは D2 で担保)。

## 影響・トレードオフ

- **利点**: 帰属の正確性(人物汚染の根絶 = issue #104 クローズ)・未確定/安全情報の誤確定防止・
  28件/回regexだった問いの資産化・機械ガードにより回帰が決定的にテスト可能。
- **コスト**: 抽出の「収量」は下がる(未確定は decision にならない)— ただし open question として
  残るので情報は失われない。kb-core v5 の2リポ協調。gap-tracker の依頼件数が増える
  (週3件/人の既存レートリミットで抑制)。
- 既存の汚染済みエントリ(deciders に `Shoma` 等)は一括修正しない(気づいたときに手直し。
  KB #30 は close → 修正済みコードで再生成する)。

## 却下した代替案

- **PR #30 を手修正して済ます**: 58ファイルの手修正はエラーが混じりやすく、根本原因が残るため
  次の run で再発する。却下(close → 再生成)。
- **プロンプト修正のみ**: LLM の遵守は確率的でテスト不能。機械ガード無しでは回帰を検出できない。却下。
- **members に無い人物名の破棄**: 外部出席者(取引先等)の実名が消える。保持 + 非正規化扱いとする。

## design.md 転記リスト(人間)

- §6.3: 抽出フローに「candidate 機械ガード(不確実性・安全)」「open question の materialize」を追記。
- §4.2: `verification_status` / `verified_by` の追加。owner 規則(出席者フォールバック廃止)。
- §4.3: DecisionRecord `supersedes`。
- §6.5: gap-tracker の open スイープと `fallback_assignee`。

## 検証(必須回帰テスト)

1. `Shoma Nagata / kanto ide / QB Recorder / Pascal Pama (Paco)` → 空白で分割されず、bot・記号が除外される。
2. `deciders: []` でも参加者全員を決定者にしない(extractor 経路)。
3. `会議参加者` を decider として受理しない。
4. `people: []` の learning で参加者先頭を owner にしない。
5. 曖昧数値(`5〜60万円`)を含む decision が確定エントリにならない。
6. 「可能性・想定・未確認」等を含む decision が open question に降格される。
7. 安全語彙を含む candidate が high-confidence procedure にならない(low 強制 + 要確認)。
8. openQuestions が件数だけで失われず QuestionLog として PR に載る。
9. (プロンプト規則のため機械検証外)詳細化を contradiction と誤判定しない — 再生成 PR の人間レビューで確認。
10. 全 PR でゲート(test / lint / typecheck)+ KB validate 緑。
