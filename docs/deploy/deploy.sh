#!/usr/bin/env bash
# stratum Q&A bot — 常駐デプロイ(社内 Ubuntu VM / no-root / no-Docker / systemd user)。ADR-0010。
#
# 使い方:
#   1) このリポジトリを VM に git clone する
#   2) リポジトリのルートで:  ./docs/deploy/deploy.sh
#   3) 初回は ~/stratum/stratum.env の雛形が作られるので鍵を埋めて、もう一度実行する
#
# このスクリプトがやること: Node 22 確認 → pnpm(corepack)→ install+build →
#   ~/stratum/{data,clones} 作成 → env 雛形 → systemd user unit 設置 → 起動。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
DATA_DIR="$HOME/stratum"
ENV_FILE="$DATA_DIR/stratum.env"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/stratum-bot.service"

cd "$REPO_DIR"

echo "==> [1/6] Node 22 を確認"
if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ERROR: node が見つかりません。先に nvm で Node 22 を導入してください(root 不要):
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  exec $SHELL
  nvm install 22 && corepack enable
EOF
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Node 22 以上が必要です(現在 $(node -v))。'nvm install 22' を実行してください。" >&2
  exit 1
fi
echo "    node = $NODE_BIN ($(node -v))"

echo "==> [2/6] pnpm(corepack)を有効化"
corepack enable >/dev/null 2>&1 || true
if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm が使えません。'corepack enable' を確認してください。" >&2
  exit 1
fi
echo "    pnpm = $(pnpm -v)"

echo "==> [3/6] 依存インストール + ビルド(数分かかることがあります)"
pnpm install --frozen-lockfile
pnpm -r build

echo "==> [4/6] データ用ディレクトリを作成"
mkdir -p "$DATA_DIR/data" "$DATA_DIR/clones"
echo "    $DATA_DIR/{data,clones}"

echo "==> [5/6] シークレット env ファイルを確認"
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

echo "==> [6/6] systemd ユーザサービスを設置 + 起動"
mkdir -p "$UNIT_DIR"
sed -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$REPO_DIR/docs/deploy/stratum-bot.service" >"$UNIT_FILE"
systemctl --user daemon-reload
systemctl --user enable --now stratum-bot.service

cat <<EOF

✅ 起動しました。

再起動後も動かす(初回のみ・1コマンド):
    loginctl enable-linger "$USER"
  確認:  loginctl show-user "$USER" | grep Linger   # => Linger=yes

状態とログ:
    systemctl --user status stratum-bot
    journalctl --user -u stratum-bot -f

ログに 'slash commands registered' と 'discord-bot started' が出れば成功です。
Discord の許可チャンネルで /ask を試してください。
更新するとき:  ./docs/deploy/update.sh
EOF
