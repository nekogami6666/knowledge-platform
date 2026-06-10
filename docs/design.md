# 社内ナレッジ管理プラットフォーム 設計ドキュメント

- **プロジェクトコード名**: `stratum`(地層の意。仮称、変更可)
- **版**: v0.1(初版ドラフト)
- **作成日**: 2026-06-10
- **ステータス**: レビュー待ち(本ドキュメント自体が最初のADRの題材となる)

---

## 0. このドキュメントについて

### 0.1 目的

本ドキュメントは、社内ナレッジ管理プラットフォーム(以下「本システム」)の実装開始前に、**方針・アーキテクチャ・採用技術・データ設計・ロードマップ**を確定させ、人間とコーディングエージェント(Claude Code 等)の間で認識の齟齬なく開発を進めるための単一の参照点(Single Source of Truth)である。

### 0.2 想定読者

1. 開発を主導する社内メンバー
2. コーディングエージェント(Claude Code 等)。本ドキュメントの要約版を各リポジトリの `CLAUDE.md` に配置し、詳細は本ドキュメントを参照させる(§12 参照)

### 0.3 本ドキュメントの管理ルール

- 本ドキュメントは `knowledge-platform` リポジトリの `docs/design.md` として Git 管理する
- 設計変更は必ず ADR(Architecture Decision Record、`docs/adr/`)を起票してから本ドキュメントへ反映する
- 「実装がドキュメントと食い違ったら、ドキュメントを直すか実装を直すか、どちらかを必ず行う」を鉄則とする

---

## 1. 背景・目的・スコープ

### 1.1 背景

- 当社は日本のラボオートメーションスタートアップであり、各メンバーが固有の専門性(ハードウェア、ソフトウェア、ウェットラボ等)と開発経験由来の暗黙知を持つ
- メンバーの入れ替わりによるノウハウ損失リスクが顕在化している
- 既存資産として、**社内会議の自動録音 → 自動文字起こし → 議事録化 → GitHub アップロード → Discord へのリンク共有・タスク通知** のパイプラインが稼働済み

### 1.2 目的(ゴール)

> **「誰かが質問したら、過去の全記録から根拠つきで答えが返ってくる状態」を、メンバーの追加負担ほぼゼロで実現し、維持する。**

サブゴール:

1. 知識の**キャプチャ面**を会議以外(Discord、GitHub、音声メモ)へ拡大する
2. 蓄積データから**意思決定の理由・学び・失敗知**をエージェントが自動抽出・構造化する
3. **需要駆動**(答えられなかった質問起点)で知識の穴を埋めるフライホイールを回す
4. 「誰が何を知っているか」を可視化し、バス係数 = 1 の領域を検出・解消する
5. ナレッジの**鮮度**を機械的に維持する

### 1.3 非目標(Non-Goals)

明示的に**やらないこと**。スコープクリープ防止のため、コーディングエージェントはこれらを実装提案しないこと。

- 汎用 Wiki / ドキュメントツール(Notion 等)の置き換え
- 事前に網羅的なオントロジー(知識分類体系)を設計すること(分類は運用後に創発させる)
- 人事評価・給与・採用候補者情報など機微情報の取り込み(§9 で除外を強制)
- 社外公開・顧客向け機能
- 議事録生成パイプライン自体の再実装(既存資産をそのまま上流として利用する)
- リアルタイム音声処理(録音 → 後処理のバッチで十分)

### 1.4 成功指標(KPI)

| 指標 | 計測方法 | 目標(運用 3 ヶ月時点) |
|---|---|---|
| Q&A Bot 利用数 | Bot のクエリログ | 週 15 件以上 |
| 回答有用率 | 回答への 👍 / (👍+👎) | 70% 以上 |
| 未回答質問の解消リードタイム | gap-tracker のログ | 中央値 3 営業日以内 |
| ナレッジエントリ蓄積数 | knowledge-base リポジトリ | 月 +30 件以上(自動抽出含む) |
| バス係数 1 領域の文書化率 | expertise-mapper レポート | 検出領域の 50% にインタビュー実施 |
| メンバーの手作業時間 | ヒアリング | 1 人あたり週 15 分以内 |

---

## 2. 設計原則(全コンポーネント共通の憲法)

実装上の判断に迷ったら、必ずこの原則に立ち返る。コーディングエージェントへの指示にも常にこの原則を含める。

| # | 原則 | 含意 |
|---|---|---|
| P1 | **生データ至上主義** | 原本(議事録・スレッド・音声書き起こし)は加工せず永続保存。要約・構造化は派生物であり、いつでも原本から再生成できる |
| P2 | **Provenance 必須** | すべてのナレッジエントリ・Bot 回答は、原本への参照リンク(リポジトリ・ファイル・行)を必ず持つ。出典のない知識は存在しない扱い |
| P3 | **人間の負担はワンタップまで** | 人間に求める操作は「絵文字リアクション」「ボタン押下」「PR のマージ」「1〜2 文の返信」「喋る」まで。フォーム入力や定型文書作成を要求する設計は却下 |
| P4 | **需要駆動の文書化** | 知識は「聞かれたとき」「リスクが検出されたとき」に文書化する。事前の網羅的文書化は行わない |
| P5 | **Git がデータベース** | ナレッジ本体は Markdown + YAML frontmatter で Git 管理。履歴・レビュー(PR)・diff・ロールバックを Git の機能で得る。RDB は運用状態(ログ・キュー)のみに使う |
| P6 | **知らないことは知らないと言う** | Bot は根拠が見つからない場合、推測で答えず「未回答」として記録する(これがフライホイールの燃料になる) |
| P7 | **段階的に複雑化する** | ベクトル DB、専用 UI、ワークフローエンジン等は「必要になった証拠」が出るまで導入しない。判断基準を §5 に明記 |
| P8 | **プロンプトはコード** | プロンプトは `prompts/` 配下で Git 管理し、変更は PR レビューとゴールデンテスト(§10)を通す |

---

## 3. 全体アーキテクチャ

### 3.1 システム構成図

