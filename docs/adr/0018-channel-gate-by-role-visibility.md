# ADR-0018: チャンネル読み取りゲートを config 列挙から Discord のロール可視性(ViewChannel)に変える

- **ステータス**: proposed
- **日付**: 2026-07-15
- **関連**: design.md §9.2(Discord 権限・L622)・§9.3(恒久除外・L630)・§6.4 L479(③-a)・
  §6.6 L513(⑤-a)・§10 L767(リスク表)・§14#4(本 ADR で解消)/
  ADR-0006(FS 封じ込めとは別軸の入力面ゲート)・ADR-0017 D7(将来の Discord コレクタが同じ意味論を使う)
- **備考**: 採択(`accepted`)および design.md への転記(上記 6 箇所)は人間レビューで行う。

## 背景

§9.2 は Bot の閲覧チャンネルを「`channels.yaml` の allowlist 制(default-deny)」と定めていた。
運用してみると、**チャンネルが増えるたびに config 追加 + bot 再起動が必要**になる。禁止リスト
(denylist)方式への反転は「機密チャンネルを作った際に自動で読めてしまう・リスト漏れ」が怖い。

チーム協議(2026-07-14 Discord・Hayate/Shoma 合意)で
**「Bot 専用ロールを作って、そのロールが見えるチャンネルだけ読む」**方式が採択された。
Discord の権限モデル自体を allowlist にする: 公開チャンネルは読める(都度追加不要)、
機密チャンネルは private にして bot(のロール)を入れない限り**Discord のレイヤで**見えない
(リスト漏れが構造的に起きない)。

## 決定

### D1. 判定主体は「bot 自身の実効 ViewChannel」

- 運用は「専用ロールを bot に付け、そのロールでチャンネル可視性を管理する」。bot の可視性は
  bot に付いたロールで決まるため、**コードの判定は bot 自身の実効権限**で行う:
  - **/ask(interaction)**: `interaction.appPermissions.has(ViewChannel)` — Discord が payload に
    同梱する bot アプリの実効権限(non-null・キャッシュ非依存)。
  - **MessageCreate / ReactionAdd(💡 capture・voice)**: `channel.permissionsFor(guild.members.me,
    checkAdmin: false)`。**`checkAdmin: false` 必須**(Administrator が付くと全チャンネル可視と
    判定されてしまうため。運用要件は D5)。
- **config に role_id を持つ案は不採用**: bot が見えないチャンネルの Gateway イベントはそもそも
  届かないため、マーカーロール判定が意味を持つのは「bot は見えるがマーカーロールは不可視」という
  差分だけであり、それは bot のロールを最小権限に保てば消える。設定項目とキャッシュ整合を増やす
  価値がない。

### D2. 意味論の反転と、維持する default-deny

- 「config に列挙したチャンネルだけ読む」→「**Discord 上で bot が見えるチャンネルは読む**」に反転する。
  公開チャンネル(@everyone 可視)= 対象。機密 = private チャンネル(Discord 自体が default-deny)。
- **判定不能は拒否**(安全側の既定は維持): DM / `guild.members.me` 未取得 / channel 未キャッシュ /
  スレッドの親未キャッシュ(`ThreadChannel.permissionsFor` は親委譲)→ すべて読まない。
- **注意(意味論の変化)**: bot が他機能のために入っている private チャンネル(例 #stratum-ops)も
  自動的に /ask・💡 の対象になる。読ませたくないチャンネルは D3 の permanent_exclude へ。

### D3. permanent_exclude は維持し、スレッドは親 ID でも照合する

- 「公開だが読ませないチャンネル」(§9.3 の経営指定)を `channels.yaml` の `permanent_exclude` で
  明示除外する(可視性より優先)。channels.yaml は `{ permanent_exclude: [] }` に縮小。
- **スレッド対策**: スレッド内メッセージの channelId はスレッド ID であり親 ID ではない。除外は
  **channelId と parentId の両方**で照合する(旧 allowlist は「スレッドは allow に無い → 拒否」と
  安全側だったが、新方式は「親が見える → 許可」に倒れるため、この照合が無いと除外がすり抜ける)。
- 旧 `allow` キーは **1 リリースの互換として「起動時に警告して無視」**(git pull 先行でも bot が
  落ちない)。次の整理で schema から削除。

### D4. /ask は inGuild + 明示チェック

interaction は bot が見えないチャンネル・DM からも届き得る(Gateway 配送とは経路が違う)ため、
/ask は `interaction.inGuild()` と appPermissions の ViewChannel を明示チェックする
(旧 allowlist が暗黙に担っていた DM 拒否の明文化)。

### D5. bot ロールの運用要件と監査

- **bot(のロール)に Administrator を付けない**。権限は最小(View/Send/Reactions/Read History 等)。
- 「bot を private チャンネルに招く = そのチャンネルを stratum に読ませる」に意味が変わることを
  メンバーに周知する(§9.2 の周知要件の新しい形)。
- bot 起動時に**可視チャンネル一覧を監査ログに 1 回出力**する(「何を読んでいるか」を随時確認できる)。

### D6. 将来の Discord コレクタ(expertise-mapper・ADR-0017 D7)も同じ意味論

REST 経路(Gateway を持たない Actions バッチ)では、`guilds/:id/roles` + `channels` の
`permission_overwrites` から標準アルゴリズム(@everyone base + ロール合算 → overwrites 適用)で
bot の ViewChannel を計算し、`ViewChannel ∧ ¬permanent_exclude` のチャンネルのみ収集する。
permanent_exclude は同じ channels.yaml を共有する。

## 影響・トレードオフ

- **利点**: チャンネル追加の運用ゼロ(config 変更・再起動不要)。機密の守りが「リストの正しさ」でなく
  **Discord の権限モデル**に載る(private = 構造的に不可視)。§14#4 の「allowlist 承認・周知」は
  「bot ロールの可視範囲の管理」に置き換わる。
- **意味論の拡大**: 公開チャンネル全部 + bot が居る private が対象になる。意図しない収集は
  permanent_exclude と D5 の周知・監査ログで抑える。
- **Discord 設定への依存**: 誰かが bot ロールを機密チャンネルに追加すると読めるようになる
  (旧方式は config 変更 = Git レビューが挟まった)。チャンネル権限の変更権限を持つ人 = 承認者、
  という信頼境界に変わる(サーバ管理者は従来から全権を持つため実質の後退は小さい)。
- 旧 channels.yaml の allow 行はデッドコンフィグになる(警告で気づかせて削除を促す)。

## 却下した代替案

- **禁止リスト(denylist)方式** → 機密チャンネル新設時にリスト追加を忘れると自動で読まれる。
  「漏れ = 事故」の構造が怖い(チーム協議で却下)。
- **config に専用ロール ID を持ち、そのロールの可視性で判定** → D1 のとおり、bot 不可視チャンネルの
  イベントは届かないため意味のある差分がなく、設定と実装が増えるだけ。却下。
- **allowlist 継続 + 自動同期スクリプト** → 同期先(config)と正(Discord)の二重管理は残る。却下。

## 検証

- ユニット: ゲート純関数(可視/不可視/判定不能 × permanent_exclude × parentId)+ visibility 変換
  (fake channel/member/interaction。DM・null・スレッド親未キャッシュ)。
- 実機(VM・R2 マージ後): (a) 公開チャンネルで /ask・💡 が通る (b) private(bot 無し)で発火しない
  (c) permanent_exclude チャンネルで拒否 (d) bot をチャンネルに追加 → **再起動なしで**読めるようになる
  (e) 起動ログに可視チャンネル一覧。
