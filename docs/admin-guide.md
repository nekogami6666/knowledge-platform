# ナレッジ共有 bot 管理ガイド(管理者向け)

システムの全体像・日々見るもの・よくある設定変更・障害時の対応をまとめた、管理者の入口です。
ユーザー向けの操作説明は [user-guide.md](user-guide.md)、個別の詳細手順は [runbooks/](runbooks/) にあります。

---

## 1. 全体像 — 何がどこで動いているか

リポジトリは 2 つに分かれています:

| リポジトリ | 中身 |
|---|---|
| `knowledge-platform` | **コード**(bot・バッチ・この文書)。mirror が nekogami6666 側にある(merge は必ず queeenb-com 側で) |
| `knowledge-base` | **ナレッジデータ本体**(Markdown)。すべての書き込みは PR 経由。CI(validate)が形式を自動検査 |

実行場所は 2 つ:

| 場所 | 動いているもの |
|---|---|
| **社内 VM**(`ssh stratum-vm`) | 常駐 bot(/ask・💡・録音・パネル・👍代理マージ)+ recorder(録音 sidecar)= docker compose。gap-tracker / freshness / stats / db-backup = systemd user timer |
| **GitHub Actions** | 夜間 extractor(議事録抽出)・週次 pr-miner(開発PRから抽出)・週次 expertise(専門性マップ)・週次 eval(回答品質)・interview-kit(手動) |

### 定期スケジュール(すべて JST)

| いつ | 何 | どこ |
|---|---|---|
| 毎日 03:00 | extractor(議事録→抽出PR) | Actions |
| 毎日 04:00 | bot.db バックアップ | VM |
| 毎日 04:30 | 録音データの掃除(14日保持) | VM |
| 平日 10:00 | gap-tracker(質問の起票・依頼・回答のナレッジ化・リマインド) | VM |
| 平日 11:00 | freshness(鮮度確認 DM) | VM |
| 月曜 09:00 | 利用統計レポート | VM |
| 週次(月曜) | pr-miner / expertise-mapper / weekly-eval | Actions |

## 2. 日常の運用 — 基本は「通知を見て 👍」

平常時に管理者がやることは、`#knowledge_sharing` に届く通知への反応だけです:

- **📥 抽出 PR 通知**(毎晩): 「今日のレビュー担当」がメンションされます。PR を見て問題なければ **👍(bot が代理マージ)**。直したければ PR を直接編集してからマージ
- **⏸ 見送り通知**: 前日の抽出 PR が未マージのまま溜まっているサイン。**レビューが滞留すると抽出が止まる**ので、メンションされた人が早めにさばく
- **⏳ wontfix レポート**: 14日以上回答が付かない質問の一覧。不要な質問なら KB 上で status を wontfix に(人間判断)
- **📊 週次統計**: /ask の利用数・有用率。KPI(週15件・70%)未達には ⚠️ が付きます

CI(validate)が赤い PR は**マージしない**のが鉄則です(bot も non-CLEAN なら代理マージを拒否します)。

## 3. 設定ファイル — どこで何を変えるか

### VM 上の設定(`~/knowledge-platform/apps/discord-bot/config/`・gitignore 済み)

| ファイル | 何を決める | 主なキー |
|---|---|---|
| `voice.yaml` | 録音まわり | `vc_channel_id`(録音VC)/ `max_recording_minutes`(既定15・**22以下推奨**)/ `interview_panel_channel_id`(面談パネルの設置先)/ `interview_arm_ttl_minutes`(面談待機の期限・既定120分) |
| `ops.yaml` | 承認まわり | `channel_id`(通知チャンネル)/ `kb_repo`(👍代理マージの対象リポ) |
| `repos.yaml` | /ask の検索対象 | 検索させるリポジトリの一覧(認証付きURL) |
| `channels.yaml` | 読み取り除外 | `permanent_exclude`(bot に読ませないチャンネル) |

gap-tracker / freshness の設定は `apps/gap-tracker/config/gap.yaml` / `apps/freshness-checker/config/freshness.yaml`:

- `gap.yaml` の **`assignees`**: 回答依頼の宛先プール。**空 = メンバー全員**(専門性マップで得意な人を優先)
- `gap.yaml` の **`fallback_assignees`**: 担当を決められない質問の宛先(日替わり交代)。現在は永田さん・根本さん

**設定だけ変えた場合**は bot の再起動で反映されます(コード変更を伴う場合は §5 のデプロイ手順):

```sh
ssh stratum-vm
cd ~/knowledge-platform && docker compose restart bot   # gap/freshness は次回タイマーから自動反映
```

### 人の情報 — knowledge-base の `_meta/members.yaml`

メンバーの入退社・表示名変更はここを PR で更新します。Discord ID ↔ GitHub 名 ↔ 表示名の対応表で、
議事録の人名解決・依頼メンション・記事の owner 解決すべての元データです。

### GitHub Actions の設定(knowledge-platform リポの Settings → Variables)

