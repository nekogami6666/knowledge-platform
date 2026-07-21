# stratum ナレッジ基盤 — 図で見る「今どこまで出来ているか」

> **このドキュメントは誰向け?**
> エンジニアでなくても、このシステムが「何をするものか」「今どこまで出来ていて、あと何が残っているか」を
> 図でざっと把握できるようにまとめたものです。専門用語には最初に説明を付けています。
>
> - **最終更新**: 2026-07-21(スナップショット。実装は日々進むので、正確な最新は Git 履歴を参照)
> - **正式な設計書**: [docs/design.md](./design.md)(唯一の設計の正。細部はこちら)
> - **一言でいうと**: 🟩 **コードはほぼ全部完成。残りは主に「鍵や設定を入れてスイッチを入れる」人間作業と、いくつかの経営判断です。**

---

## 1. このシステムは何をするのか

会社には、会議・チャット・PR(開発の記録)などに **「その人しか知らない知識(暗黙知)」** が大量に眠っています。
人が辞めると、その知識ごと消えてしまう——これが解決したい問題です。

このシステム(コード名 **`stratum`** = 地層)は、次の状態を **メンバーの手間ほぼゼロ** で実現・維持します。

> **「誰かが質問したら、過去の全記録から “根拠つき” で答えが返ってくる」**

大事な考え方は 3 つだけです。

| 考え方 | 意味(かみ砕くと) |
|---|---|
| 🔗 **出典が必ず付く** | Bot の答えもナレッジ記事も、必ず「どの会議のどの発言が根拠か」のリンクを持つ。根拠のない知識は「無い」扱い |
| 👆 **人間の操作はワンタップまで** | 人に求めるのは「絵文字を押す」「ボタンを押す」「PR を承認する」「1〜2 文で返信する」「喋る」だけ。フォーム記入は求めない |
| ♻️ **答えられない質問が燃料になる** | Bot が答えられなかった質問を記録し、専門家に「1 問だけ」聞いてナレッジ化する。これを繰り返して賢くなる(フライホイール) |

---

## 2. 全体の流れ(いちばん大事な 1 枚)

知識が「生まれて → 整理されて → 使われて → 足りない所が埋まる」という循環で回ります。

```mermaid
flowchart LR
    subgraph IN["① 知識が生まれる場所"]
      direction TB
      M["会議の議事録"]
      D["Discord の会話"]
      V["音声メモ / VC録音"]
      P["GitHub の PR<br/>(開発の記録)"]
    end
    subgraph AI["② AI が読み取り整理"]
      EX["自動バッチが<br/>要点だけ抽出"]
    end
    subgraph KB["③ ナレッジ台帳"]
      K["出典つきの<br/>ナレッジ記事"]
    end
    subgraph OUT["④ 使う"]
      ASK["/ask で質問<br/>→ 根拠つき回答"]
    end
    subgraph FLY["⑤ 穴を埋める"]
      G["答えられない質問<br/>→ 専門家に1問依頼"]
    end

    IN ==> AI ==> KB ==> OUT
    OUT -. 答えられない .-> FLY
    FLY -. 回答をナレッジ化 .-> KB

    classDef box fill:#f7fafc,stroke:#4a5568,color:#1a202c
    class M,D,V,P,EX,K,ASK,G box
```

**読み方**: 左から右へ知識が流れます。右下の「答えられない質問」が左の台帳に戻ってくる **点線のループ** が、
このシステムの心臓部です。使えば使うほど台帳が育ちます。

---

## 3. システムの構成(誰が誰と話すか)

登場するのは大きく **4 つの場所** です。

