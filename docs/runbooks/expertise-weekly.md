# Runbook: expertise-mapper 週次生成の開始(§6.6 ⑤-a / ADR-0017)

expertise-mapper が KB と対象リポの commit から専門性マップ(`expertise/expertise.yaml`)と週次レポート
(`expertise/reports/<日付>.md`)を **KB の main へ直 commit** する運用を始める手順。
自動生成物・手編集禁止(§4.5)のため PR は経ない(ADR-0017 D5)。実行はエフェメラル runner
([ADR-0013](../adr/0013-extractor-real-run-on-ephemeral-runner.md) の流儀)。

## 0. 前提

- [ ] PR-M0〜M6(ADR-0017 / kb-core members・expertise-io / mapper 本体 / gap-tracker 優先)がマージ済み
- [ ] knowledge-base に validate CI が付いている(§6.1。expertise.yaml のスキーマ検証は kb-core が実施)
- [ ] members 対応表(`_meta/members.yaml`)は**無くても動く**(v1 evidence は GitHub 名空間で完結・ADR-0017 D2)

## 1. GH_READ_PAT のスコープ追加(人間・最重要)

commit evidence は **fine-grained PAT** で読む(read = PAT / write = App・ADR-0013 D4。App の
インストール先は KB のまま広げない)。pr-miner の `GH_READ_PAT` を共用し、スコープを追加する:

- GitHub → Settings → Developer settings → Fine-grained personal access tokens → 該当 PAT を編集
- **Repository access**: 対象リポ(`EXPERTISE_TARGETS` に入れるもの)が含まれていること
- **Permissions に追加**: **Contents: Read**(listCommits 用。pr-miner の Pull requests/Issues: Read は維持)

> PAT が読めないリポは「そのリポだけ空振り」になり、レポートに ⚠️ 読み取り失敗として列挙される
> (リポ単位の失敗隔離。全体は落ちない)。

## 2. Actions secrets / vars の投入(人間・knowledge-platform リポの Settings)

| 種別 | 名前 | 値 |
|---|---|---|
| secret | `ANTHROPIC_AWS_API_KEY` / `ANTHROPIC_AWS_WORKSPACE_ID` / `AWS_REGION` | Claude on AWS(既存共用) |
| secret | `GH_APP_ID` / `GH_APP_PRIVATE_KEY` / `GH_APP_INSTALLATION_ID` | KB への main 直 commit 用 App(既存共用) |
| secret | `GH_READ_PAT` | 手順 1 の PAT(Contents: Read 追加済み) |
| secret | `EXTRACTOR_PAT` | KB checkout 用(既存共用) |
| secret | `DISCORD_OPS_WEBHOOK` | #stratum-ops(risk:high 通知) |
| var | `EXPERTISE_KB_REPO` | `org/knowledge-base` 形式。**空 = 全体 OFF**(安全な既定) |
| var | `EXPERTISE_TARGETS` | 対象リポをカンマ区切り。**空でも KB evidence 単独で動く** |

## 3. 初回の監督付き実行(ADR-0013 D1(d))

1. **dry-run 確認**: Actions → expertise-weekly → Run workflow(`EXPERTISE_REAL` はコメントのまま)。
   ログで (a) expertise-mapper.yaml 生成、(b) KB checkout、(c) `dry-run: commit は行いません` と
   生成予定ファイル・material 数・unassigned 数を確認。
2. **生成内容の目視**: dry-run ログの topics / high 件数が妥当か。おかしければ prompts/expertise/cluster.md
   を調整して再実行(dry-run は何度でも安全)。
3. **実 commit を 1 回**: workflow の `# EXPERTISE_REAL: "1"` のコメントを外して commit → Run workflow。
   KB の main に `expertise/expertise.yaml` + `expertise/reports/<日付>.md` が直 commit されること、
   risk:high があれば #stratum-ops に通知が出ることを確認。
4. 問題なければ schedule(毎週月曜 02:00 JST)に任せ、**数週レポートの「トピック名安定率」を観測**
   (9 割未満が続くなら cluster.md の指示を強める — §6.6 AC)。

## 4. ロールバック / 停止

- **全体 OFF**: var `EXPERTISE_KB_REPO` を空にする(次回実行はスキップ)。
- **dry-run に戻す**: `EXPERTISE_REAL` を再コメントアウト。
- **生成物の巻き戻し**: KB 側で revert commit(通常の GitHub 操作。次回実行が再生成する点に注意 —
  再生成そのものを止めたい場合は上の OFF と併用)。

## 5. 運用上の注意

- **generated_at の意味**: 「内容が最後に変わった時刻」。内容が同一の週は expertise.yaml を触らない
  (無意味な週次 diff を作らない・ADR-0017 D5)。レポートは毎週 1 枚(同日再実行は再 commit しない)。
- **クラスタリングの fail-loud**: LLM 出力の参照整合が是正リトライ 1 回でも直らない場合は run ごと失敗する
  (部分出力で expertise.yaml を汚さない)。Actions の失敗通知で気づける。
- **author 不明 commit**: GitHub アカウント未紐付けの commit は evidence から除外され、レポートに件数が
  出る。多い場合は本人に GitHub のメール設定を確認してもらう。
- **gap-tracker との接続**: expertise.yaml が生成されると、gap の担当選定が「質問文にトピックの
  手掛かりがあるとき、その topic の上位者を優先」に変わる(無ければ従来ラウンドロビン・PR-M6)。