```
                        ┌─────────────────────────────────────────────┐
                        │                  Discord                     │
                        │  #general #dev-hw #dev-sw #lab #voice-memo  │
                        └──────┬───────────────▲───────────▲──────────┘
                               │ 質問/💡/音声    │ 回答/通知   │ 確認依頼
                               ▼               │           │
┌──────────────────────────────────────────────┴───────────┴──────────┐
│  discord-bot(常駐プロセス / Fly.io or 社内サーバ Docker)              │
│  ┌──────────┐ ┌──────────────┐ ┌─────────────┐ ┌─────────────────┐  │
│  │ ① /ask    │ │ ③ 💡reaction │ │ ④ gap回答UI │ │ ⑥ 鮮度確認UI     │  │
│  │  Q&A      │ │  capture     │ │             │ │ (👍/👎ボタン)    │  │
│  └────┬─────┘ └──────┬───────┘ └──────┬──────┘ └──────┬──────────┘  │
│       │   SQLite(質問ログ・操作状態)    │               │             │
└───────┼──────────────┼────────────────┼───────────────┼─────────────┘
        │ agentic search│ PR作成         │ commit        │ frontmatter更新
        ▼              ▼                ▼               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        GitHub(データ層)                              │
│  ┌────────────────────┐  ┌─────────────────────────────────────────┐ │
│  │ minutes(既存)      │  │ knowledge-base(新設)                    │ │
│  │  会議議事録(原本)   │  │  knowledge/ decisions/ questions/        │ │
│  └────────▲───────────┘  │  expertise/ interviews/ _meta/           │ │
│           │ 読み取り       └───────────────▲─────────────────────────┘ │
│  ┌────────┴───────────┐                  │ PR / commit               │
│  │ 開発リポジトリ群     │                  │                           │
│  │  PR / Issue / diff  │──────────────────┤                           │
│  └────────────────────┘                  │                           │
└──────────────────────────────────────────┼───────────────────────────┘
                                           │
┌──────────────────────────────────────────┴───────────────────────────┐
│  バッチ群(GitHub Actions: cron 実行、Claude API / Agent SDK 使用)     │
│  ② extractor(毎晩)   ③ pr-miner(週次)   ⑤ expertise-mapper(週次)  │
│  ⑥ freshness-checker(日次)   ④ gap-tracker(日次)                   │
└───────────────────────────────────────────────────────────────────────┘
```

### 3.2 コンポーネント一覧と対応関係

| ID | コンポーネント | 種別 | 実行環境 | 対応する構想 |
|---|---|---|---|---|
| C1 | `discord-bot` | 常駐サービス | Fly.io(または社内 Docker) | ①④⑥ の UI、③の reaction capture |
| C2 | `extractor` | 夜間バッチ | GitHub Actions (cron) | ② ナレッジ抽出 |
| C3 | `pr-miner` | 週次バッチ | GitHub Actions (cron) | ③ PR からの設計判断マイニング |
| C4 | `voice-memo-processor` | イベント駆動 | discord-bot 内 + 既存文字起こし基盤 | ③ 音声メモ |
| C5 | `gap-tracker` | 日次バッチ | GitHub Actions (cron) | ④ フライホイール |
| C6 | `expertise-mapper` | 週次バッチ | GitHub Actions (cron) | ⑤ 専門性マップ |
| C7 | `interview-kit` | 手動トリガーバッチ | GitHub Actions (workflow_dispatch) | ⑤ ナレッジインタビュー |
| C8 | `freshness-checker` | 日次バッチ | GitHub Actions (cron) | ⑥ 鮮度管理 |
| L1 | `kb-core` | 共有ライブラリ | - | KB スキーマ・読み書き・provenance |
| L2 | `llm` | 共有ライブラリ | - | モデル設定・プロンプトローダ・共通クライアント |
| L3 | `gh-client` | 共有ライブラリ | - | GitHub App 認証・Octokit ラッパ |

### 3.3 データフローの要約

1. **入口**: 会議議事録(既存)/ Discord スレッド(💡)/ 音声メモ / PR・Issue
2. **中間**: バッチ群が原本を読み、ナレッジ候補を **PR として** knowledge-base に提案 → 人間がワンタップ承認(マージ)
3. **出口**: discord-bot が knowledge-base + minutes + 開発リポジトリを agentic search し、引用付きで回答
4. **還流**: 未回答・低評価の質問が `questions/` に積まれ、専門家への 1 問依頼 → 回答がナレッジ化される

---

## 4. データ設計

### 4.1 リポジトリ構成

リポジトリは**コード(knowledge-platform)とデータ(knowledge-base)を分離**する。理由: データ側は全社員が PR を承認・閲覧する場であり、コードのレビューと混ぜない。既存の議事録リポジトリ(以下 `minutes` と呼ぶ。実名は別途確定)は変更しない。

#### 4.1.1 `knowledge-platform`(コード、モノレポ)

```
knowledge-platform/
├── CLAUDE.md                  # コーディングエージェント向け規約(§12)
├── docs/
│   ├── design.md              # 本ドキュメント
│   └── adr/                   # ADR(0001 から連番)
├── apps/
│   ├── discord-bot/           # C1
│   ├── extractor/             # C2
│   ├── pr-miner/              # C3
│   ├── gap-tracker/           # C5
│   ├── expertise-mapper/      # C6
│   ├── interview-kit/         # C7
│   └── freshness-checker/     # C8
├── packages/
│   ├── kb-core/               # L1: スキーマ(zod)、frontmatter I/O、provenance
│   ├── llm/                   # L2: モデル設定、プロンプトローダ、リトライ/コスト記録
│   └── gh-client/             # L3: GitHub App 認証、PR 作成ヘルパ
├── prompts/                   # 全プロンプト(§8)。アプリ別サブディレクトリ
├── evals/                     # ゴールデン質問セット・抽出評価(§10)
├── .github/workflows/         # CI + 各バッチの cron 定義
├── pnpm-workspace.yaml
├── package.json
└── biome.json
```

#### 4.1.2 `knowledge-base`(データ)

```
knowledge-base/
├── README.md                  # 人間向け: この repo の読み方・承認の仕方
├── knowledge/                 # ナレッジエントリ(§4.2)
│   ├── hardware/              # ドメイン別ディレクトリ(初期は粗く 5〜7 個)
│   ├── software/
│   ├── wetlab/
│   ├── ops/
│   └── failures/              # 失敗知は横断的に集約(検索性重視)
├── decisions/                 # Decision Record(§4.3)
│   └── 2026/
├── questions/                 # 質問ログ(§4.4)
│   ├── open/
│   └── answered/
├── expertise/
│   ├── expertise.yaml         # 専門性マップ(§4.5、自動生成)
│   └── reports/               # 週次バス係数レポート(自動生成)
├── interviews/                # ナレッジインタビュー書き起こし(原本)
└── _meta/
    ├── state.json             # バッチの処理済みカーソル(処理済み commit SHA 等)
    └── id-counter.json        # エントリ ID 採番
```

