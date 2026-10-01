# ADR-0037: agentic search の読み取り封じ込め — realpath(cwd) 外を deny する PreToolUse ガード + SDK 設定 + clone 側 symlink 無害化

- ステータス: proposed
- 日付: 2026-09-30
- 関連: ADR-0006(Q&A エージェントの FS 封じ込め・本 ADR が D2/D4 を補完)・ADR-0013(clone の
  トークン非永続化)・ADR-0035 D4(/ask の観測ログ)・design.md §9.5 / §6.2
- 備考: design.md §9.5 は保護パスのため、本 ADR の要旨の転記は人間レビューで行う。

## 背景

### 本番での実証(2026-09-30)

`/ask` の agentic search(`runAgentSearch`・Agent SDK 0.3.285 の `query()`)は次の Options で動いている:
`permissionMode:"dontAsk"`・`settingSources:[]`・`allowedTools:["Read","Grep","Glob"]`(ツール名のみ)・
`disallowedTools:[Bash,Write,Edit,…]`・`cwd:/clones`。本番コンテナでテストプロンプトを与えたところ、
エージェントは **cwd 外の `/config/ops.yaml` を Read で読み取れた**。

ADR-0006 が予見したとおり `cwd` は SDK 上の境界ではなく、素の `allowedTools:["Read"]` は Read を
**パス無制限で事前承認**する。同じプロセスツリー・同じ uid から見える範囲には次がある:

- `/data/bot.db` — 全利用者の質問と回答
- `/config/*` — 運用設定
- `/recordings` — 録音
- `/proc/<bot pid>/environ` — bot 本体の env(`DISCORD_TOKEN`・repo+workflow 書き込み権限つきの
  `GIT_CLONE_TOKEN`)。ADR-0006 実装状況の `buildAgentEnv` は agent subprocess 自身の env を絞るが、
  **親プロセスの environ は同 uid から読める**(compose は `user:"0"`)

`/ask` を実行できる Discord 利用者なら誰でも、質問文や検索対象文書内のプロンプトインジェクションで
これらを回答本文に載せられる。

### 検索対象の拡大と symlink ベクタ

検索対象は約 46 リポの clone(`/clones` 配下)へ拡大予定。リポにコミットされた **symlink**
(`x -> /data/bot.db`)は cwd 内のパスに見えるため、パス文字列だけの検査では抜けられる。
判定は **realpath(symlink 解決後の実体パス)** で行う必要がある。

### SDK 0.3.285 の実挙動(実験)

`packages/llm` の Options を再現した実験スクリプト(Claude on AWS・Haiku 4.5)で、cwd 外の
fixture に対する 6 ベクタと cwd 内の正規読み取りを層ごとに比較した。「漏」= tool_result に外部の
マーカー文字列が載った、「拒」= deny、「○」= 正規に読めた。

| 構成 | 絶対パス外 | symlink(ファイル) | symlink(ディレクトリ) | `../` | Grep `path` 外 | Glob 絶対 pattern 外 | cwd 内 Read/Grep/Glob |
|---|---|---|---|---|---|---|---|
| 現行(ツール名のみの allowedTools) | 漏 | 漏 | 漏 | 漏 | 漏 | 漏(列挙) | ○ |
| `settings.permissions.blockReadsOutsideWorkingDirectories:true` | 拒 | 拒 | 拒 | 拒 | 拒 | 拒 | ○ |
| 同上を `managedSettings` で | 拒 | 拒 | 拒 | 拒 | 拒 | 拒 | ○ |
| PreToolUse hook(realpath ガード) | 拒 | 拒 | 拒 | 拒 | 拒 | 拒 | ○ |
| パス限定の allowedTools(`Read(./**)` 等) | 拒 | 拒 | 拒 | 拒 | 拒 | 拒 | ○ |
| `allowedTools:[]`(現行の「ツール無し単発」) | 拒 | 拒 | 拒 | 拒 | 拒 | 拒 | **○(読めてしまう)** |
| `tools:[]` | ツール自体が無い(`StructuredOutput` のみ)。構造化出力は成立 | | | | | | |

副次的な発見:

- **`allowedTools:[]` はツール無しではない**。dontAsk でも cwd 内の Read/Grep/Glob は既定で許可される
  ため、capture / voice(cwd = `/clones`)等の「ツール無し単発」は実際には clones を読めた。
  また基本ツール集合には Cron*/Workflow/SendMessage/Skill/ToolSearch 等が載っていた
  (dontAsk で実行は拒否されるが、モデルの文脈には見えている)。
- `Grep`(path 省略)と `Glob "**/*"` の走査は symlink を辿らない(rg 既定)。symlink を明示パスで
  指定した場合だけが問題になる。
