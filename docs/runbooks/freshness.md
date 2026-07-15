# Runbook: 鮮度管理(C8)の開始(§6.7 / ADR-0019)

期限切れナレッジの確認フローを本番で動かす手順。役割分担(ADR-0019):

- **freshness-checker**(VM systemd timer・平日 11:00 JST): 期限超過の active を列挙 →
  owner 別 1 日 2 件で `pending_actions(type: freshness)` に投入 + **14 日無応答の自動 stale**
- **discord-bot**(常駐): pending を owner へ **DM**(起動時 + 10 分ポーリング)→ DM への
  リアクションで応答処理 — 👍 = `last_verified` 更新 / ✏️ = 編集 PR 雛形 / 🗑 = stale 降格
- **/ask**: stale エントリを引用すると「※最終確認から時間が経っています」注記(F1・#46 実装済み)

## 0. 前提

- [ ] PR-F2〜F4(ADR-0019 / checker / bot UI)がマージ済みで、VM のコードが更新済み(`update.sh`)
- [ ] gap-tracker が同じ VM で稼働中(env ファイル・`__DATA_DIR__/clones`・`bot.db` の配置を流用する)
- [ ] KB の `_meta/members.yaml` に owner の github↔discord が登載済み(**未登載 owner はスキップされる**)
- [ ] bot 側: GitHub 認証(App trio か GITHUB_TOKEN)+ `ops.yaml` の `kb_repo` が設定済み
      (無いと起動ログに「鮮度確認の応答 UI は無効です」と出る)

## 1. checker の設定(VM)

```sh
cp apps/freshness-checker/config/freshness.yaml.example apps/freshness-checker/config/freshness.yaml
# kb_repo / kb_dir / kb_url を編集(gap.yaml と同じ値で良い)
```

systemd unit は gap-tracker と同じ手順で `__PLACEHOLDERS__` を描画して配置する
(`docs/deploy/stratum-freshness.{service,timer}` → `~/.config/systemd/user/`)。
EnvironmentFile は gap-tracker と共有できる(必要キー: `GITHUB_TOKEN` か App trio・任意で
`DISCORD_OPS_WEBHOOK`。LLM/AWS の鍵は不要)。

## 2. dry-run(FRESHNESS_REAL なしで手動 1 回)

```sh
systemctl --user daemon-reload
systemctl --user start stratum-freshness.service
journalctl --user -u stratum-freshness.service -n 50
```

確認: `dry-run: 確認 DM を投入予定` に**期待どおりのエントリと owner** が並ぶこと。
`owner が members.yaml 未登載` の warn が出たら members.yaml を先に埋める。

## 3. real 化(監督付き 1 回 → timer 有効化)

1. service の `# Environment=FRESHNESS_REAL=1` のコメントを外す → `daemon-reload` → `start` を手動 1 回
2. owner に DM が届く(1 人 2 件まで)。bot ログに `freshness` の送信記録が出る
3. DM に **👍** → KB main に `chore(freshness): … last_verified を … に更新` の commit が入ることを確認
4. `systemctl --user enable --now stratum-freshness.timer`

## 4. E2E 確認(C8 の受け入れ条件)

1. テスト用エントリ(fixture 相当)の鮮度確認 DM に **🗑** を付ける
2. KB main に `status: "stale"` の commit が入る(+ 矛盾検出キューに `contradiction_check` が積まれる)
3. `/ask` でそのエントリが引かれる質問をする → 出典行に **「※最終確認から時間が経っています」**
   が付くこと(F1 との接続 = §6.7 AC)
4. 確認後はエントリを元に戻すか、✏️ で更新する

## 運用ノート

- **14 日無応答** → checker が自動で stale へ降格し #stratum-ops に報告する(安全側の既定)
- **DM 不達**(受信拒否設定)→ pending のまま温存され、上記の自動 stale に倒れる
- 二重リアクション・bot 再起動後の再配送は冪等(2 回目は「処理済み」の案内のみ)
- validateRepo が赤い間は 👍/🗑 の commit を拒否する(ADR-0004 D2)。KB を直してから再リアクション
- ✏️ の編集 PR は雛形(変更は last_verified のみ)。PR 上で内容を直し、validate 緑でマージ

## トラブルシュート

- **DM が来ない**: ① checker のログ(投入されたか)② bot ログの `鮮度確認 DM の送信に失敗`
  (受信拒否)③ `sqlite3 bot.db "select id,state,created_at from pending_actions where type='freshness'"`
- **リアクションに反応しない**: 起動ログに「応答 UI は無効」が出ていないか(GitHub 認証 / ops.kb_repo)。
  DM 本文の `(ref: freshness/…)` 行が本人のメッセージ側に無いか(リアクションは **bot の DM 側**に付ける)
- **同じエントリの DM が毎日来る**: 来ない設計(生きている pending がある間は再投入しない)。
  来る場合は pending が done で closed 済みなのに期限超過が続いている = 👍 されていない可能性
