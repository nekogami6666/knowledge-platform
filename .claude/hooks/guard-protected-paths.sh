#!/usr/bin/env bash
# PreToolUse guard: 編集系ツール(Write/Edit/MultiEdit/NotebookEdit)が保護パスを
# 対象にした場合にブロックする。
#
# 保護対象:
#   - docs/design.md      設計の唯一の正。変更は人間との合意が先(読み取りは自由)
#   - .claude/ 配下すべて  hooks・agents・skills・settings = ループの定義。自己書き換え防止
#
# 非保護(意図的に通す):
#   - docs/adr/ 配下       status: proposed の ADR ドラフト作成は Claude の仕事
#
# stdin に PreToolUse の hook JSON を受け取り、stdout に permission decision を返す。
set -euo pipefail

input=$(cat)

# NotebookEdit は notebook_path、その他は file_path にパスが入る。
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')

# パスが取れなければ判断材料なし → 素通り。
[ -z "$file" ] && exit 0

proj="${CLAUDE_PROJECT_DIR:-$PWD}"

# プロジェクトルート基準の相対パスに正規化する。
case "$file" in
  "$proj"/*) rel="${file#"$proj"/}" ;;
  *)         rel="$file" ;;
esac
rel="${rel#./}"

blocked=""
case "$rel" in
  docs/design.md)    blocked="$rel" ;;
  .claude|.claude/*) blocked="$rel" ;;
esac

[ -z "$blocked" ] && exit 0

reason="「${blocked}」の変更は人間の承認が必要です。docs/design.md(設計の唯一の正)と .claude/ 配下(hooks・agents・skills・settings = ループの定義)は、設計変更の合意および自己書き換え防止のため保護されています。変更したい場合は、変更理由を提示して人間に依頼してください。なお docs/adr/ への ADR ドラフト作成は許可されています。"

jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
