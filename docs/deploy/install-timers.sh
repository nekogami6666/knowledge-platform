#!/usr/bin/env bash
# stratum の gap-tracker / freshness-checker を VM の systemd user timer として設置する
# (ADR-0014 / ADR-0019)。README の「手で __PLACEHOLDER__ を置換」を自動化する。冪等。
#
# 使い方(VM 上・リポジトリのどこからでも):
#   ./docs/deploy/install-timers.sh          # dry-run のまま設置(初回検証向け・GAP/FRESHNESS_REAL 無し)
#   ./docs/deploy/install-timers.sh --real    # GAP_TRACKER_REAL / FRESHNESS_REAL を有効化して設置
#
# 前提:
#   - bot デプロイ(deploy.sh)で ~/stratum/stratum.env を用意済み
#     (gap-tracker は DISCORD_GAP_WEBHOOK / GitHub 認証、freshness も bot と同じ env を共用)。
#   - Node 22(nvm)を有効化済み。gap-tracker/freshness の dist をビルド済み(update.sh の `pnpm -r build`)。
# 上書き変数(任意): STRATUM_DATA_DIR(既定 ~/stratum)/ STRATUM_ENV_FILE(既定 $DATA_DIR/stratum.env)。
set -euo pipefail

REAL=0
[ "${1:-}" = "--real" ] && REAL=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_DIR="${STRATUM_DATA_DIR:-$HOME/stratum}"
ENV_FILE="${STRATUM_ENV_FILE:-$DATA_DIR/stratum.env}"
NODE_BIN="$(command -v node || true)"
UNIT_DIR="$HOME/.config/systemd/user"

# --- 事前チェック(致命はエラー、運用ミスは WARN) ---
[ -n "$NODE_BIN" ] || {
  echo "ERROR: node が見つかりません。nvm で Node 22 を有効化してから実行してください。" >&2
  exit 1
}
[ -f "$ENV_FILE" ] || echo "WARN: $ENV_FILE がありません。deploy.sh で作成し、DISCORD_GAP_WEBHOOK / DISCORD_OPS_WEBHOOK / GitHub 認証を入れてください。" >&2
for app in gap-tracker freshness-checker; do
  [ -f "$REPO_DIR/apps/$app/dist/index.js" ] || echo "WARN: apps/$app/dist が未ビルドです。先に 'pnpm -r build'(または update.sh)を実行してください。" >&2
done

mkdir -p "$UNIT_DIR" "$DATA_DIR/data" "$DATA_DIR/clones-gap" "$DATA_DIR/clones-freshness"

# $1=unit basename(stratum-xxx) / $2=有効化する REAL 環境変数名
render() {
  local base="$1" realvar="$2" dst="$UNIT_DIR/$1.service"
  sed -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$SCRIPT_DIR/$base.service" >"$dst"
  if [ "$REAL" = "1" ]; then
    sed -i "s|^# Environment=$realvar=1|Environment=$realvar=1|" "$dst"
  fi
  cp "$SCRIPT_DIR/$base.timer" "$UNIT_DIR/$base.timer"
  echo "  installed: $dst  ($([ "$REAL" = 1 ] && echo REAL || echo dry-run))"
}

echo "REPO_DIR=$REPO_DIR  DATA_DIR=$DATA_DIR  ENV_FILE=$ENV_FILE  NODE=$NODE_BIN  REAL=$REAL"
render stratum-gap-tracker GAP_TRACKER_REAL
render stratum-freshness FRESHNESS_REAL

systemctl --user daemon-reload
systemctl --user enable --now stratum-gap-tracker.timer stratum-freshness.timer
loginctl enable-linger "$USER" >/dev/null 2>&1 || echo "WARN: enable-linger に失敗(polkit 制限)。IT に一度だけ依頼してください(母艦再起動後の自動起動に必要)。"

echo ""
echo "完了。次回タイマーで自動起動します(gap=平日10:00 JST / freshness=平日11:00 JST):"
systemctl --user list-timers stratum-gap-tracker.timer stratum-freshness.timer --no-pager || true
echo ""
echo "初回は手動起動で検証してください(まず --real 無しの dry-run 推奨):"
echo "  systemctl --user start stratum-gap-tracker.service && journalctl --user -u stratum-gap-tracker -n 40 --no-pager"
echo "  systemctl --user start stratum-freshness.service   && journalctl --user -u stratum-freshness   -n 40 --no-pager"