### 4.2 ナレッジエントリ スキーマ
ファイル: `knowledge/<domain>/<id>-<slug>.md`。frontmatter は `kb-core` の zod スキーマを唯一の正とし、CI でバリデーションする。スキーマ確定の経緯は ADR-0003 を参照。
```markdown
---
id: kb-2026-0142            # kb-<年>-<4桁連番>。_meta/id-counter.json で採番
title: 分注ロボット X は高湿度環境で Y 軸が脱調する
type: failure                # decision | learning | procedure | fact | failure
domain: hardware             # knowledge/ 直下のディレクトリ名と一致
tags: [dispenser-x, motor, humidity]
sources:                     # P2: 必須。1 件以上。kind ごとに形状が異なる(下記)
  - kind: meeting            # meeting | voice-memo | interview は { repo, path, lines?, ref? }
    repo: org/minutes
    path: 2026/06/2026-06-03-hw-weekly.md
    lines: "L120-L141"       # 任意。行アンカー
    ref: a1b2c3d             # 任意。commit SHA。指定時は SHA 固定 permalink、省略時は default branch
  - kind: pr                 # pr | issue は { repo, number }
    repo: org/knowledge-platform
    number: 142
  - kind: discord            # discord は { url }
    url: https://discord.com/channels/...  # メッセージ permalink
people: ["yamada", "suzuki"] # 言及された当事者(GitHub ユーザ名で統一)
confidence: high             # high | medium | low(抽出エージェントが自己申告)
status: active               # active | stale | superseded
supersedes: kb-2026-0089     # 任意。矛盾検出時の世代交代に使用
created: "2026-06-10"
last_verified: "2026-06-10"
review_interval_days: 180    # type 別デフォルト: procedure=90, fact=180, learning=180, failure=365。
                             # decision は鮮度確認対象外 → キー省略(null)で表現
owner: yamada                # 鮮度確認の宛先。原則 people の筆頭
---
## 事象
(本文。エージェントが生成し、人間が PR レビューで修正できる)
## 対処 / 学び
## 背景・補足
```
**sources の kind 別形状**(ADR-0003 D1/D2):
| kind | 形状 |
|---|---|
| `meeting` / `voice-memo` / `interview` | `{ repo, path, lines?, ref? }` |
| `pr` / `issue` | `{ repo, number }` |
| `discord` | `{ url }` |

設計上の注意:
- `type: decision` の本体は `decisions/` に置き、`knowledge/` には置かない(重複防止)。`knowledge/**` 内の `type: decision` は `validateRepo` がエラー検出する(ADR-0003 D3)
- `review_interval_days` の `decision`=∞(鮮度確認対象外)は、値ではなくキー省略(null)で表現する(ADR-0003 D4)
- 人物識別子は **GitHub ユーザ名に統一**し、Discord ID とのマッピングテーブルを discord-bot の設定(`apps/discord-bot/config/members.yaml`)に持つ
- ID は不変。ファイル名変更(slug 変更)があっても ID で参照する

### 4.3 Decision Record スキーマ

ファイル: `decisions/<年>/<id>-<slug>.md`。MADR(Markdown ADR)の簡略形。

```markdown
---
id: dr-2026-0031
title: 分注ユニットのファームウェア書き込みを CAN 経由から SWD 直結に変更
date: "2026-06-03"
status: accepted             # proposed | accepted | superseded
deciders: ["yamada", "sato"]
sources:
  - kind: meeting
    repo: org/minutes
    path: 2026/06/2026-06-03-hw-weekly.md
tags: [dispenser-x, firmware]
---

## 決定内容

## 背景と課題

## 検討した代替案と却下理由      # ← 退職で失われる知識の本体。抽出時に最重視

## 影響・トレードオフ
```

### 4.4 質問ログ スキーマ(フライホイールの燃料)

ファイル: `questions/open/<id>.md` → 回答後 `questions/answered/` へ移動。

```markdown
---
id: q-2026-0088
asked_by: tanaka             # GitHub ユーザ名
asked_at: "2026-06-09T14:22:00+09:00"
channel: dev-hw
question: "分注機 X のキャリブレーション、温度補正って入ってたっけ?"
bot_answer_quality: unanswered   # unanswered | downvoted
assignee: yamada             # gap-tracker が expertise.yaml から自動選定
status: open                 # open | asked(依頼送付済) | answered | wontfix
resulting_kb: kb-2026-0150   # 回答後に生成されたエントリ ID
---
(Bot が試みた回答と、見つからなかった旨の記録)
```

### 4.5 専門性マップ スキーマ(自動生成、手編集禁止)

ファイル: `expertise/expertise.yaml`

```yaml
generated_at: "2026-06-08T03:00:00+09:00"
topics:
  - topic: dispenser-x-firmware
    label: 分注ユニット X ファームウェア
    people:
      - name: yamada
        evidence_count: 23      # 議事録発言・commit・Discord 回答の合算
        last_active: "2026-06-05"
    bus_factor: 1               # evidence 上位者が 1 人しかいない
    documented_kb_count: 2      # 紐づくナレッジエントリ数
    risk: high                  # bus_factor=1 かつ documented_kb_count < 5
```

### 4.6 運用状態データ(SQLite)

discord-bot のローカル SQLite(`/data/bot.db`、Fly.io volume に永続化)。**ナレッジは入れない**(P5)。

| テーブル | 用途 |
|---|---|
| `queries` | /ask の全クエリ・回答・評価(👍👎)・所要時間・トークン消費 |
| `pending_actions` | 送信済み確認ボタン(鮮度確認・gap 回答依頼)の状態 |
| `rate_limits` | ユーザ/チャンネル別の利用制御 |

バッチ側(GitHub Actions)は SQLite を持たず、カーソルは `knowledge-base/_meta/state.json` に commit する(Actions はステートレスなため)。

---

## 5. 技術スタック選定

### 5.1 選定一覧(確定事項)

