/**
 * 運用通知 CLI(VM のホスト node で動く)。
 *
 *   journalctl … | node ops-notify-cli.js failure <unit>    # stratum-notify-failure@ から
 *   node ops-notify-cli.js recovered <unit>                 # stratum-notify-recovered@ から(OnSuccess)
 *   git log --format=%s A..B | node ops-notify-cli.js deploy <A> <B>   # update.sh から
 *
 * env: DISCORD_OPS_WEBHOOK(未設定なら投稿せず記録だけ)/ OPS_STATE_DIR(失敗中の印と出来事の記録。
 * 既定 ./data/ops)。週次レポート(stats-cli)が同じ OPS_STATE_DIR を読む。
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeError } from "@stratum/shared";
import { type OpsNotifyCommand, runOpsNotify } from "./ops-notify.js";
import { isoJst } from "./time.js";

function readStdin(): string {
  try {
    return process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** unit 名をファイル名に使えるようにする(systemd の unit 名は英数・@ . - _ のみだが念のため)。 */
function markerName(unit: string): string {
  return unit.replace(/[^A-Za-z0-9@._-]/g, "_");
}

function parseCommand(argv: readonly string[], stdin: string): OpsNotifyCommand {
  const [kind, a, b] = argv;
  const lines = stdin.split("\n").filter((l) => l.trim() !== "");
  if (kind === "failure" && a) return { kind, unit: a, lines };
  if (kind === "recovered" && a) return { kind, unit: a };
  if (kind === "deploy" && a && b) return { kind, fromSha: a, toSha: b, subjects: lines };
  throw new Error("usage: ops-notify-cli (failure <unit> | recovered <unit> | deploy <from> <to>)");
}

async function main(): Promise<void> {
  const cmd = parseCommand(process.argv.slice(2), readStdin());
  const stateDir = process.env.OPS_STATE_DIR ?? "./data/ops";
  const failingDir = join(stateDir, "failing");
  mkdirSync(failingDir, { recursive: true });
  const webhook = process.env.DISCORD_OPS_WEBHOOK;

  await runOpsNotify(cmd, {
    post: async (content) => {
      if (webhook === undefined || webhook === "") {
        console.log("DISCORD_OPS_WEBHOOK 未設定。通知スキップ(記録のみ)。");
        return;
      }
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.slice(0, 1900) }),
      });
      if (!res.ok) throw new Error(`webhook POST HTTP ${res.status}`);
    },
    readMarker: (unit) => {
      try {
        return readFileSync(join(failingDir, markerName(unit)), "utf8").trim() || null;
      } catch {
        return null;
      }
    },
    writeMarker: (unit, ts) => writeFileSync(join(failingDir, markerName(unit)), `${ts}\n`),
    removeMarker: (unit) => rmSync(join(failingDir, markerName(unit)), { force: true }),
    appendEvent: (e) => appendFileSync(join(stateDir, "events.jsonl"), `${JSON.stringify(e)}\n`),
    now: () => isoJst(),
  });
}

main().catch((err) => {
  console.error(`ops-notify-cli: ${describeError(err)}`);
  process.exitCode = 1;
});