```mermaid
flowchart TB
    U["👤 メンバー"]

    subgraph DISCORD["💬 Discord(チャットアプリ)"]
      CH["各チャンネル<br/>+ 運用連絡用 #stratum-ops"]
    end

    subgraph VM["🖥️ 社内サーバ(24時間 常駐)"]
      BOT["discord-bot<br/>質問応答・キャプチャ・確認UI"]
      REC["録音 sidecar<br/>(VC録音)"]
      GAP["gap-tracker<br/>(毎日 定時)"]
      FRE["freshness-checker<br/>(毎日 定時)"]
    end

    subgraph GHA["⚙️ GitHub Actions(自動実行の定時バッチ)"]
      EXT["extractor<br/>毎晩"]
      PRM["pr-miner<br/>毎週"]
      EXP["expertise-mapper<br/>毎週"]
      INT["interview-kit<br/>手動起動"]
    end

    subgraph GH["🗄️ GitHub(データ保管庫 = Git)"]
      MIN["議事録リポ<br/>(既存・読むだけ)"]
      DEV["開発リポジトリ群<br/>(読むだけ)"]
      KBR["knowledge-base<br/>ナレッジ台帳(読み書き)"]
    end

    U <--> CH
    CH <--> BOT
    BOT --> REC
    BOT <--> KBR
    GAP <--> KBR
    FRE <--> KBR
    EXT --> KBR
    PRM --> KBR
    EXP --> KBR
    INT --> KBR
    EXT -.読む.-> MIN
    PRM -.読む.-> DEV

    classDef vm fill:#c6f6d5,stroke:#2f855a,color:#1a202c
    classDef gha fill:#bee3f8,stroke:#2b6cb0,color:#1a202c
    classDef gh fill:#fefcbf,stroke:#b7791f,color:#1a202c
    class BOT,REC,GAP,FRE vm
    class EXT,PRM,EXP,INT gha
    class MIN,DEV,KBR gh
```

- 🟩 **社内サーバ(常駐)**: 常に起動していないと動けないもの(チャットの受信・ボタン操作)だけを置く最小構成。
- 🟦 **GitHub Actions(定時バッチ)**: 「毎晩」「毎週」自動で走る重い処理。普段は動いていないので低コスト。
- 🟨 **GitHub(データ保管庫)**: 知識の本体は **すべてテキストファイルとして Git で保管**。Word や DB ではなく、
  「バージョン管理された文書フォルダ」だと思ってください。誰が・いつ・何を変えたかが全部残り、承認は PR(変更提案)で行います。

---

## 4. データはどこにある?(Git = データベース)

知識は 2 つのリポジトリ(=フォルダ)に分けて保管します。**コード(部品)とデータ(知識)を混ぜない** ためです。

```mermaid
flowchart LR
    subgraph CODE["📦 knowledge-platform(このリポジトリ = プログラム)"]
      A["apps/ … 各アプリ"]
      PK["packages/ … 共通部品"]
      PR["prompts/ … AIへの指示文"]
      DC["docs/ … 設計書・ADR"]
    end
    subgraph DATA["📚 knowledge-base(別リポジトリ = 知識の本体)"]
      KN["knowledge/ … ナレッジ記事"]
      DE["decisions/ … 決定の記録"]
      QU["questions/ … 質問ログ(未回答/回答済)"]
      EXd["expertise/ … 専門性マップ"]
      IN["interviews/ … 面談・音声メモの原本"]
      MT["_meta/ … 名簿・採番などの管理情報"]
    end
    CODE -. PR で読み書き .-> DATA
```

ナレッジ記事は 1 件が 1 つのテキストファイルで、先頭に「見出し情報」が付きます(下は例)。
この見出しの形式は厳密にチェックされ、**形式が壊れた記事は台帳に入れられない** 仕組みです(自動検査 = CI)。

