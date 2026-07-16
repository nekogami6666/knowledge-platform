# ADR-0005: workspace パッケージの解決方式(build + exports)と build-before-typecheck

- **ステータス**: accepted
- **日付**: 2026-06-17
- **関連**: design.md §4.1.1(モノレポ構成)・§6.1(kb-core)・§10.1(CI)・§12.2(鉄則)/
  Phase 1(`packages/llm` 実装の前提)/ ADR-0001
- **備考**: 本 ADR はアーキテクチャに触れる変更(パッケージ解決方式とビルド順序)を、CLAUDE.md
  「アーキテクチャ変更はコードより先に ADR ドラフト」に従い実装前にドラフト化するもの。採択
  (`accepted`)は人間レビューで行う。`docs/design.md` は保護パスのため、確定後の §4.1.1 / §10.1
  への転記は人間レビューで行う。

## 背景

design.md §4.1.1 はモノレポ(pnpm workspaces)で `packages/kb-core` を「型の唯一の正」とし、
全アプリ・パッケージがこれを `@stratum/kb-core` として参照する前提で書かれている。しかし現状の
実装には、別パッケージから `@stratum/kb-core` を import できない 2 つの障害がある。

1. **`exports`/`main`/`types` 未定義**: `packages/kb-core/package.json` は `bin`(`kb-validate` →
   `dist/cli.js`)と `build`(`tsconfig.build.json` で `dist/` 出力)を持つが、パッケージの
   エントリポイント(`exports` / `main` / `types`)を宣言していない。`tsconfig.base.json` は
   `module: NodeNext` / `moduleResolution: NodeNext` のため、エントリ未宣言のパッケージは
   `import { sourceToUrl } from "@stratum/kb-core"` を**実行時も型解決時も解決できない**。
   Phase 1 の `packages/llm` と `apps/discord-bot` は `kb-core`(provenance / スキーマ)に依存する
   ため、この穴を塞がないと着手できない。

2. **typecheck/test が dist を要求するが build 前段が無い**: 解決方式を `exports` → `dist`
   (下記 D1)にすると、消費側の `typecheck`(`tsc --noEmit`)と `test`(vitest)は `kb-core` の
   `dist/index.d.ts` / `dist/index.js` を要求する。ところが Stop フック
   `.claude/hooks/quality-gate.sh` は `pnpm typecheck && pnpm lint && pnpm test` を順に実行し、
   このフックは保護パス(`.claude/**`)のため**編集できない**。build を挟む層をフックの外側に
   用意する必要がある。

これらは design.md の設計意図(モノレポ + 型の単一の正)を変えるものではなく、その意図を成立
させるための配線である。配線方式を本 ADR で固定する。

## 決定

### D1. 共有パッケージは `dist` をビルドし `exports`/`main`/`types` を宣言する(Option A)

`packages/kb-core` と `packages/llm` の package.json に以下を追加する:

```jsonc
"main": "./dist/index.js",
"types": "./dist/index.d.ts",
"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }
```

- 消費側(`packages/llm`、`apps/discord-bot`)は `"@stratum/kb-core": "workspace:*"`(llm 依存も
  `"@stratum/llm": "workspace:*"`)で依存を宣言する。pnpm はこの依存グラフに基づき
  topological 順(kb-core → llm → discord-bot)でビルドできる。
- `packages/llm` にも `kb-core` と同形の `tsconfig.build.json`(`noEmit:false` / `rootDir:src` /
  `outDir:dist` / `declaration:true` / `exclude: src/**/*.test.ts`)と `build` スクリプト
  (`tsc -p tsconfig.build.json`)を付け、`dist` を出力する。
- これは本番出荷の正解形であり、`kb-core` が既に `bin` を `dist/cli.js` から出している運用と整合する。

### D2. build-before-typecheck は**ルート package.json の scripts 側**で保証する

編集できない Stop フックを変えずに、フックが呼ぶ `pnpm typecheck` / `pnpm test` の実体(ルート
scripts)へ build を前段として組み込む:

```jsonc
// root package.json scripts
"build":     "pnpm -r --if-present run build",
"typecheck": "pnpm -r --if-present run build && pnpm -r run typecheck",
"test":      "pnpm -r --if-present run build && vitest run"
```

- `pnpm -r` は workspace 依存に基づく topological 順でビルドするため、消費側 typecheck/test の
  時点で依存パッケージの `dist` が揃う。
- `lint`(biome)は `dist` を必要としないため前段ビルドを入れない(biome は `dist` を ignore 済み)。
- CI(`.github/workflows/ci.yml`)でも `install → build → lint → typecheck → test` の順を明示し、
  フックとローカルと CI で同一の順序にする(design.md §10.1)。

### D3. 既存の単体テストコマンドへの影響

CLAUDE.md の `pnpm vitest run <file>`(単一テスト実行)は build を前段に持たないため、依存
パッケージの `dist` が古い/不在だと失敗しうる。単一テストを回す前に当該依存を build 済みに
する運用とする(`pnpm --filter @stratum/kb-core build` 等)。フル `pnpm test` は D2 により常に
build を経るため影響しない。

## 影響

- `packages/llm` / `apps/discord-bot` から `@stratum/kb-core` を型・実行時とも解決可能になる
  (Phase 1 着手の前提が満たされる)。
- `typecheck` / `test` が毎回 `pnpm -r build` を経るため、わずかにオーバヘッドが増える。小規模
  モノレポ(現状 3 パッケージ)では許容範囲。将来パッケージ数が増え遅くなった場合は、ADR を
  起票して incremental build(tsc `--build` / project references)や src-condition exports
  (`customConditions`)への移行を検討する。
- **design.md §4.1.1 / §10.1 への転記が必要**(本 ADR が先行)。CI 順序とパッケージ解決方式を
  反映すること。人間レビューで design.md を更新する。

## 却下した代替案

- **Option B: src-condition exports(`customConditions: ["stratum-src"]`)で dev/test は TS ソースを
  直接 import** → build 不要で内側ループは速いが、tsc・vitest・実行時 node の全ランナーに条件を
  honor させる必要があり、`verbatimModuleSyntax`/`isolatedModules` 制約もソースで満たす必要が
  あって構成が増える。discord-bot の実行(`node dist`)では結局 `default`(dist)経路が要る。
  小モノレポでは複雑さに見合わないため却下。将来の高速化オプションとして残す。
- **Stop フック `quality-gate.sh` を編集して build を挟む** → `.claude/**` は保護パス(編集ブロック)
  であり、フックはループ定義の一部。改変は設計意図に反するため却下。フックの外側(ルート scripts)
  で吸収する。
- **`exports` を `dist` ではなく `src/index.ts` を直接指す** → 実行時に TS を解釈できず、
  `node dist` 実行と矛盾するため却下。
