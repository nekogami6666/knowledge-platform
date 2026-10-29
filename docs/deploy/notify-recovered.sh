#!/usr/bin/env bash
# stratum タイマーの復旧通知(stratum-notify-recovered@.service から呼ぶ。各 service の OnSuccess=)。
# 失敗中の印がある unit が成功したときだけ「復旧しました」を送る(毎回の成功では何もしない)。
set -euo pipefail

unit="${1:?usage: notify-recovered.sh <unit>}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO_DIR/apps/discord-bot/dist/ops-notify-cli.js"
[ -f "$CLI" ] || exit 0
exec node "$CLI" recovered "$unit"
