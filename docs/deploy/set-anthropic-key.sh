#!/usr/bin/env bash
# stratum — Claude Platform on AWS の API キー(ANTHROPIC_AWS_API_KEY)を差し替える(ADR-0008 / §9.1)。
#
# 使い方(開発機 WSL で実行。先にキーをクリップボードへコピーしておく):
#   ./docs/deploy/set-anthropic-key.sh              # クリップボードから読む(WSL)
#   ./docs/deploy/set-anthropic-key.sh --prompt     # 端末に貼り付ける(入力は表示しない)
#   ./docs/deploy/set-anthropic-key.sh --stdin < keyfile
#
# やること(2 の疎通確認に失敗したら、何も変更せずに終了する):
#   1. キーの形式を確認する(AEAA… / 約 132 字)
#   2. VM から Claude Platform on AWS を直接呼んで、キーが通ることを確認する
#   3. VM の stratum.env を更新する(日付付きバックアップを取り、パーミッションは 600 のまま)
#   4. bot コンテナを作り直す(env_file は restart では読み直されないため up -d --force-recreate)
#   5. コンテナ内の Claude Code(bot と同じ経路)で疎通を確認する
#   6. GitHub Actions の secret を更新する(gh secret set)
#   7. 開発機の .env を更新する(該当する行がある場合だけ)
# 最後にクリップボードを空にする(--clipboard のとき)。
#
# キーは画面・ログ・コマンドライン引数に出さない(ssh / gh へは標準入力で渡す)。
#
# 環境変数で上書きできるもの:
#   STRATUM_SSH          VM の ssh ホスト(既定 stratum-vm)
#   STRATUM_REMOTE_ENV   VM の env ファイル(既定 $HOME/stratum/stratum.env・VM 側で展開)
#   STRATUM_REMOTE_REPO  VM の checkout(既定 $HOME/knowledge-platform・VM 側で展開)
#   STRATUM_GH_REPO      secret を置くリポ(既定 queeenb-com/knowledge-platform)
#   STRATUM_LOCAL_ENV    開発機の .env(既定 このリポの 1 つ上の .env)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

SSH_HOST="${STRATUM_SSH:-stratum-vm}"
# shellcheck disable=SC2016 # VM 側で展開する
REMOTE_ENV="${STRATUM_REMOTE_ENV:-\$HOME/stratum/stratum.env}"
# shellcheck disable=SC2016
REMOTE_REPO="${STRATUM_REMOTE_REPO:-\$HOME/knowledge-platform}"
GH_REPO="${STRATUM_GH_REPO:-queeenb-com/knowledge-platform}"
LOCAL_ENV="${STRATUM_LOCAL_ENV:-$(dirname "$REPO_DIR")/.env}"
VAR=ANTHROPIC_AWS_API_KEY

mode="${1:---clipboard}"
case "$mode" in
  --clipboard)
    if ! command -v powershell.exe >/dev/null 2>&1; then
      echo "クリップボードを読めません(WSL 以外)。--prompt か --stdin を使ってください。" >&2
      exit 1
    fi
    KEY="$(powershell.exe -NoProfile -Command 'Get-Clipboard' 2>/dev/null || true)"
    ;;
  --prompt)
    read -rsp "新しい API キーを貼り付けて Enter: " KEY
    echo
    ;;
  --stdin) KEY="$(cat)" ;;
  -h | --help)
    sed -n '2,27p' "$0"
    exit 0
    ;;
  *)
    echo "不明なオプション: $mode(--clipboard / --prompt / --stdin)" >&2
    exit 1
    ;;
esac

# コピー時に混ざりやすい空白・改行・CR・引用符を落とす。
KEY="$(printf %s "$KEY" | tr -d '\r\n\t "'"'")"

# VM 上で bash スクリプトを実行する。スクリプト本体は base64 で渡し(引用符の入れ子を避ける)、
# キーは標準入力の 1 行目で渡す(ps やシェル履歴に出さない)。
remote() {
  local body
  body="$(
    printf 'set -euo pipefail\nexport PATH="$HOME/bin:$PATH" DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"\n'
    printf 'ENV_FILE="%s"\nREPO="%s"\nIFS= read -r KEY\n' "$REMOTE_ENV" "$REMOTE_REPO"
    cat
  )"
  printf '%s\n' "$KEY" | ssh -o BatchMode=yes "$SSH_HOST" \
    "bash -c \"\$(printf %s $(printf %s "$body" | base64 -w0) | base64 -d)\""
}