| レイヤ | 採用技術 | バージョン方針 |
|---|---|---|
| 言語 / ランタイム | TypeScript + Node.js | Node 22 LTS、TS 5.x |
| モノレポ管理 | pnpm workspaces | turborepo 等は不採用(§5.3) |
| Discord クライアント | discord.js | v14 系 |
| LLM(単発タスク) | Anthropic Messages API(`@anthropic-ai/sdk`) | 公式 SDK 最新安定版 |
| LLM(エージェントタスク) | Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`) | V1 `query()` インターフェース(V2 は preview のため不採用) |
| 使用モデル | §5.2 のとおり 3 段使い分け | モデル ID は `packages/llm/models.ts` で一元管理。**ハードコード禁止** |
| GitHub 連携 | GitHub App + Octokit(`octokit`) | PAT は不採用(§9) |
| スキーマ検証 | zod | frontmatter / 設定 / LLM 構造化出力すべて zod を単一の正とする |
| frontmatter I/O | gray-matter | |
| ローカル DB | better-sqlite3 | discord-bot のみ |
| 検索(Phase 1〜) | agentic search(git clone + Grep/Glob/Read を Agent SDK のツールで) | ripgrep 同梱 |
| 検索(条件付き将来) | ハイブリッド検索(embedding + BM25) | 導入判断基準を §5.4 に明記。**現時点では実装しない** |
| ホスティング(常駐) | Fly.io(Docker) | 代替: 社内サーバ Docker Compose。§14 未決事項 |
| バッチ実行 | GitHub Actions scheduled workflows | |
| テスト | vitest | |
| Lint / Format | biome | ESLint+Prettier は不採用(設定簡素化) |
| プロンプト評価 | 自前ゴールデンセット + LLM-as-judge(§10) | |
| ログ / 監視 | pino(構造化ログ)+ Discord の専用 #stratum-ops チャンネルへのアラート | 専用 APM は導入しない(P7) |

### 5.2 LLM モデルの使い分け

コスト・レイテンシ・品質のバランスのため 3 段構成とする。モデル ID・用途対応は `packages/llm/models.ts` の設定オブジェクトのみで定義し、全アプリはロール名(`fast` / `standard` / `deep`)で参照する。

| ロール | モデル(2026-06 時点) | 用途 |
|---|---|---|
| `fast` | `claude-haiku-4-5-20251001` | 分類・ルーティング・💡スレッドの一次要約・鮮度確認文面生成 |
| `standard` | `claude-sonnet-4-6` | Q&A 回答生成、ナレッジ抽出、PR マイニング、矛盾検出 |
| `deep` | `claude-opus-4-8` | 月次の横断分析、インタビュー質問生成、専門性マップの トピック統合 |

- モデルは更新されるため、四半期ごとに `models.ts` を見直す(ADR 起票)
- 料金・レート制限は実装時に必ず公式( https://docs.claude.com/en/docs/about-claude/pricing )を参照し、推測で見積もらない
- Anthropic API はデフォルトで入出力をモデル学習に利用しない方針だが、実装前に最新のデータ利用ポリシーを公式ドキュメントで確認し、確認結果を ADR に記録すること

### 5.3 主要な選定理由と不採用案

**TypeScript 一本化(vs Python / 混在)**
discord.js が最成熟の Discord ライブラリであること、Agent SDK・Octokit・zod がすべて TS ファーストであること、コーディングエージェントに単一言語・単一リポジトリを与える方が齟齬が出にくいことから TS に統一。Python 混在は「バッチだけ Python」のような分裂を招くため不採用。

**Git をナレッジ DB にする(vs Notion / 専用 DB / RAG ストア直行)**
原則 P5 のとおり。PR ベースの承認フロー・行単位の provenance・全文 grep・履歴が無料で手に入る。Notion は API 経由の diff/レビューが弱く、エージェントとの相性も Git に劣る。

**agentic search で開始(vs 最初からベクトル DB)**
コーパスが議事録数百件規模のうちは、エージェントが `Grep`/`Glob`/`Read` ツールでリポジトリを探索する方式が、(a) インデックス同期という運用負債がない、(b) 「なぜこの文書を根拠としたか」の説明可能性が高い、(c) 日本語の表記ゆれにも LLM 側の言い換え検索で対応できる、の 3 点で優位。Agent SDK は Claude Code と同じファイル探索ツール群を組み込みで持つため実装コストも最小。

**GitHub Actions をバッチ基盤にする(vs 常駐 cron / ワークフローエンジン)**
すでに議事録パイプラインで GitHub 中心の運用があること、シークレット管理・実行ログ・手動再実行(workflow_dispatch)が揃っていること、コストがほぼゼロであることから採用。Airflow/Temporal 級は明確に過剰(P7)。

**discord-bot のみ常駐(vs 全部サーバレス)**
Discord Gateway(WebSocket)受信とボタンインタラクションには常駐プロセスが事実上必要。常駐は最小の 1 プロセスに限定し、重い処理はすべてバッチへ逃がす。

### 5.4 ハイブリッド検索(embedding)への移行判断基準

以下の**いずれか 2 つ**が満たされたら、ADR を起票して移行を検討する。それまで実装禁止。

1. 検索対象 Markdown が 2,000 ファイルを超えた
2. /ask の p50 応答時間が 60 秒を超えた
3. ゴールデンセット(§10)の検索再現率が 80% を下回った

移行時の構成案(参考、現時点で確定しない): embedding は Voyage AI、ストアは LanceDB または sqlite-vec、agentic search と併用するハイブリッド構成。

---

## 6. コンポーネント詳細設計

各コンポーネントは「トリガー / 入力 / 処理フロー / 出力 / 失敗時挙動 / 受け入れ条件」を定義する。受け入れ条件はそのまま実装フェーズの Definition of Done に組み込む。

### 6.1 L1 `kb-core`(最初に実装する共有ライブラリ)

すべてのアプリが knowledge-base への読み書きをこのライブラリ経由で行う。**アプリから gray-matter や fs を直接叩くことを禁止**(スキーマ逸脱防止)。

提供する API(シグネチャは実装時に確定、責務のみ規定):

- `parseEntry / serializeEntry`: zod スキーマでの厳格な parse。不正 frontmatter は型付きエラー
- `allocateId(kind)`: `_meta/id-counter.json` を介した採番(同時実行は GitHub の compare-and-swap 的リトライで解決)
- `provenance` ヘルパ: `sources` 配列 ↔ GitHub permalink / Discord permalink の相互変換
- `validateRepo()`: knowledge-base 全体のスキーマ検証(CI と pre-merge で実行)

受け入れ条件: knowledge-base リポジトリに CI が付き、不正な frontmatter を含む PR がマージできないこと。

### 6.2 C1 `discord-bot` — ① Q&A Bot(最優先実装)

**トリガー**: スラッシュコマンド `/ask <質問文>`、または Bot へのメンション。

**処理フロー**:

1. 受信即時に「調べています…」をエフェメラルでなく**スレッド返信**で投稿(検索過程と回答を後から全員が参照できるようにする)
2. ローカルの作業ディレクトリで対象リポジトリ(`minutes`, `knowledge-base`, 設定された開発リポジトリ群)を `git fetch && git reset --hard`(shallow clone を起動時に作成し、以後 fetch のみ)
3. Agent SDK `query()` を起動。許可ツールは **Read / Grep / Glob のみ**(Bash・Write・ネットワークは無効化)。システムプロンプトの要点:
   - 回答は日本語、簡潔に(Discord で読める長さ: 原則 1,500 字以内)
   - **すべての主張に出典を付ける**。出典は `kb-core` の provenance 形式 → Bot が GitHub permalink に変換して脚注表示
   - 根拠が見つからない場合は推測せず、`NOT_FOUND` を構造化出力で返す(P6)
   - 矛盾する記録を見つけたら両論併記し、新しい方を優先しつつ矛盾を明示
4. 回答メッセージに 👍 / 👎 ボタンを付与
5. SQLite `queries` に質問・回答・出典・トークン消費・所要時間を記録
6. `NOT_FOUND` または 👎 の場合、`questions/open/` への登録キューに積む(即 commit せず、gap-tracker が日次でまとめて commit。Bot から Git への書き込み経路を最小化するため)

**失敗時挙動**: Agent SDK のタイムアウト(上限 120 秒)・API エラー時は、その旨をスレッドに返し `queries` に失敗として記録。リトライは 1 回。

**受け入れ条件**:
- 既存議事録に答えが存在する質問 10 件(ゴールデンセット初版)に対し、8 件以上で正しい出典付き回答
- 答えが存在しない質問に対し、捏造せず未回答を宣言し questions キューに積まれる
- 同時に 3 質問を受けてもクラッシュしない(キューイングで直列処理可)

### 6.3 C2 `extractor` — ② 夜間ナレッジ抽出

**トリガー**: GitHub Actions cron(毎日 03:00 JST)+ workflow_dispatch(手動再実行)。

**処理フロー**:

1. `_meta/state.json` の `last_processed_sha` から `minutes` リポジトリの新規・変更ファイルを diff で列挙
2. 議事録 1 ファイルずつ、`standard` モデルで以下を**一括の構造化出力**(zod スキーマ準拠 JSON)として抽出:
   - `decisions[]`: 決定・理由・却下した代替案・決定者
   - `learnings[]`: 事実・学び・失敗知(type 候補と confidence を自己申告)
   - `open_questions[]`: 宿題・未解決事項
3. **既存ナレッジとの照合**: 抽出した各候補について、knowledge-base を agentic search し、(a) 重複 → 既存エントリの `sources` に出典追記のみ、(b) 矛盾 → 既存エントリに `superseded` 候補のマークを付けた更新案、(c) 新規 → 新エントリ、に分類
4. 結果を **1 日 1 本の PR** にまとめて knowledge-base へ提出。PR 本文に「新規 n 件 / 追記 m 件 / 矛盾検出 k 件」のサマリと各エントリへの差分リンク
5. Discord の #stratum-ops に PR リンクを投稿し、当該議事録の会議参加者をメンション。「内容に問題なければ 👍(Bot が代理マージ)、修正したければ PR 上で直接編集」
6. `state.json` を更新 commit

**プロンプト上の重要ルール**(prompts/extractor/ に格納):
- 「何を決めたか」だけの決定は confidence: low とし、「なぜ・代替案」が取れたものを優先する
- 人事・評価・給与・特定個人の health 情報に該当する箇所は抽出対象から除外する(§9.3 の除外規程を system prompt に埋め込む)
- 雑談・予定調整のみの議事録は「抽出なし」を正当な出力とする(無理に水増ししない)

**受け入れ条件**: 過去の議事録 10 件に対する抽出結果を人手レビューし、precision(抽出されたもののうち妥当な割合)80% 以上。recall は初期は問わない(P4: 穴はフライホイールが埋める)。

### 6.4 C3 `pr-miner` / C4 `voice-memo-processor` — ③ キャプチャ群

**③-a 💡 reaction capture(discord-bot 内)**
- 任意のメッセージに 💡 リアクションが付いたら、そのスレッド(またはメッセージ前後 20 件)を収集
- `fast` モデルで「ナレッジ候補として成立するか」を判定 → 成立すれば `standard` モデルでエントリ草案を生成し、knowledge-base へ単発 PR
- リアクションした本人にレビュー依頼の DM(PR リンク + 「👍 でマージ」)
- 設計上の注意: 収集対象チャンネルは allowlist 制(§9.3)。DM・プライベートチャンネルは対象外

**③-b voice-memo(discord-bot + 既存文字起こし基盤)**
- 専用チャンネル `#voice-memo` への音声添付 / ボイスメッセージを検知
- 文字起こしは**既存の議事録パイプラインと同一エンジンを流用**する(エンジン名・呼び出し方法は §14 未決事項。再利用 I/F がない場合のフォールバックとして OpenAI Whisper API を許容)
- 文字起こし全文を `interviews/voice-memos/` に原本保存(P1)した上で、extractor と同じ抽出フローに乗せる
- 投稿者に「こう記録しました」のスレッド返信(訂正は返信で受け、`fast` モデルが反映)

