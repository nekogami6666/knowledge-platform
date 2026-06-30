#!/usr/bin/env bash
# stratum Q&A bot — 更新(git pull → install → build → 再起動)。ADR-0010。
# 使い方:  ./docs/deploy/update.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
cd "$REPO_DIR"

echo "==> git pull (fast-forward only)"
git pull --ff-only

echo "==> install + build"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile
pnpm -r build

echo "==> restart service"
systemctl --user restart stratum-bot.service

echo ""
echo "✅ 更新して再起動しました。ログ:  journalctl --user -u stratum-bot -f"
