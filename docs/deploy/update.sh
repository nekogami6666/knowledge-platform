#!/usr/bin/env bash
# stratum — 更新(git pull → ホスト build(gap-tracker 用)→ compose build → up -d)。ADR-0016。
# 使い方:  ./docs/deploy/update.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
cd "$REPO_DIR"

echo "==> git pull (fast-forward only)"
OLD_SHA="$(git rev-parse HEAD)"
git pull --ff-only
NEW_SHA="$(git rev-parse HEAD)"

# gap-tracker(systemd 側・ADR-0014)はホストの dist を実行するため、ホストでも build する。
# Node が無い(bot 専用 VM)場合はスキップ。
if command -v node >/dev/null 2>&1; then
  echo "==> host install + build(gap-tracker 用)"
  corepack enable >/dev/null 2>&1 || true
  # システムの node(/usr/bin)では corepack enable が root 無しでは shim を置けず、pnpm が PATH に
  # 無いまま終わる(ssh 経由の非対話実行で発生・2026-09-30)。その場合は corepack 経由で呼ぶ
  # (package.json の packageManager に固定されたバージョンが使われる)。
  if command -v pnpm >/dev/null 2>&1; then
    PNPM=(pnpm)
  else
    PNPM=(corepack pnpm)
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  fi
  "${PNPM[@]}" install --frozen-lockfile
  "${PNPM[@]}" -r build
else
  echo "==> host build をスキップ(node なし。gap-tracker を使う場合は Node 22 が必要)"
fi

echo "==> docker compose build(bot)"
docker compose build

# 反映(bot の再作成)の前に、回答中の /ask があるかを表示する(ADR-0035 追記)。止めはしない:
# 再作成時の SIGTERM で bot は受付を止め、処理中の質問を最大 SHUTDOWN_GRACE_MS 待ってから中断・通知する。
# bot.db はホスト側と共有(compose の STRATUM_DATA)。件数は host の node + better-sqlite3 で読む。
DATA_HOST="${STRATUM_DATA:-}"
if [ -z "$DATA_HOST" ] && [ -f "$REPO_DIR/.env" ]; then
  DATA_HOST="$(sed -n 's/^STRATUM_DATA=//p' "$REPO_DIR/.env" | tail -n 1)"
fi
DATA_HOST="${DATA_HOST:-$HOME/stratum/data}"
if command -v node >/dev/null 2>&1 && [ -f apps/discord-bot/dist/inflight-cli.js ]; then
  if INFLIGHT="$(DB_PATH="$DATA_HOST/bot.db" node apps/discord-bot/dist/inflight-cli.js 2>/dev/null)" &&
    [[ "$INFLIGHT" =~ ^[0-9]+$ ]]; then
    if [ "$INFLIGHT" -gt 0 ]; then
      echo "⚠️  回答中の /ask が ${INFLIGHT} 件あります。再作成すると最大 60 秒待ってから中断し、質問者に再質問を案内します。"
      echo "   急ぎでなければ、少し待ってから再実行してください(このまま続行します)。"
    else
      echo "==> 回答中の /ask はありません"
    fi
  else
    echo "==> 回答中の /ask の件数を確認できませんでした(続行します)"
  fi
fi

echo "==> docker compose up -d(bot)"
docker compose up -d

echo ""
echo "✅ 更新して再起動しました。ログ:  docker compose logs -f bot"

# 本番更新の通知(#stratum-ops)。反映した commit の件名から fix / feat / perf を載せる(ops-notify-cli)。
# webhook は stratum.env から読む(値は出さない)。通知に失敗しても更新自体は成功扱いにする。
ENV_FILE="${STRATUM_ENV_FILE:-$HOME/stratum/stratum.env}"
OPS_CLI="$REPO_DIR/apps/discord-bot/dist/ops-notify-cli.js"
if [ "$OLD_SHA" != "$NEW_SHA" ] && command -v node >/dev/null 2>&1 && [ -f "$OPS_CLI" ] && [ -f "$ENV_FILE" ]; then
  if git log --format=%s "$OLD_SHA..$NEW_SHA" |
    DISCORD_OPS_WEBHOOK="$(sed -n 's/^DISCORD_OPS_WEBHOOK=//p' "$ENV_FILE" | tail -n 1)" \
      OPS_STATE_DIR="$DATA_HOST/ops" node "$OPS_CLI" deploy "$OLD_SHA" "$NEW_SHA"; then
    echo "==> #stratum-ops へ本番更新を通知しました"
  else
    echo "WARN: 本番更新の通知に失敗しました(更新自体は完了しています)" >&2
  fi
fi