**③-c pr-miner(週次バッチ)**
- 直近 1 週間にマージされた PR を対象リポジトリ群から列挙
- PR 本文・レビューコメント・diff サマリから「設計判断・ハマりどころ」を抽出(extractor と同じ照合 → PR 提案フロー)
- diff そのものは知識化しない(コードは Git にある。**判断と理由だけ**を取る)

**受け入れ条件(③共通)**: 💡 → PR 生成 → 承認マージまでが、リアクションした本人の操作 2 回(💡 と 👍)以内で完結すること。

### 6.5 C5 `gap-tracker` — ④ フライホイール

**トリガー**: 日次 cron(平日 10:00 JST。依頼が深夜に飛ばないように)。

**処理フロー**:

1. discord-bot の SQLite から未処理の `NOT_FOUND` / 👎 クエリを取得し、`questions/open/` にエントリとして commit
2. 各 open 質問について、`expertise.yaml` から最適な回答者を選定(evidence_count とアクティブ度。同一人物への依頼は**週 3 件まで**のレート制限 — 専門家への負荷集中はフライホイール最大の失敗要因)
3. Discord で回答者にメンション付き依頼: 「@tanaka さんが『…』を探していました。**1〜2 文で**教えてもらえますか? このスレッドに返信するだけで OK です」
4. 返信を受けたら `standard` モデルでナレッジエントリ化(出典 = 質問 + 回答メッセージの permalink)→ PR → 回答者の 👍 でマージ
5. マージ後、元の質問者に「回答がナレッジ化されました」と通知し、質問を `answered/` へ移動
6. 7 日間無反応の依頼は 1 回だけリマインド、14 日で `wontfix` 候補として #stratum-ops に滞留レポート