- `../` 付きの相対パスは SDK が hook 呼び出し前に絶対パスへ正規化していた。
- hook による deny は `result.permission_denials` に計上される(観測に使える)。
- `canUseTool` は許可ルールで事前承認済みのツールには呼ばれない(Read が allowedTools にある限り
  パス検査の場にならない)。PreToolUse hook は許可ルールに関係なく**全ツール呼び出しの前**に走り、
  hook の deny は最終決定になる。

## 決定

読み取りを **realpath(cwd) 配下**に閉じ込める層を `packages/llm` の `runAgentSearch`(単一箇所)に重ねる。
全呼び出し元(/ask・capture・voice・extractor・pr-miner・expertise-mapper・gap-tracker・interview-kit・
evals)に一律で効く。

### D1. 自前の PreToolUse ガード(deny のみ・主層)

`packages/llm/src/path-guard.ts` に純粋関数 `checkToolPathContainment(toolName, input, root)` を置き、
`createContainmentHook(cwd)` が PreToolUse hook として呼ぶ。`root = realpath(cwd)` は hook 生成時に
1 回解決する(cwd 自体が symlink でも実体で比較)。

- 対象はファイル系ツール(Read/Grep/Glob と、将来・設定ミスに備えて LS/Notebook*/Edit/Write/LSP)の
  `file_path` / `path` / `notebook_path`、Glob の `pattern`。**それ以外のツール(StructuredOutput 等)は
  素通し**
- パスは相対なら root 基準で解決し、**実在する最長の祖先を realpath して残りを連結**(未存在パスも判定可能。
  cwd 内の未存在は許可=読んでも ENOENT で無害、外向き symlink ディレクトリ配下の未存在は拒否)
- `~` 始まり・NUL・`..` セグメントを含むパスは解決せず拒否(`link/../x` のような lexical 正規化と
  OS の symlink 解決の食い違いを構造的に塞ぐ。SDK が事前に正規化するため正規の検索は影響しない)
- Glob の pattern はメタ文字より前の静的接頭辞を同じ判定にかけ、`{/etc,/config}/*` のような
  ブレース内の絶対パスも拒否する
- realpath の想定外失敗(EACCES・ELOOP 等)・判定中の例外は **deny(fail-closed)**
- hook は **deny か `{}`(判定を permission 系へ委ねる)しか返さない**。`allow` も `updatedInput` も返さない

**ADR-0006 D2 の「hooks / canUseTool は能力を再導入しうるので未設定」の改訂**: 懸念の本体は
「allow を返す・入力を書き換える」コールバックが許可ルールを迂回することである。deny のみを返す hook は
能力を削ることしかできないため、この禁止の対象外とする。canUseTool は上記のとおり事前承認済みの Read で
呼ばれずパス検査の場にならないため、引き続き未設定とする。`additionalDirectories`・`mcpServers`・
`agents`・`toolAliases` は到達範囲・能力を広げうるため引き続き未設定。
(2026-10-01 追記: `mcpServers` は ADR-0038 D6 の例外 — 呼び出し元が渡したプロセス内ツールのみ — を除き未設定。)

### D2. SDK 側の強制 `blockReadsOutsideWorkingDirectories`(独立の第 2 層)

`settings: { permissions: { blockReadsOutsideWorkingDirectories: true } }` を渡す。SDK 自身が symlink を
解決したうえで作業ディレクトリ外の Read/Grep/Glob を拒否する(実験で 6 ベクタとも拒否)。自前ガードに
バグがあっても SDK 側で止まり、SDK の挙動が変わっても自前ガードで止まる。

`managedSettings` ではなく `settings`(flag 設定層)を使う。`managedSettings` は IT 管理設定の層が
ホストに存在すると**既定で捨てられる**(sdk.d.ts)ため、組織の管理設定が配られる環境(#153 の
最低バージョン要件)では黙って無効化されうる。flag 層は `settingSources:[]` でも適用され、この設定は
「どの設定元でも true が勝つ」。

ADR-0006 D4 が懸念した「deny ルール構文の誤りによる偽の安心」は、構文を持たない真偽値設定を選び、
実験で効果を確認したことで解消する。パス限定の allowedTools(`Read(./**)`)も実験では有効だったが、
呼び出し元 API(ツール名の配列)を変えずに済む本設定を採る(将来の追加層候補として残す)。

### D3. `tools` = `allowedTools`(基本ツール集合を絞る)

`tools: [...allowedTools]` を渡し、モデルの文脈に載るツール自体を許可ツールに限定する。
`allowedTools:[]` の呼び出し元は `tools:[]` となり、`StructuredOutput` だけが残る
(= 名実ともにツール無し単発。実験で構造化出力が成立することを確認)。

