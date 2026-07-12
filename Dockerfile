# syntax=docker/dockerfile:1
# stratum discord-bot 本番イメージ(design.md §5.1 / §9.1 / ADR-0006)。
# ホスト非依存(ECS/Fargate/EC2/Fly/Compose 共通の OCI イメージ)。orchestration(volume・secrets・
# healthcheck・FS マウント範囲)は host 側で行う(§14 #2 決定後)。FS サンドボックス方針は docs/deploy/README.md。

# --- build 段: 依存導入 + better-sqlite3 native + ビルド + prod 抽出 ---
# node:22(非 slim)は build-essential / python を含むため better-sqlite3 の native ビルドが可能。
FROM node:22-bookworm AS build
WORKDIR /repo
RUN corepack enable
COPY . .
# frozen install → better-sqlite3 の native を明示ビルド(pnpm 10 は既定で install scripts を抑止)
# → 全 workspace を build → discord-bot を prod 依存だけに刈り込んで /app へ deploy。
# pnpm 10 の deploy は --legacy が必要(inject-workspace-packages 既定化で失敗する。VM 実証 2026-07-12)。
# deploy 後の /app は native が欠ける(スクリプト抑止が deploy にも効く)ため /app 内で焼き直す(同実証)。
RUN pnpm install --frozen-lockfile \
  && pnpm rebuild better-sqlite3 \
  && pnpm -r --if-present run build \
  && pnpm --filter @stratum/discord-bot deploy --prod --legacy /app \
  && cd /app && npm rebuild better-sqlite3 --foreground-scripts

# --- runtime 段: 最小イメージ + 非 root(ADR-0006: 余分な秘密/ツールを置かない)---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# prod 依存 + dist(better-sqlite3 の native 含む)を build 段から。
COPY --from=build --chown=node:node /app /app
# プロンプト本体(prompts/<app>/<name>.md)。CONFIG/DATA/CLONES は実行時マウント(イメージに焼かない)。
COPY --from=build --chown=node:node /repo/prompts /app/prompts
ENV PROMPTS_DIR=/app/prompts \
    CONFIG_DIR=/config \
    CLONES_DIR=/clones \
    DB_PATH=/data/bot.db
# 秘密(DISCORD_TOKEN / Claude on AWS の 4 変数 CLAUDE_CODE_USE_ANTHROPIC_AWS・ANTHROPIC_AWS_API_KEY・
# ANTHROPIC_AWS_WORKSPACE_ID・AWS_REGION)は実行時 env で渡す。イメージにもレイヤにも焼かない(§9.1・ADR-0009)。
USER node
CMD ["node", "dist/index.js"]