echo "==> 1/7 キーの形式を確認"
if [[ ! "$KEY" =~ ^AEAA[A-Za-z0-9+/=_-]+$ ]] || ((${#KEY} < 100 || ${#KEY} > 200)); then
  echo "❌ Claude Platform on AWS のキーの形式ではありません(AEAA… で約 132 字のはず。今回: ${#KEY} 字・先頭 '${KEY:0:4}')。" >&2
  echo "   クリップボードにキーだけがコピーされているか確認してください。何も変更していません。" >&2
  exit 1
fi
echo "   OK(${#KEY} 字・先頭 ${KEY:0:4}…)"

echo "==> 2/7 VM から新しいキーで API を直接呼んで確認"
remote <<'EOS'
set -a; . "$ENV_FILE"; set +a
out=$(printf 'x-api-key: %s\n' "$KEY" | curl -sS -m 30 -w '\n%{http_code}' -H @- \
  -H "anthropic-workspace-id: $ANTHROPIC_AWS_WORKSPACE_ID" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}' \
  "https://aws-external-anthropic.$AWS_REGION.api.aws/v1/messages")
code=${out##*$'\n'}
if [ "$code" != 200 ]; then
  echo "❌ HTTP $code: $(printf %s "${out%$'\n'*}" | head -c 200)" >&2
  echo "   新しいキーが通りませんでした。何も変更していません。" >&2
  exit 1
fi
echo "   OK(HTTP 200)"
EOS

echo "==> 3/7 VM の stratum.env を更新"
remote <<'EOS'
backup="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$backup"
tmp="$(mktemp "$ENV_FILE.XXXXXX")"
chmod 600 "$tmp"
# キーは環境変数で awk に渡す(-v は \ をエスケープ解釈するため使わない)。
KEY="$KEY" awk -v var=ANTHROPIC_AWS_API_KEY '
  BEGIN { done = 0 }
  index($0, var "=") == 1 { print var "=" ENVIRON["KEY"]; done = 1; next }
  { print }
  END { if (!done) print var "=" ENVIRON["KEY"] }
' "$ENV_FILE" >"$tmp"
mv "$tmp" "$ENV_FILE"
echo "   OK(バックアップ: $backup)"
EOS

echo "==> 4/7 bot コンテナを作り直す"
remote <<'EOS'
cd "$REPO"
docker compose up -d --force-recreate bot 2>&1 | tail -2 | sed 's/^/   /'
EOS

echo "==> 5/7 bot コンテナ内の Claude Code で疎通確認"
remote <<'EOS'
cd "$REPO"
for i in $(seq 1 20); do
  docker compose exec -T bot true >/dev/null 2>&1 && break
  sleep 2
done
bin=$(docker compose exec -T bot sh -c 'ls -d /app/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@*/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude | tail -1')
res=$(docker compose exec -T -w /tmp bot sh -c "timeout 120 $bin -p 'reply with just OK' 2>&1 | tail -1")
if ! printf %s "$res" | grep -q OK; then
  echo "❌ コンテナ内の疎通確認に失敗: $(printf %s "$res" | head -c 200)" >&2
  exit 1
fi
echo "   OK"
EOS

echo "==> 6/7 GitHub Actions の secret を更新($GH_REPO)"
printf %s "$KEY" | gh secret set "$VAR" -R "$GH_REPO"
echo "   OK"

echo "==> 7/7 開発機の .env を更新"
if [ -f "$LOCAL_ENV" ] && grep -q "^$VAR=" "$LOCAL_ENV"; then
  cp -p "$LOCAL_ENV" "$LOCAL_ENV.bak-$(date +%Y%m%d-%H%M%S)"
  tmp="$(mktemp "$LOCAL_ENV.XXXXXX")"
  chmod --reference="$LOCAL_ENV" "$tmp"
  KEY="$KEY" awk -v var="$VAR" '
    index($0, var "=") == 1 { print var "=" ENVIRON["KEY"]; next }
    { print }
  ' "$LOCAL_ENV" >"$tmp"
  mv "$tmp" "$LOCAL_ENV"
  echo "   OK($LOCAL_ENV)"
else
  echo "   スキップ($LOCAL_ENV に $VAR の行がありません)"
fi

if [ "$mode" = --clipboard ]; then
  powershell.exe -NoProfile -Command 'Set-Clipboard -Value $null' >/dev/null 2>&1 || true
  echo "   クリップボードを空にしました"
fi

echo ""
echo "✅ API キーを差し替えました(VM・GitHub Actions・開発機)。bot のログ: docker compose logs -f bot"