```markdown
---
id: kb-2026-0142                      # 記事の背番号(不変)
title: 分注ロボット X は高湿度で Y 軸が脱調する
type: failure                          # 決定 / 学び / 手順 / 事実 / 失敗知
domain: hardware                       # 分野
sources:                               # ← 必ず「出典」が付く(根拠のない知識は無し)
  - kind: meeting
    repo: org/minutes
    path: 2026/06/2026-06-03-hw-weekly.md
people: [yamada, suzuki]               # 関係者
confidence: high                       # AI の自己申告する確からしさ
status: active                         # active(有効) / stale(要確認) / superseded(世代交代)
last_verified: "2026-06-10"            # 最後に「まだ正しい」と確認した日
owner: yamada                          # 鮮度確認の宛先
---
## 事象
（本文。AI が下書きし、人間が PR で直せる）
```

---

## 5. 部品(コンポーネント)一覧

システムは 8 つのアプリ(C1〜C8)と 3 つの共通部品(L1〜L3)でできています。

| ID | 名前 | ひとことで言うと | 実行場所 |
|---|---|---|---|
| **C1** | discord-bot | 質問に答える・💡で拾う・確認ボタンを出す **窓口** | 社内サーバ(常駐) |
| **C2** | extractor | 毎晩、議事録から要点を **自動で記事化** | GitHub Actions(毎晩) |
| **C3** | pr-miner | 毎週、PR から **設計判断・ハマりどころ** を抽出 | GitHub Actions(毎週) |
| **C4** | voice-memo | 音声メモ・VC録音を文字起こしして記事化 | 社内サーバ(bot 内)+ 録音sidecar |
| **C5** | gap-tracker | 答えられなかった質問を **専門家に1問依頼** して埋める | 社内サーバ(毎日 定時) |
| **C6** | expertise-mapper | 「誰が何に詳しいか」を可視化・**バス係数**を検出 | GitHub Actions(毎週) |
| **C7** | interview-kit | 未文書化の穴を突く **面談質問リスト** を生成 | GitHub Actions(手動起動) |
| **C8** | freshness-checker | 古くなった記事を **owner に確認** して鮮度を保つ | 社内サーバ(毎日 定時) |
| L1 | kb-core | 台帳の読み書き・形式チェックの **共通ルール** | 共通ライブラリ |
| L2 | llm | AI 呼び出し・指示文の管理・コスト記録 | 共通ライブラリ |
| L3 | gh-client | GitHub とのやりとり(認証・PR作成) | 共通ライブラリ |

> 📌 **バス係数**とは「その人が突然いなくなると立ち行かなくなる人数」。**1 が最も危険**(一人しか知らない)。
> C6 はこの「バス係数 1 の領域」を見つけて警告するのが仕事です。

---

## 6. 各部品を図解

### C1 discord-bot — 質問応答の窓口(`/ask`)

`/ask 質問文` と打つと、AI が議事録とナレッジ台帳を検索し、**根拠リンク付き** で答えます。
根拠が無ければ **推測せず「未回答」** として記録します(これが後で穴埋めの燃料になる)。

```mermaid
sequenceDiagram
    participant U as 👤 質問者
    participant B as discord-bot
    participant G as GitHub(議事録・台帳)
    U->>B: /ask 「分注機の温度補正は入ってた?」
    B-->>U: 「調べています…」(スレッドで返信)
    B->>G: 議事録・ナレッジを AI で検索
    alt 根拠が見つかった
        B-->>U: 回答 + 出典リンク + 👍 / 👎 ボタン
    else 見つからない
        B-->>U: 「見つかりませんでした」と正直に宣言
        B->>G: 質問を questions/open/ に保存(=燃料)
    end
```

**ポイント**: AI に許すのは「読む・探す」だけで、「書き込む・コマンド実行・ネット接続」は禁止。
悪意ある文章を読んでも実害が出ない設計です(プロンプトインジェクション対策)。

### C2 extractor — 毎晩の自動記事化

```mermaid
flowchart LR
    A["前回以降の<br/>新しい議事録"] --> B["AI が要点抽出<br/>決定 / 学び / 宿題"]
    B --> C{"既存記事と照合"}
    C -->|重複| D["出典を追記するだけ"]
    C -->|矛盾| E["世代交代の提案"]
    C -->|新規| F["新しい記事を作成"]
    D & E & F --> G["1日1本の PR に<br/>まとめて提案"]
    G --> H["#stratum-ops に通知<br/>👍 でマージ"]
```