**受け入れ条件**: 質問 → 依頼 → 回答 → ナレッジ化 → 質問者への通知、のループが手作業ゼロ(回答者の返信と 👍 以外)で一周すること。

### 6.6 C6 `expertise-mapper` / C7 `interview-kit` — ⑤ 専門性マップ

**⑤-a expertise-mapper(週次、日曜深夜)**

1. 入力: 議事録(発言者ラベル)、knowledge-base の `people`、対象開発リポジトリの commit author、Discord の技術チャンネル発言(allowlist 内、直近 90 日)
2. `deep` モデルでトピッククラスタリング(既存 `expertise.yaml` のトピック一覧を与え、増分更新。毎回ゼロから再生成しない — トピック名の安定性が重要)
3. `expertise.yaml` と週次レポート(`expertise/reports/`)を生成 commit
4. `risk: high`(bus_factor=1 かつ文書化僅少)のトピックを #stratum-ops に通知し、インタビュー実施を提案

**⑤-b interview-kit(手動トリガー)**

1. 対象者とトピックを指定して workflow_dispatch
2. `deep` モデルが、当該トピックの既存ナレッジ・議事録を読み、**「まだ文書化されていない穴」を突く質問リスト 10〜15 問**を生成(例: 初期化シーケンス、よくある故障モード、ベンダー固有の癖、引き継ぎで最初に教えること)
3. 質問リストを Markdown で出力 → 人間 2 名(聞き手 + 対象者)が 30〜60 分の音声面談を実施(録音は既存基盤)
4. 文字起こしを `interviews/` に原本保存 → extractor の抽出フローに乗せて複数エントリ化

**受け入れ条件**: expertise.yaml が手編集なしで毎週更新され、トピック名が週をまたいで 9 割以上安定していること。

### 6.7 C8 `freshness-checker` — ⑥ 鮮度管理

**トリガー**: 日次 cron(平日 11:00 JST)。

**処理フロー**:

1. `last_verified + review_interval_days` を過ぎた `active` エントリを列挙
2. `owner` に Discord でワンタップ確認: エントリタイトル + 要約 + 「まだ正しい? [👍 正しい] [✏️ 直す] [🗑 もう古い]」(1 人 1 日 2 件まで。確認疲れを防ぐ)
3. 👍 → `last_verified` 更新 commit / ✏️ → 編集用 PR の雛形を作って本人に DM / 🗑 → `status: stale` に変更し、矛盾検出キューへ
4. 14 日無反応 → `status: stale` に自動降格。**stale エントリは Q&A 回答時に「※最終確認から時間が経っています」の注記付きでのみ引用される**(回答から除外はしない)

**受け入れ条件**: stale 降格と Q&A 側の注記表示が end-to-end で動作すること。

---

## 7. 横断的実装方針

### 7.1 冪等性とリトライ

- すべてのバッチは**再実行安全**であること。カーソル(`_meta/state.json`)更新は処理成功後のみ。途中失敗 → 再実行で重複 PR が立たないよう、PR タイトルに処理対象範囲(commit SHA range)を含めて既存 PR を検出する
- LLM 呼び出しは `packages/llm` の共通クライアント経由とし、指数バックオフ(最大 3 回)、429/529 対応、タイムアウトを一元実装する

### 7.2 構造化出力

- LLM からの構造化データ取得は、zod スキーマ → JSON Schema 変換をツール定義(tool use)として渡す方式を標準とする。レスポンスは必ず zod で再 parse し、失敗時は 1 回だけ修正リトライ(エラー内容をフィードバック)
- 自由テキスト回答(Q&A 本文)と構造化メタデータ(出典リスト、NOT_FOUND フラグ)を分離して受け取る

### 7.3 コスト管理

