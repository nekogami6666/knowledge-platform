# デプロイ(Phase 1b)

stratum discord-bot を本番常駐させるためのイメージと方針。**ホスティング先(§14 #2)は未定**のため、
本ディレクトリは**ホスト非依存の OCI イメージ(`Dockerfile`)+ FS サンドボックス方針**までを定める。
fly.toml / docker-compose.yml / ECS タスク定義などの **orchestration は host 選定後に追加**する。

## イメージ

ルートの `Dockerfile`(マルチステージ):
- build 段(`node:22-bookworm`): `pnpm install --frozen-lockfile` → `pnpm rebuild better-sqlite3`
  (native コンパイル。pnpm 10 は既定で install scripts を抑止するため明示)→ `pnpm -r build` →
  `pnpm --filter @stratum/discord-bot deploy --prod /app`(prod 依存のみに刈り込み)。
- runtime 段(`node:22-bookworm-slim`、**非 root** `node`): `/app`(dist + prod 依存)+ `/app/prompts`。
  起動は `node dist/index.js`。

ビルド/起動(host 上で実行):
```sh
docker build -t stratum-bot .
docker run --rm \
  -e DISCORD_TOKEN=... -e ANTHROPIC_API_KEY=... \
  -v "$PWD/data:/data" -v "$PWD/config:/config:ro" -v "$PWD/clones:/clones" \
  stratum-bot
```
> ⚠️ 本リポジトリの開発環境では `docker build` 未検証。host 上で初回ビルドを必ず確認すること
> (特に better-sqlite3 の native が `pnpm deploy` 後の `/app` に含まれること)。

## 必要な環境(実行時)

| 変数 | 用途 | 備考 |
|---|---|---|
| `DISCORD_TOKEN` | Discord Bot | secret。イメージに焼かない(§9.1) |
| `ANTHROPIC_API_KEY` | Agent SDK | secret。同上 |
| `DB_PATH`(既定 `/data/bot.db`) | SQLite(WAL) | **永続ボリューム必須**(§4.6) |
| `CONFIG_DIR`(既定 `/config`) | channels/members/repos.yaml | read-only マウント |
| `CLONES_DIR`(既定 `/clones`) | 検索対象 clone | 書き込み可(再生成可) |
| `PROMPTS_DIR`(既定 `/app/prompts`) | プロンプト | イメージ同梱 |

## FS サンドボックス方針(ADR-0006 D1 — Phase 1b 必須)

Q&A エージェントの `Read/Grep/Glob` は cwd 外の絶対パス(`~/.ssh`、`/proc/self/environ`、兄弟ファイル等)も
読め、その内容を回答に載せて漏洩させうる(ADR-0006)。SDK にサンドボックス機能は無いため、**封じ込めは
OS/コンテナ層**で行う。Phase 1b の現実解:

1. **非 root** で実行(本 Dockerfile 実施済み)。
2. **最小イメージ**(余分な秘密・ツールを置かない。slim runtime)。
3. **read-only root FS** + 書き込みは `/data`(SQLite)・`/clones`(clone)に限定して run
   (例: `docker run --read-only --tmpfs /tmp -v data:/data -v clones:/clones ...`、または host の同等設定)。
4. **秘密は実行時 env のみ**(§9.1)。加えてコード側で **agent subprocess の env を最小許可リストに置換**
   済み(PR-6a `buildAgentEnv`。`/proc/self/environ` 経由のトークン漏洩を遮断)。

### 既知の限界(follow-up)
単一コンテナでは agent が bot と同じ FS を共有するため、`/config`(チャンネル ID 等)や `/data/bot.db`
(質問ログ)を read しうる。**clones だけに可視範囲を限定する真のプロセス FS ジェイル**(landlock /
bubblewrap / 別サンドボックス subprocess)は **host 選定(§14 #2)後の追加ハードニング**とする(ADR-0006)。
Phase 1a は synthetic データのみのため影響は限定的(ADR-0002)。

## host 選定後に追加する(defer)

- `fly.toml`(Fly.io: `[mounts]` で /data volume、healthcheck)/ `docker-compose.yml`(社内: `volumes` +
  `restart: unless-stopped` + read-only/FS 限定マウント)/ ECS タスク定義(AWS)。
- volume 作成・secrets 投入(`fly secrets` / Docker secrets / SSM 等)・healthcheck/restart。
- 週次 eval(`.github/workflows/weekly-eval.yml`)の secrets(`ANTHROPIC_API_KEY` / `DISCORD_OPS_WEBHOOK`)。