人間は「PR を見て 👍」だけ。無理な水増しはせず、雑談だけの議事録は「抽出なし」を正解とします。

### C3 pr-miner — PR から設計判断を発掘(毎週)

開発の PR には「なぜこう決めたか」「何にハマったか」が埋もれています。
diff(コードの差分)そのものは知識化せず、**判断と理由だけ** を抜き出して台帳に提案します。

### C4 voice-memo — 喋るだけでナレッジ化

2 つの入口があります。どちらも「喋る」以外の手間はほぼゼロです。

```mermaid
flowchart TB
    subgraph IN2["入口"]
      A1["#voice-memo に<br/>音声を投稿"]
      A2["専用VCに1人で入室<br/>→ 自動録音"]
    end
    A1 --> T["文字起こし(OpenAI)"]
    A2 --> R["録音sidecarが録る"] --> T
    T --> O["原本を interviews/ に保存"]
    O --> DR["AI が記事の草案を作成 → 単発 PR"]
    DR --> DM["投稿者に DM「👍 でOK」"]
    DR --> RE["スレッドに「こう記録しました」<br/>訂正は返信で反映"]

    classDef n fill:#f7fafc,stroke:#4a5568,color:#1a202c
    class A1,A2,T,R,O,DR,DM,RE n
```

> 🎙️ **VC録音**(ADR-0020)は最近追加された第 2 の入口。専用ボイスチャンネルに **1 人で入ると録音開始、
> 出ると終了**。録音は専用の録音 Bot と sidecar(補助コンテナ)が担当します。

### C5 gap-tracker — フライホイール(穴埋めの循環)

このシステムを賢く育てる中核です。

```mermaid
sequenceDiagram
    participant B as bot(質問ログ)
    participant GT as gap-tracker
    participant E as 🧑‍🔬 専門家
    participant K as ナレッジ台帳
    participant Q as 元の質問者
    B->>GT: 答えられなかった質問
    GT->>GT: 「誰が詳しいか」を専門性マップで選定
    GT->>E: 「〇〇について 1〜2 文で教えて」と依頼
    E-->>GT: スレッドに返信するだけ
    GT->>K: 回答をナレッジ化(PR)
    E->>K: 👍 でマージ
    GT->>Q: 「あなたの質問がナレッジ化されました」
```

> 専門家 1 人への依頼は **週 3 件まで**。特定の人に負担が集中するのを防ぎます(依頼疲れ対策)。

### C6 expertise-mapper — 「誰が何に詳しいか」の地図(稼働中)

議事録・commit・ナレッジから、トピックごとの詳しい人を集計し、**バス係数 1(=一人しか知らない)** の
危険領域を検出して警告します。この部品は **すでに本番稼働中**(毎週月曜 02:00 に自動実行)。

### C7 interview-kit — 穴を突く面談質問リスト

「まだ文書化されていない所」を狙って、AI が面談用の質問 10〜15 問を生成します。
それを使って 30〜60 分ヒアリング → 録音 → 自動で複数記事化、という流れです(手動で起動)。

### C8 freshness-checker — 鮮度を保つ

```mermaid
flowchart LR
    A["確認期限を過ぎた<br/>有効な記事"] --> B["owner に DM で確認"]
    B --> C{"どれか押す"}
    C -->|👍 正しい| D["確認日を更新"]
    C -->|✏️ 直す| E["編集用の下書きPRをDM"]
    C -->|🗑 もう古い| F["stale(要確認)に降格"]
    B -.14日 無反応.-> F
    F --> G["/ask で引用される時は<br/>『※最終確認から時間が経過』と注記"]
```