### D4. bot の clone は `core.symlinks=false`(clone 側の多層防御)

`apps/discord-bot/src/repos.ts` の同期で、新規 clone は `git clone -c core.symlinks=false`、既存 clone は
reset を常に `-c core.symlinks=false` で行い、未移行の clone は移行時 1 回だけ `read-tree --empty` で
index を空にしてから reset し(展開済み symlink は stat 一致のため通常の reset では書き直されない)、
成功後に `core.symlinks=false` を永続化する。git は symlink を「リンク先パスを本文に持つ通常ファイル」と
して展開するため、コミットされた外向き symlink は読み取り面で外部へ解決されない。作業ツリーは clean の
まま(permalink の commit と一致)で、検索・引用への影響は無い(symlink の本文がパス文字列になるだけ)。

コストは sync ごとの `git config --get` 1 回と移行時の全ファイル再展開 1 回のみ。バッチ(GitHub Actions)
側の checkout はランナー上の一時環境で bot の秘密と同居しないため変更しない(D1/D2 は一律に効く)。

### D5. 観測

`AgentSearchResult.deniedToolCalls`(`result.permission_denials` の件数)を追加し、`/ask: 検索完了` ログに
載せる。0 超は cwd 外読み取りの試行(注入の兆候)やツール誤用のシグナルとして追跡する。deny 理由の文面は
モデルへ返るが、判定対象のパスのみを含み root の実体パスや内容は含めない。

## 実験による確認(実装後)

実装後の `runAgentSearch`(dist)を実モデル(standard = Sonnet 4.6)で呼び、cwd = 一時ディレクトリに
正規ファイル・外向き symlink(ファイル/ディレクトリ)を置いて 8 ステップを指示した結果、
cwd 外の絶対パス・外向き symlink ×2・`../`・Grep `path` 外・Glob 絶対 pattern 外の 6 件が全て hook で
拒否され、Grep(path 省略)と cwd 内 Read のみ成功、構造化出力に外部マーカーは含まれなかった
(`deniedToolCalls=6`)。`allowedTools:[]` の構成では `tools=[]` となりツール呼び出し自体が発生しなかった。

## 残るリスク(将来課題)

- **同一 uid・同一コンテナのまま**: 本 ADR の層はすべて agent 内のポリシーであり、SDK のバグや、
  入力に現れないパスを読む将来の機能・ツールには効かない。本丸は ADR-0006 D1 の OS 層隔離で、
  **agent subprocess を別 uid(clones のみ read-only で見える FS ビュー)で動かす**ことを将来課題とする
  (別 uid なら `/proc/<bot pid>/environ` も読めない)。landlock / bubblewrap / 別コンテナの検索ワーカー
  も候補。compose の `user:"0"`(rootless 前提)もこの文脈で見直す。
- **cwd 配下は全て読める**: `/clones` 配下の全リポ(46 リポ・`.git/` を含む)は /ask 利用者全員に
  読める。リポ単位のアクセス制御は無い(ADR-0013 でトークンは `.git/config` から除去済み)。
  機密度の異なるリポを同じ clones に置かない運用が前提。
- **`GIT_CLONE_TOKEN` の権限過大**: repo+workflow 書き込み権限は clone 用途に過大。読み取り専用の
  fine-grained token へ縮小するのが、漏洩時の被害を下げる独立の対策として有効(運用タスク)。
- **TOCTOU**: 判定(hook)と SDK の読み取りの間に symlink が差し替わる余地は理論上ある。agent は
  書き込みツールを持たず、bot の git 同期は検索前に直列で完了するため実害は低い(D4 で symlink 自体も
  生成されない)。
- **cwd の誤設定**: cwd が `/` 等の広いディレクトリだとガードは実質無効になる。現行の呼び出し元の cwd は
  clone ルート・KB ルート・eval fixture・(ツール無しの)tmpdir のみ。
- **clone 以外の検索ルート**: url 無しで手置きされた clone(synthetic)には D4 が効かない
  (D1/D2 は効く)。

## 却下した代替案

- **canUseTool でパス検査** → 事前承認済みの Read では呼ばれない(allowedTools から Read を外すと
  全 Read が canUseTool 経由になり、allow を返すコールバックが必要=能力を再導入しうる)。
- **パス限定 allowedTools(`Read(./**)`)のみ** → 実験では有効だが、SDK のルール構文解釈に単独で依存する。
  D1(自前)+ D2(SDK)の独立 2 層の方が片方の不具合に強い。
- **Read を外す** → ADR-0006 と同じ理由で agentic search が成立しない。
- **clone 後に symlink を検出して削除** → 作業ツリーが dirty になり permalink の commit と食い違う。
  `core.symlinks=false` は git の正規の展開方式で tree とも整合する。
