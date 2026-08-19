#!/usr/bin/env bash
# stratum の gap-tracker / freshness-checker を VM の systemd user timer として設置する
# (ADR-0014 / ADR-0019)。README の「手で __PLACEHOLDER__ を置換」を自動化する。冪等。
#
# 使い方(VM 上・リポジトリのどこからでも):
#   ./docs/deploy/install-timers.sh            # dry-run のまま設置(初回検証向け・*_REAL 無し)
#   ./docs/deploy/install-timers.sh --real      # FRESHNESS_REAL 等を有効化して設置
#   ./docs/deploy/install-timers.sh --real --with-gap  # gap-tracker も enable する(既定では設置のみ・enable しない)
#
# ⚠️ 再実行時の注意(㉞ 調査 S2): このスクリプトは毎回テンプレから描画し直す。**--real を
#    付け忘れると稼働中の REAL ゲートが黙って dry-run に戻る**(freshness が pending を積まなく
#    なる等)。運用中の再実行は必ず前回と同じフラグで。gap-tracker は 2026-08-13 の判断で
#    無効化中のため、既定では enable しない(--with-gap で明示)。
#
# 前提:
#   - bot デプロイ(deploy.sh)で ~/stratum/stratum.env を用意済み
#     (gap-tracker は DISCORD_GAP_WEBHOOK / GitHub 認証、freshness も bot と同じ env を共用)。
#   - Node 22(nvm)を有効化済み。gap-tracker/freshness の dist をビルド済み(update.sh の `pnpm -r build`)。
# 上書き変数(任意): STRATUM_DATA_DIR(既定 ~/stratum)/ STRATUM_ENV_FILE(既定 $DATA_DIR/stratum.env)。
set -euo pipefail

REAL=0
WITH_GAP=0
for arg in "$@"; do
  case "$arg" in
    --real) REAL=1 ;;
    --with-gap) WITH_GAP=1 ;;
    *) echo "ERROR: 不明な引数 $arg(--real / --with-gap)" >&2; exit 1 ;;
  esac
done

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
[ -f "$REPO_DIR/apps/discord-bot/dist/stats-cli.js" ] || echo "WARN: apps/discord-bot/dist/stats-cli.js が未ビルドです。先に 'pnpm -r build' を実行してください。" >&2
[ -f "$REPO_DIR/apps/discord-bot/dist/recordings-cleanup-cli.js" ] || echo "WARN: apps/discord-bot/dist/recordings-cleanup-cli.js が未ビルドです。先に 'pnpm -r build' を実行してください。" >&2

mkdir -p "$UNIT_DIR" "$DATA_DIR/data" "$DATA_DIR/clones-gap" "$DATA_DIR/clones-freshness" "$DATA_DIR/recordings"

# $1=unit basename(stratum-xxx) / $2=有効化する REAL 環境変数名(空 = REAL ゲート無し=read-only)
render() {
  local base="$1" realvar="${2:-}" dst="$UNIT_DIR/$1.service" label="read-only"
  sed -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$SCRIPT_DIR/$base.service" >"$dst"
  if [ -n "$realvar" ]; then
    label=$([ "$REAL" = 1 ] && echo REAL || echo dry-run)
    [ "$REAL" = "1" ] && sed -i "s|^# Environment=$realvar=1|Environment=$realvar=1|" "$dst"
  fi
  cp "$SCRIPT_DIR/$base.timer" "$UNIT_DIR/$base.timer"
  echo "  installed: $dst  ($label)"
}

echo "REPO_DIR=$REPO_DIR  DATA_DIR=$DATA_DIR  ENV_FILE=$ENV_FILE  NODE=$NODE_BIN  REAL=$REAL  WITH_GAP=$WITH_GAP"
if [ "$REAL" != "1" ]; then
  echo "⚠️  --real 無し: 全 unit を dry-run ゲートで描画します。運用中の VM でこれを実行すると" >&2
  echo "⚠️  REAL 稼働中のタイマーが黙って dry-run に戻ります(意図しない場合は --real を付けて再実行)。" >&2
fi
render stratum-gap-tracker GAP_TRACKER_REAL
render stratum-freshness FRESHNESS_REAL
render stratum-stats # read-only 集計(REAL ゲート無し。DISCORD_OPS_WEBHOOK 有無が実質ゲート)
render stratum-recordings-cleanup RECORDINGS_CLEANUP_REAL
render stratum-image-prune # 月次 docker image prune(REAL ゲート無し・未使用画像のみ削除)
# 失敗通知の受け皿(template unit・timer 無し)。各 service の OnFailure= から呼ばれる。
sed -e "s|__ENV_FILE__|$ENV_FILE|g" "$SCRIPT_DIR/stratum-notify-failure@.service" \
  >"$UNIT_DIR/stratum-notify-failure@.service"
echo "  installed: $UNIT_DIR/stratum-notify-failure@.service"

systemctl --user daemon-reload
systemctl --user enable --now stratum-freshness.timer stratum-stats.timer stratum-recordings-cleanup.timer stratum-image-prune.timer
# gap-tracker は 2026-08-13 の判断で無効化中 → 既定では enable しない(unit の設置だけ行う)。
if [ "$WITH_GAP" = "1" ]; then
  systemctl --user enable --now stratum-gap-tracker.timer
else
  echo "  gap-tracker.timer は enable していません(有効化するときは --with-gap)。"
fi
loginctl enable-linger "$USER" >/dev/null 2>&1 || echo "WARN: enable-linger に失敗(polkit 制限)。IT に一度だけ依頼してください(母艦再起動後の自動起動に必要)。"

echo ""
echo "完了。次回タイマーで自動起動します(freshness=平日11:00 / stats=月09:00 / recordings-cleanup=毎日04:30 / image-prune=毎月1日05:00 JST):"
systemctl --user list-timers 'stratum-*' --no-pager || true
echo ""
echo "初回は手動起動で検証してください(まず --real 無しの dry-run 推奨):"
echo "  systemctl --user start stratum-gap-tracker.service && journalctl --user -u stratum-gap-tracker -n 40 --no-pager"
echo "  systemctl --user start stratum-freshness.service   && journalctl --user -u stratum-freshness   -n 40 --no-pager"
echo "  systemctl --user start stratum-stats.service       && journalctl --user -u stratum-stats       -n 40 --no-pager"
echo "  systemctl --user start stratum-recordings-cleanup.service && journalctl --user -u stratum-recordings-cleanup -n 40 --no-pager"