- `packages/llm` が全呼び出しの input/output トークンをアプリ別・ロール別に記録(discord-bot は SQLite、バッチは Actions ログ + 週次サマリを #stratum-ops へ)
- アプリ別の**日次トークン上限**を設定ファイルで持ち、超過時は処理を中断して翌日へ繰り越し(夜間バッチの暴走防止)
- 単価は実装時に公式料金ページで確認し、月次予算上限(§14 未決)に対する消化率を週次レポートに含める

### 7.4 ログ・監視

- pino による構造化 JSON ログ。相関 ID(query id / batch run id)を全ログに付与
- 障害通知は #stratum-ops へ(バッチ失敗、Bot 再起動、スキーマ検証失敗)。専用監視 SaaS は導入しない(P7)。Fly.io 標準のヘルスチェックと再起動に委ねる

### 7.5 タイムゾーンと言語

- 表示・記録はすべて JST(+09:00)、ISO 8601。コード内部は UTC
- ナレッジ・回答の言語は日本語を既定とする(英語議事録が混ざっても出力は日本語に正規化。原文は出典で辿れるため)

---

## 8. プロンプト設計方針

### 8.1 管理方法

- 全プロンプトは `prompts/<app>/<name>.md` に置き、frontmatter にバージョン・想定モデルロール・変更履歴を持つ。`packages/llm` のローダが読み込む。**コード内へのプロンプト直書きは禁止**
- プロンプト変更の PR は、§10 のゴールデンテスト結果(変更前後の比較)を PR 本文に貼ることを必須とする

### 8.2 全プロンプト共通の規定句(system prompt に必ず含める)

1. **出典規律**: 「提供されたファイル・メッセージに根拠のない記述をしてはならない。根拠ごとに provenance を返す」
2. **不明の宣言**: 「根拠が見つからない場合は NOT_FOUND を返す。推測で補完しない」
3. **機微情報除外**: §9.3 の除外カテゴリを列挙し、該当箇所は抽出・引用・要約のすべてを禁止
4. **日本語出力・文体**: 簡潔、敬体不要、社内文書トーン

### 8.3 主要プロンプトの責務一覧(初版で作成するもの)

| ファイル | ロール | 責務 |
|---|---|---|
| `prompts/qa/answer.md` | standard | /ask の回答生成(検索エージェントの system prompt) |
| `prompts/extractor/extract.md` | standard | 議事録 → decisions/learnings/open_questions の構造化抽出 |
| `prompts/extractor/reconcile.md` | standard | 抽出候補と既存 KB の重複・矛盾判定 |
| `prompts/capture/triage.md` | fast | 💡スレッドのナレッジ候補判定 |
| `prompts/capture/draft.md` | standard | スレッド/音声メモ → エントリ草案 |
| `prompts/gap/request.md` | fast | 専門家への依頼文生成(依頼疲れしない文面) |
| `prompts/expertise/cluster.md` | deep | トピック増分クラスタリング |
| `prompts/interview/questions.md` | deep | インタビュー質問リスト生成 |

---

## 9. セキュリティ・プライバシー・権限設計

### 9.1 認証情報

| 資格情報 | 保管場所 | 備考 |
|---|---|---|
| Anthropic API キー | Fly.io secrets / GitHub Actions secrets | アプリ別にキーを分けて発行し、コスト・失効を分離 |
| Discord Bot トークン | 同上 | |
| GitHub App 秘密鍵 | 同上 | **PAT 禁止**。個人アカウント依存を排除 |

GitHub App の権限は最小権限で発行する:

- `minutes` / 開発リポジトリ群: `contents: read` のみ
- `knowledge-base`: `contents: read/write`, `pull_requests: read/write`
- Organization レベル権限は付与しない

### 9.2 Discord 権限

- Bot の閲覧チャンネルは **allowlist 制**(`apps/discord-bot/config/channels.yaml`)。デフォルト deny
- Message Content Intent を使用するため、Developer Portal での Intent 有効化と、サーバ管理者・全メンバーへの「Bot が読むチャンネル一覧」の周知を運用要件とする(録音同意の既存運用に揃える)
- DM・プライベートチャンネルは収集対象外(③-a 参照)

### 9.3 機微情報の除外規程(全抽出系プロンプトに埋め込む)

以下は**取り込み・要約・引用のすべてを禁止**: 人事評価・処遇・給与・採用候補者個人情報、健康・私生活に関する個人情報、顧客との契約金額等の営業機密のうち経営が指定するもの、認証情報そのもの(トークン・パスワードが議事録に書かれていた場合は伏字化して #stratum-ops に警告)。

加えて、特定チャンネル(例: #hr, #management)を allowlist から恒久除外する。除外リストは経営承認の上で `channels.yaml` に明記する。

### 9.4 外部送信の整理

- データが渡る外部サービスは Anthropic API・GitHub・Discord・Fly.io(+ 文字起こしエンジン)に限定する。新規追加は ADR 必須
- Anthropic API のデータ利用ポリシー(学習への不使用・保持期間)は実装着手時に公式ドキュメントで確認し、確認日付と内容を ADR-0002 として記録する

### 9.5 プロンプトインジェクション耐性

議事録・Discord メッセージは「信頼できない入力」として扱う。具体策:

- Q&A エージェントの許可ツールを Read/Grep/Glob に限定(Bash・Write・ネットワーク禁止)→ 文書内に指示が混入しても実行能力がない
- 抽出系は構造化出力のみを受け取り、出力スキーマ外の挙動(別リポジトリへの書き込み等)を構造的に不可能にする
- Bot の回答に含まれる URL は GitHub / Discord ドメインのみ許可(リンク先誘導の防止)

---

## 10. テスト・評価戦略

### 10.1 通常のソフトウェアテスト

- `kb-core` / `llm` / `gh-client` はユニットテスト必須(vitest)。LLM 呼び出しはモック
- CI(GitHub Actions): lint(biome)→ typecheck → unit test → knowledge-base スキーマ検証

### 10.2 ゴールデン質問セット(Q&A 品質の継続評価)

- `evals/golden-qa.yaml` に「質問 / 期待される出典ファイル / 期待回答の要点」を初版 10 件 → 運用しながら 50 件まで成長させる(実際の /ask ログから良問を昇格)
- 週次の Actions で全件実行し、(a) 出典一致率(期待ファイルを引用したか)、(b) 回答妥当性(`deep` モデルによる LLM-as-judge、3 段階)を計測。スコア低下 10pt 以上で #stratum-ops にアラート
- プロンプト・モデル変更 PR では必ずこのセットを変更前後で実行する(§8.1)

### 10.3 抽出品質の評価

- extractor のリリース前に過去議事録 10 件で人手評価(§6.3 受け入れ条件)
- 運用後は「extractor PR のうち人間が修正してからマージした割合」を品質の代理指標として SQLite ではなく PR ラベルで記録し、月次で確認する

---

## 11. 実装ロードマップ

各フェーズは独立して価値を出す(前フェーズが止まっても無駄にならない)。期間は専任 1 名 + コーディングエージェント前提の目安。

### Phase 0: 基盤整備(約 1 週間)

| やること | 成果物 |
|---|---|
| リポジトリ作成・モノレポ雛形・CI | `knowledge-platform`(lint/test/typecheck が回る) |
| knowledge-base 作成・スキーマ実装 | `kb-core` + スキーマ検証 CI |
| GitHub App / Discord App 発行・権限設定 | §9 の権限表どおりの資格情報 |
| `CLAUDE.md`・ADR テンプレート・本ドキュメント配置 | docs/ 一式 |
| ADR-0001(本設計の採択)、ADR-0002(API データポリシー確認) | docs/adr/ |

**DoD**: 空の knowledge-base に手書きエントリ 3 件を PR で入れ、CI 検証が通る。

### Phase 1: Q&A Bot MVP(約 1〜2 週間)← 最初に価値が出る

| やること | 対応 |
|---|---|
| discord-bot 骨格(常駐・/ask・スレッド返信・👍👎) | C1 |
| Agent SDK による minutes + knowledge-base の agentic search | C1 |
| 出典 permalink 変換・NOT_FOUND 処理・SQLite ログ | C1, L2 |
| ゴールデンセット初版 10 件と週次評価 Workflow | §10.2 |
| Fly.io(または社内 Docker)デプロイ | インフラ |

**DoD**: §6.2 の受け入れ条件 3 点 + 社内アナウンスして実利用開始。

### Phase 2: 抽出パイプライン(約 2 週間)

| やること | 対応 |
|---|---|
| extractor(差分検出 → 構造化抽出 → 照合 → 日次 PR → Discord 承認) | C2 |
| 👍 による Bot 代理マージ | C1 拡張 |
| 抽出品質の人手評価(過去 10 議事録) | §10.3 |

**DoD**: §6.3 受け入れ条件(precision 80%)+ 2 週間の運用で承認フローが回る。

### Phase 3: キャプチャ拡大とフライホイール(約 2〜3 週間)

| やること | 対応 |
|---|---|
| 💡 reaction capture | ③-a |
| voice-memo(文字起こしエンジン接続を §14 で確定後) | ③-b |
| pr-miner | ③-c |
| gap-tracker(質問 → 依頼 → ナレッジ化ループ) | C5 |

**DoD**: §6.4 / §6.5 の受け入れ条件 + フライホイールが実質問で 1 周した実績。

### Phase 4: 専門性マップと鮮度管理(約 2 週間)

| やること | 対応 |
|---|---|
| expertise-mapper(週次)とリスクレポート | C6 |
| interview-kit と初回インタビュー 1 件の実施 | C7 |
| freshness-checker と stale 注記の Q&A 連携 | C8 |

**DoD**: §6.6 / §6.7 の受け入れ条件 + バス係数レポート初版の経営共有。

### Phase 5: 継続改善(常設)

KPI(§1.4)の月次レビュー、ゴールデンセット拡充、embedding 移行判断(§5.4)、モデル更新の四半期見直し。

---

## 12. コーディングエージェントとの開発規約(CLAUDE.md に転記する内容)

`knowledge-platform/CLAUDE.md` には以下を記載する(本ドキュメントの要約 + 規約)。

### 12.1 必読・参照順序

1. `docs/design.md`(本ドキュメント)の §2 設計原則と、着手するコンポーネントの §6 該当節
2. `docs/adr/` の関連 ADR
3. 既存の `packages/` の実装パターン

### 12.2 規約

- **設計変更を伴う実装はまず ADR のドラフトを書く**(コードより先に)。ADR なしのアーキテクチャ変更 PR は却下
- conventional commits(`feat:` `fix:` `docs:` `refactor:`)、PR は 1 機能 1 本・400 行以内目安
- zod スキーマが唯一の型の正。スキーマ変更は `kb-core` から行い、利用側で型を再定義しない
- モデル ID・プロンプト・チャンネル ID・リポジトリ名のハードコード禁止(すべて設定 / `models.ts` / `prompts/` 経由)
- シークレットの直書き・ログ出力禁止
- LLM 呼び出しは `packages/llm` 経由必須(直接 `@anthropic-ai/sdk` を import するのは `packages/llm` 内のみ)
- 新規外部依存(npm パッケージ・外部サービス)の追加は PR 本文に理由を明記。外部**サービス**は ADR 必須(§9.4)
- テストのないユーティリティ関数の追加禁止(`apps/` のグルーコードは統合テストで代替可)
- 本ドキュメントと実装が食い違う場合、実装を進めず人間に確認を求める

### 12.3 タスク分割の指針

コーディングエージェントへの依頼は §11 の表の行単位(= 1 PR 単位)で行う。フェーズをまたぐ一括依頼はしない。

---

## 13. リスクと緩和策

| リスク | 兆候 | 緩和策 |
|---|---|---|
| 承認 PR が滞留し抽出が無価値化 | extractor PR の未マージ滞留 > 5 本 | 承認をワンタップ化済み。さらに confidence: high のみ 72 時間後に自動マージするモードを ADR で検討 |
| 専門家への依頼集中(gap / 鮮度確認疲れ) | 特定個人への依頼が週 3 件上限に常時到達 | 上限制御は実装済み(§6.5, §6.7)。到達が続く領域はインタビュー(まとめて取る)へ切替 |
| Bot の誤回答による誤った意思決定 | 👎 増加、ゴールデンスコア低下 | 出典必須 + NOT_FOUND 規律(P2, P6)。「Bot の回答は出典を確認の上で使う」を利用ガイドに明記 |
| 機微情報の混入 | - | §9.3 の多層防御(チャンネル allowlist + プロンプト除外 + PR 人間承認) |
| LLM コスト超過 | 週次レポートで予算消化率 > 80% | 日次トークン上限(§7.3)、モデルロールの格下げ(standard→fast) |
| キーパーソン依存が本システム自体に発生 | - | 本ドキュメント・ADR・CLAUDE.md の整備自体が緩和策。運用手順も knowledge-base に食わせる(ドッグフーディング) |
| Discord / GitHub の仕様変更 | API 廃止予告 | 公式 SDK(discord.js / Octokit)追従。直接 REST を叩かない |

---

## 14. 未決事項(実装着手前に決定が必要)

| # | 事項 | 決定者 | 期限 |
|---|---|---|---|
| 1 | 既存文字起こしエンジンの再利用 I/F(③-b で流用可能か、API/CLI の呼び出し方法) | 既存パイプライン担当 | Phase 3 着手前 |
| 2 | 常駐ホスティング先(Fly.io か社内サーバか)。社内サーバがある場合はそちらを優先検討 | インフラ担当 | Phase 1 着手前 |
| 3 | 月次 API 予算上限(円) | 経営 | Phase 1 着手前 |
| 4 | Bot が閲覧する Discord チャンネル allowlist と恒久除外リスト | 経営 + 全メンバー周知 | Phase 1 着手前 |
| 5 | pr-miner の対象開発リポジトリ一覧 | 開発リーダー | Phase 3 着手前 |
| 6 | knowledge/ 直下の初期ドメイン分類(5〜7 個) | 全メンバー 30 分のワークショップで決定 | Phase 0 中 |
| 7 | プロジェクト正式名称(`stratum` 継続可否) | 任意 | Phase 0 中 |
| 8 | メンバーの GitHub ↔ Discord ID マッピング表 | 各自申告 | Phase 1 着手前 |

---

## 付録 A: 用語集

| 用語 | 意味 |
|---|---|
| KB | knowledge-base リポジトリ、またはナレッジエントリ群 |
| provenance | ナレッジの出典(原本への参照)。P2 により必須 |
| agentic search | LLM エージェントが Grep/Glob/Read ツールでリポジトリを反復探索する検索方式 |
| バス係数 | その人がいなくなると立ち行かなくなる人数。1 が最危険 |
| ゴールデンセット | 品質回帰検知用の固定質問・期待値ペア |
| ADR | Architecture Decision Record。設計判断とその理由の記録 |
| stale | 鮮度確認が取れていない状態。回答から除外はされないが注記が付く |

## 付録 B: 参考リンク(実装時に必ず最新を確認)

- Anthropic API ドキュメント: https://docs.claude.com/en/api/overview
- Claude Agent SDK(TypeScript): https://platform.claude.com/docs/en/agent-sdk/overview / https://github.com/anthropics/claude-agent-sdk-typescript
- 料金: https://docs.claude.com/en/docs/about-claude/pricing
- discord.js ガイド: https://discordjs.guide/
- GitHub App / Octokit: https://docs.github.com/en/apps
