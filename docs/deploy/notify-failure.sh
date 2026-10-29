#!/usr/bin/env bash
# stratum タイマー失敗の通知本体(stratum-notify-failure@.service から呼ぶ)。
# 引数: 失敗した unit 名(%i)。DISCORD_OPS_WEBHOOK は unit の EnvironmentFile(stratum.env)から渡る。
# ExecStart に直接書くと systemd が ${…} と \" を先に解釈してコマンドが壊れる(2026-10-23 に構文エラーで
# 通知が届かなかった)ため、スクリプトに分けている。
set -euo pipefail

unit="${1:?usage: notify-failure.sh <unit>}"
if [ -z "${DISCORD_OPS_WEBHOOK:-}" ]; then
  echo "DISCORD_OPS_WEBHOOK 未設定。通知スキップ。"
  exit 0
fi

# 原因の手掛かり = 失敗した unit の直近ログから、エラーらしい行を最大 5 行。
# 資格情報入りの URL は伏せる(各 app 側でも除去しているが念のため)。
detail="$(journalctl --user -u "$unit" -n 40 -o cat --no-pager 2>/dev/null |
  grep -E 'failed|Failed|Error|error|ERR|status=' | grep -v 'Triggering OnFailure' | tail -n 5 |
  sed -E 's#(https?://)[^/@[:space:]]+@#\1***@#g' | cut -c1-300 || true)"

payload="$(UNIT="$unit" DETAIL="$detail" python3 -c '
import json, os
unit, detail = os.environ["UNIT"], os.environ["DETAIL"].strip()
msg = f"❌ VM タイマーが失敗しました: {unit}"
if detail:
    msg += "\n```\n" + detail[:1500] + "\n```"
msg += f"\n(詳細: journalctl --user -u {unit} -n 40)"
print(json.dumps({"content": msg}))
')"

curl -fsS -X POST -H "Content-Type: application/json" -d "$payload" "$DISCORD_OPS_WEBHOOK"
