#!/usr/bin/env bash
# stratum Q&A bot — 常駐デプロイ(社内 Ubuntu VM / rootless Docker + compose)。ADR-0016。
#
# 使い方:
#   1) このリポジトリを VM に git clone する
#   2) リポジトリのルートで:  ./docs/deploy/deploy.sh
#   3) 初回は ~/stratum/stratum.env の雛形が作られるので鍵を埋めて、もう一度実行する
#
# このスクリプトがやること: rootless Docker 確認 → ~/stratum/{data,clones} 作成 → env 雛形 →
#   compose 変数(.env)生成 → docker compose build → up -d。
# gap-tracker(systemd 側・ADR-0014)はこのスクリプトの対象外(README の gap-tracker 節参照)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
DATA_DIR="$HOME/stratum"
ENV_FILE="$DATA_DIR/stratum.env"

cd "$REPO_DIR"

echo "==> [1/5] rootless Docker + compose を確認"
if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ERROR: docker が見つかりません。rootless Docker の導入(root を要する一度きり作業を含む)は
ADR-0016 の背景と README の「前提(VM 側)」を参照してください(未導入なら IT に依頼)。
EOF
  exit 1
fi
if ! docker info --format '{{join .SecurityOptions ","}}' 2>/dev/null | grep -q rootless; then
  echo "WARN: この Docker は rootless に見えません。compose の user: \"0\" は rootless 前提です(ADR-0016 D2)。" >&2
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose plugin がありません(~/.docker/cli-plugins/ へ導入。README 前提参照)。" >&2
  exit 1
fi
echo "    docker = $(docker --version)"

echo "==> [2/5] データ用ディレクトリを作成"
mkdir -p "$DATA_DIR/data" "$DATA_DIR/clones"
echo "    $DATA_DIR/{data,clones}"

echo "==> [3/5] シークレット env ファイルを確認"
if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO_DIR/docs/deploy/env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  cat <<EOF

  雛形を作成しました: $ENV_FILE  (パーミッション 600)
  次の手順:
    1) この env を編集して REPLACE_ME を実値に置き換える:
         nano "$ENV_FILE"
       - ANTHROPIC_AWS_API_KEY は AEAA… で始まる ~131 字(Discord トークンと取り違え注意)
    2) もう一度このスクリプトを実行する:
         ./docs/deploy/deploy.sh
EOF
  exit 0
fi
if grep -q 'REPLACE_ME' "$ENV_FILE"; then
  echo "ERROR: $ENV_FILE に REPLACE_ME が残っています。実値を埋めてから再実行してください。" >&2
  exit 1
fi
chmod 600 "$ENV_FILE"
echo "    OK: $ENV_FILE"

echo "==> [4/5] compose 変数(.env)を生成"
# docker-compose.yml の ${STRATUM_*} を絶対パスで固定する(~ 展開に依存しない)。.gitignore 済み。
cat >"$REPO_DIR/.env" <<EOF
STRATUM_ENV=$ENV_FILE
STRATUM_DATA=$DATA_DIR/data
STRATUM_CLONES=$DATA_DIR/clones
EOF
echo "    $REPO_DIR/.env"

echo "==> [5/5] イメージを build して起動"
docker compose build
docker compose up -d

cat <<'EOF'

✅ 起動しました。

再起動後も動かす(初回のみ):
    loginctl enable-linger "$USER"
  確認:  loginctl show-user "$USER" | grep Linger   # => Linger=yes
         systemctl --user is-enabled docker          # => enabled

状態とログ:
    docker compose ps
    docker compose logs -f bot

ログに 'slash commands registered' と 'discord-bot started' が出れば成功です。
Discord の許可チャンネルで /ask を試してください。
更新するとき:  ./docs/deploy/update.sh
EOF
