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
  pnpm install --frozen-lockfile
  pnpm -r build
else
  echo "==> host build をスキップ(node なし。gap-tracker を使う場合は Node 22 が必要)"
fi

echo "==> docker compose build + up -d(bot)"
docker compose build
docker compose up -d

echo ""
echo "✅ 更新して再起動しました。ログ:  docker compose logs -f bot"
