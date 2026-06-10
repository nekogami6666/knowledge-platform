#!/usr/bin/env bash
# Stop hook: コード変更があるターンの終了前に typecheck / lint / test を強制する。
# exit 2 + stderr で Claude にフィードバックしてターン終了をブロックする
# (Stop hook はexit 2 のみがブロック扱い。それ以外の非ゼロは警告止まり)。
set -u

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

# 作業ツリー(未追跡含む)に .ts/.json/.yaml 系の変更がなければ重いチェックを省く
if ! git status --porcelain=v1 -uall | grep -qE '\.(ts|tsx|json|ya?ml)$'; then
  exit 0
fi

TAIL_LINES=40

run_check() {
  local name="$1"
  shift
  local out
  if ! out="$("$@" 2>&1)"; then
    {
      echo "quality-gate failed: ${name}"
      echo "--- output (last ${TAIL_LINES} lines) ---"
      echo "${out}" | tail -n "${TAIL_LINES}"
    } >&2
    exit 2
  fi
}

run_check "pnpm typecheck" pnpm typecheck
run_check "pnpm lint" pnpm lint
run_check "pnpm test" pnpm test

exit 0
