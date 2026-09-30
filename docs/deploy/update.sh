#!/usr/bin/env bash
# stratum — 更新(git pull → ホスト build(gap-tracker 用)→ compose build → up -d)。ADR-0016。
# 使い方:  ./docs/deploy/update.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
cd "$REPO_DIR"

echo "==> git pull (fast-forward only)"
git pull --ff-only

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

echo "==> docker compose build + up -d(bot)"
docker compose build
docker compose up -d

echo ""
echo "✅ 更新して再起動しました。ログ:  docker compose logs -f bot"