> 古い記事も **回答から消しはしません**。「時間が経っています」と注記を付けて引用するだけ。
> 1 人あたり 1 日 2 件までしか確認を求めません(確認疲れ対策)。

---

## 7. 現在の実装状況(ダッシュボード)

**結論から言うと、設計ロードマップ(Phase 0〜4)のコードはすべて実装・マージ済みです。**

```mermaid
flowchart LR
    P0["Phase 0<br/>基盤"] --> P1["Phase 1<br/>Q&A Bot"] --> P2["Phase 2<br/>抽出"] --> P3["Phase 3<br/>キャプチャ+還流"] --> P4["Phase 4<br/>専門性+鮮度"] --> P5["Phase 5<br/>継続改善"]
    classDef done fill:#c6f6d5,stroke:#2f855a,color:#1a202c
    classDef now fill:#fefcbf,stroke:#b7791f,color:#1a202c
    class P0,P1,P2,P3,P4 done
    class P5 now
```

各部品の状態を「コード」と「本番で動いているか」に分けて見ると、こうなります。

### ステータスの見方
- ✅ **稼働中** — コード完成 & 実際に動いている
- 🟦 **有効化待ち** — コード完成。あとは人間が鍵・設定を入れてスイッチを入れるだけ
- ⚙️ **将来対応** — 記録済みの追加開発予定(今は未着手でも困らない)

```mermaid
flowchart TB
    subgraph LIVE["✅ 稼働中"]
      L1c["共通部品 kb-core / llm / gh-client"]
      C1c["C1 discord-bot(常駐・/ask 中心)"]
      C6c["C6 expertise-mapper(毎週 自動)"]
      C8c["C8 freshness-checker(毎日 定時)"]
      EVc["週次ゴールデン評価(品質チェック)"]
    end
    subgraph READY["🟦 コード完成・有効化待ち"]
      C2c["C2 extractor(夜間・既定は下書きのみ)"]
      C3c["C3 pr-miner(週次・対象リポ未設定でOFF)"]
      C4c["C4 voice-memo + VC録音"]
      C5c["C5 gap-tracker(サーバ定時)"]
      C7c["C7 interview-kit(手動起動)"]
    end
    subgraph FUTURE["⚙️ 将来対応(記録済み)"]
      F1["Discord発言 収集"]
      F2["議事録の発言者ラベル 収集"]
      F3["矛盾検出バッチ"]
      F4["共通コードのパッケージ化"]
    end

    classDef live fill:#c6f6d5,stroke:#2f855a,color:#1a202c
    classDef ready fill:#bee3f8,stroke:#2b6cb0,color:#1a202c
    classDef future fill:#e2e8f0,stroke:#718096,color:#1a202c
    class L1c,C1c,C6c,C8c,EVc live
    class C2c,C3c,C4c,C5c,C7c ready
    class F1,F2,F3,F4 future
```

### 詳細ステータス表

| 部品 | コード | 本番稼働 | 補足 |
|---|:---:|:---:|---|
| L1 kb-core / L2 llm / L3 gh-client | ✅ | ✅ | 全アプリが利用。形式チェック CI 稼働 |
| **C1 discord-bot** | ✅ | ✅ | 社内 VM の Docker で常駐。`/ask` 稼働。💡/音声/鮮度の各 UI は設定投入で順次有効化 |
| **C2 extractor** | ✅ | 🟦 | 夜間バッチは組込み済み。**実 PR 提案は既定 OFF(下書きのみ)**。対象リポ変数 +`REAL` フラグで有効化 |
| **C3 pr-miner** | ✅ | 🟦 | 週次バッチ組込み済み。**対象リポ未設定=OFF**。§14#5(対象リポ決定)+`REAL` フラグ待ち |
| **C4 voice-memo(+VC録音)** | ✅ | 🟦 | 音声メモ・VC録音とも全マージ済み。OpenAI 鍵・専用チャンネル・録音Bot の投入待ち |
| **C5 gap-tracker** | ✅ | 🟦 | サーバ定時タイマーの配置・有効化待ち |
| **C6 expertise-mapper** | ✅ | ✅ | **2026-07-16 本番稼働開始**。毎週月曜 02:00 に自動実行(初回実 commit 済み) |
| **C7 interview-kit** | ✅ | 🟦 | 手動起動(workflow_dispatch)。台帳リポ変数を入れれば即使える |
| **C8 freshness-checker** | ✅ | ✅ | **2026-07-18 稼働確認済み**(期限検知 → DM → 🗑 → stale 降格 commit を実データで一周)。毎平日 11:00 に自動実行 |
| 週次ゴールデン評価 | ✅ | ✅ | Q&A 品質を毎週自動採点し、劣化を #stratum-ops に警告 |