| 変数 | 意味 | 現在値の目安 |
|---|---|---|
| `EXTRACTOR_REVIEW_MENTIONS` | 抽出PR通知のレビュー担当(カンマ区切り Discord ID・日替わり) | 永田さん,根本さん。**空にすればメンション停止** |
| `PR_MINER_MAX_PRS` | pr-miner の 1 回あたり処理上限 | 15 |
| `EXTRACTOR_MINUTES_REPO` ほか | 対象リポジトリの指定 | 変更時のみ |

シークレット(API キー・App 認証・webhook URL)も同じ画面。値は runbooks/[production-cutover.md](runbooks/production-cutover.md) 参照。

## 4. よくある管理タスク

| やりたいこと | 手順 |
|---|---|
| レビュー担当を変える | `gh variable set EXTRACTOR_REVIEW_MENTIONS --body "<ID1>,<ID2>"`(翌晩から反映) |
| 回答依頼の宛先を絞る/広げる | VM の `gap.yaml` の `assignees` / `fallback_assignees` を編集(次回 10:00 から反映) |
| 面談パネルを別チャンネルへ | `voice.yaml` の `interview_panel_channel_id` を変更 → bot 再起動(旧パネルは手で削除) |
| 面談の質問リストを作る | GitHub → Actions → `interview-kit` → Run workflow(person / topic、まず `real: false` で確認) |
| 抽出を今すぐ回す | Actions → `extractor-nightly` → Run workflow(未マージの抽出 PR があると自動で見送られます) |
| メンバー追加・変更 | knowledge-base の `_meta/members.yaml` を PR で更新 |
| テスト由来のデータを消す | **KB は巻き戻し禁止**。前進コミット(削除 PR)で消し、bot.db の台帳も同時に掃除(詳細: [production-cutover.md](runbooks/production-cutover.md) のロールバック節) |

## 5. デプロイ — コードを更新したとき

merge 後の反映は実行場所で違います:

- **GitHub Actions のバッチ**(extractor / pr-miner / expertise): **マージだけで次回実行から反映**。何もしない
- **VM のもの**(bot / gap-tracker / freshness):

```sh
ssh stratum-vm
cd ~/knowledge-platform
git pull
corepack pnpm install --frozen-lockfile && corepack pnpm -r --if-present run build
docker compose --profile vc up -d --build bot     # bot(常駐)はリビルド
# gap/freshness/stats はホスト実行なので build まで済んでいれば次回タイマーから新コード
```

mirror(nekogami6666)への反映: `git push nekogami6666 origin/main:main`(merge 後に毎回)。

## 6. 監視とトラブルシュート

### まず見る場所

```sh
ssh stratum-vm
cd ~/knowledge-platform
docker compose ps                        # bot / recorder が Up か
docker compose logs bot --tail 50        # bot のログ(エラー・warn)
systemctl --user list-timers             # タイマーの次回実行
sqlite3 ~/stratum/data/bot.db "SELECT type, state, COUNT(*) FROM pending_actions GROUP BY 1,2;"  # 処理待ちの滞留
```

### 症状別

| 症状 | 見るもの・対応 |
|---|---|
| /ask が無反応 | bot がオフライン(メンバーリストでグレー)なら VM ダウンを疑う。**VM を起動するだけで全部自動復帰**します(コンテナは restart 設定・タイマーは Persistent で追いかけ実行) |
| 抽出 PR が毎晩来ない | ⏸ 見送り通知が出ていないか(未マージ PR の滞留)。Actions の実行履歴で失敗していないか |
| DM が来ない(💡・録音・面談) | `docker compose logs bot | grep -E "voice|interview|capture"`。STT の一時失敗は自動再試行されます |
| 依頼メンションが誰にも飛ばない | 全員が週3件の上限に達している(翌週自動回復)か、`gap.yaml` の設定確認 |
| CI(validate)が赤 | そのPRはマージしない。形式エラーの内容は Actions のログに出ます |

深掘りは各 runbook へ: [面談](runbooks/interview-session.md) / [VC録音](runbooks/voice-memo-vc.md) / [鮮度確認](runbooks/freshness.md) / [pr-miner](runbooks/pr-miner-weekly.md) / [専門性マップ](runbooks/expertise-weekly.md) / [本番構成の全体](runbooks/production-cutover.md)

## 7. 守るべきルール(事故防止)

1. **CI が赤い PR はマージしない**(bot の代理マージも拒否します)
2. **knowledge-base を巻き戻さない**(force-push・revert での ID 再利用は事故の元。掃除は前進コミット + bot.db 台帳もセットで)
3. **bot を二重起動しない**(同じトークンで 2 プロセス起動すると挙動が壊れます。VM 以外で起動しない)
4. **API 予算**: 月 2〜3 万円を上限の目安に(週次統計と Claude on AWS / OpenAI の請求画面で確認)
5. **機微情報**(人事・給与・健康・経営機密)は AI が扱わないルール込みで動いていますが、
   すり抜けを見つけたら該当エントリを削除 PR で除去してください

## 8. 構成の変更を考えるとき

アーキテクチャに関わる変更(新機能・保存場所・実行場所の変更など)は、コードより先に
`docs/adr/` に決定記録(ADR)を書くのがこのリポジトリのルールです。過去の設計判断も
すべて ADR に残っているので、「なぜこうなっているのか」に迷ったら
[docs/adr/](adr/) と [design.md](design.md)(全体設計)を参照してください。