> ⚠️ **C8 の E2E で見つかった不具合(修正済み)**: discord.js(チャットライブラリ)の既知バグで、
> **一度も開いていない DM への絵文字リアクションが検知されない** という問題がありました。
> 対策として「起動時にメンバー全員の DM を温めておく(warmDmChannels)」修正を投入済み(PR #68)。
> 残る片付けは「/ask の注記表示の目視」と「検証用カナリア記事 kb-2026-0004 の削除」の 2 点のみです。

---

## 8. 残タスク

残りは大きく **3 種類** です。難しいコード作業はほぼ残っておらず、中心は「設定を入れる」人間作業です。

```mermaid
flowchart TB
    R["残タスク"] --> A["A. 有効化<br/>(鍵・設定を入れてスイッチON)"]
    R --> B["B. 将来のコード追加<br/>(今は無くても困らない)"]
    R --> C["C. 経営・リーダーの判断"]
    classDef a fill:#bee3f8,stroke:#2b6cb0,color:#1a202c
    classDef b fill:#e2e8f0,stroke:#718096,color:#1a202c
    classDef c fill:#fed7d7,stroke:#c53030,color:#1a202c
    class A a
    class B b
    class C c
```

### A. 有効化タスク(人間が設定を入れる)

各部品には「開始手順書(runbook)」が [docs/runbooks/](./runbooks/) に用意されています。

| 対象 | やること(要約) | 手順書 |
|---|---|---|
| C2 extractor | 対象リポ変数を設定 → 下書きを目視 → `EXTRACTOR_REAL_PR` を ON | [extractor-real-run.md](./runbooks/extractor-real-run.md) |
| C3 pr-miner | §14#5 で対象リポを決定 → 変数設定 → `PR_MINER_REAL` を ON | [pr-miner-weekly.md](./runbooks/pr-miner-weekly.md) |
| C4 voice-memo | OpenAI API 鍵を発行しサーバへ → 専用 `#voice-memo` を作成 → 設定 yaml | (音声) |
| C4 VC録音 | 録音専用 Bot を発行 → 専用 VC を作成 → `voice.yaml` に設定 → compose 起動 | [voice-memo-vc.md](./runbooks/voice-memo-vc.md) |
| C5 gap-tracker | サーバの定時タイマー(systemd unit)を配置・有効化 | [deploy/](./deploy/)(`stratum-gap-tracker.timer`) |
| C8 freshness-checker | 設定配置 → 下書き確認 → `FRESHNESS_REAL` を ON → E2E 仕上げ | [freshness.md](./runbooks/freshness.md) |
| C7 interview-kit | 台帳リポ変数を設定(手動起動なので即利用可) | — |

### B. 将来のコード追加(記録済み・急がない)

- 🧩 **Discord 発言の収集** — 専門性マップ(C6)の材料を増やす。名簿が埋まってから
- 🧩 **議事録の発言者ラベル収集** — 「誰が何を言ったか」をより正確に
- 🧩 **矛盾検出バッチ** — 「もう古い🗑」で溜まる矛盾候補を処理する消費者
- 🧩 **共通コードのパッケージ化** — logger / kb-sync / slugify などの重複(3〜4 箇所)を 1 つに整理
- 🧩 **gap-tracker の質問者解決の修正** — 参照先を members 名簿に統一

### C. 経営・リーダーの判断(§14 未決事項)

```mermaid
flowchart LR
    D3["💰 月次API予算<br/>✅ 2〜3万円/月 で決定"]
    D4["📺 閲覧チャンネル範囲<br/>✅ ロール可視性方式で解決(ADR-0018)"]
    D5["🔧 pr-miner の対象リポ<br/>⏳ 未決(開発リーダー)"]
    D9["🏢 GitHub Org 移行<br/>⏳ Pages公開の段階で判断"]
    classDef ok fill:#c6f6d5,stroke:#2f855a,color:#1a202c
    classDef wait fill:#fed7d7,stroke:#c53030,color:#1a202c
    class D3,D4 ok
    class D5,D9 wait
```

---

## 9. 技術スタック(参考・かみ砕き版)

| 何に | 使っているもの | かみ砕くと |
|---|---|---|
| プログラム言語 | TypeScript / Node.js | Web 系で広く使われる言語 |
| AI モデル | Claude(用途で fast / standard / deep を使い分け)+ OpenAI(音声の文字起こしのみ) | 速さ・賢さ・コストのバランスで 3 段階 |
| チャット | Discord(discord.js) | 社内の会話・操作の窓口 |
| データ保管 | Git / GitHub | 「履歴が全部残る文書フォルダ」。承認は PR |
| 検索方式 | agentic search(AI がファイルを探し読む) | 専用の検索 DB は今は作らない(規模的に不要) |
| 常駐サーバ | 社内 Ubuntu VM の rootless Docker | 24時間動く部分だけをここに |
| 定時バッチ | GitHub Actions(cron) | 毎晩・毎週の自動実行。ほぼ無料 |

> 💡 あえて **やらないこと**(design.md §1.3): ベクトル DB のような専用検索基盤、汎用 Wiki の置き換え、
> 人事・給与など機微情報の取り込み、社外公開機能。**「必要になった証拠が出るまで複雑にしない」** が方針です。

---

## 10. 用語集(非エンジニア向け)

| 用語 | 意味 |
|---|---|
| **リポジトリ / リポ** | ファイルの入れ物。ここでは「プログラム置き場」と「知識置き場」の 2 つ |
| **PR(プルリクエスト)** | 「この変更を入れていい?」という提案。👍 でマージ(反映)する承認フロー |
| **マージ** | PR を承認して本体に取り込むこと |
| **commit(コミット)** | 変更を 1 まとまりとして記録すること |
| **出典 / provenance** | 知識の根拠(どの記録の何行目か)。このシステムでは必須 |
| **フライホイール** | 「答えられない質問 → 専門家に聞く → ナレッジ化」の自己増殖ループ |
| **バス係数** | その人が突然いなくなると困る人数。1 が最も危険 |
| **stale(ステイル)** | 鮮度確認が取れていない状態。消しはしないが「※古いかも」注記が付く |
| **cron(クロン)** | 「毎晩 3 時」のように定時で自動実行する仕組み |
| **sidecar(サイドカー)** | 本体を助ける補助プログラム(ここでは VC 録音担当) |
| **ADR** | 設計判断とその理由の記録([docs/adr/](./adr/) に連番で保管) |
| **E2E** | End-to-End。最初から最後まで通しで動くかの確認 |
| **runbook** | 「この機能を有効化する手順書」([docs/runbooks/](./runbooks/)) |

---

### もっと詳しく知りたい人へ
- 設計の全体・受け入れ条件: [docs/design.md](./design.md)
- 個別の設計判断の経緯: [docs/adr/](./adr/)(ADR-0001〜0020)
- 各機能の有効化手順: [docs/runbooks/](./runbooks/)
- サーバへの配置手順: [docs/deploy/README.md](./deploy/README.md)
