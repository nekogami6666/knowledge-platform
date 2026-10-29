/**
 * エラーを「原因まで含めた 1 行」にする(バッチの最上位 catch・失敗通知用)。
 *
 * 各層のラッパ(GhClientError・LlmError 等)は原因を `cause` に入れて投げ直すが、最上位で
 * `e.message` だけを出すと「PR 一覧の取得に失敗しました」のように原因が消える(2026-10-23)。
 * cause を最大 MAX_DEPTH 段たどり、各段の name / code / HTTP status / リクエスト(method・URL)/
 * API のエラーメッセージ / errno・syscall を `←` でつなぐ。
 *
 * 秘密値は出さない(§9.1): ヘッダ・リクエスト本文は読まない。URL は資格情報(user:pass@)と
 * クエリを除く。トークンらしい文字列(ghp_ / gho_ / github_pat_ / x-access-token)は伏せる。
 */
import { stripCredentials } from "./kb-sync.js";

const MAX_DEPTH = 5;
const MAX_PART = 300;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** トークンらしい文字列を伏せる。 */
export function maskSecrets(s: string): string {
  return s
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1***@")
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "$1_***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-***")
    .replace(/\bAEAA[A-Za-z0-9_-]{20,}/g, "AEAA***");
}

function cleanUrl(url: string): string {
  return stripCredentials(url).split("?")[0] ?? url;
}

/** 1 段分の説明(`HttpError 502 GET https://api.github.com/…: Server Error` 等)。 */
function describeOne(e: unknown): string {
  if (!isObj(e)) return String(e);
  const parts: string[] = [];
  const name = str(e.name);
  const message = str(e.message);
  const code = e.code;
  const status = typeof e.status === "number" ? e.status : undefined;

  const head = [
    name,
    typeof code === "string" || typeof code === "number" ? String(code) : undefined,
  ]
    .filter((x) => x !== undefined)
    .join(" ");
  if (head !== "") parts.push(head);
  if (status !== undefined) parts.push(`HTTP ${status}`);

  const req = isObj(e.request) ? e.request : undefined;
  const method = req !== undefined ? str(req.method) : undefined;
  const url = req !== undefined ? str(req.url) : undefined;
  if (method !== undefined || url !== undefined) {
    parts.push([method, url !== undefined ? cleanUrl(url) : undefined].filter(Boolean).join(" "));
  }

  // Octokit の HttpError は API のエラーメッセージを response.data.message に持つ。
  const res = isObj(e.response) ? e.response : undefined;
  const apiMessage = res !== undefined && isObj(res.data) ? str(res.data.message) : undefined;

  // Node のシステムエラー(ECONNRESET 等)は code に加えて syscall / errno を持つ。
  const syscall = str(e.syscall);
  const errno = typeof e.errno === "number" ? String(e.errno) : str(e.errno);
  if (syscall !== undefined) parts.push(`syscall=${syscall}`);
  if (errno !== undefined && errno !== String(code)) parts.push(`errno=${errno}`);

  let text = parts.join(" ");
  const msg = message ?? apiMessage;
  if (msg !== undefined) text = text === "" ? msg : `${text}: ${msg}`;
  if (apiMessage !== undefined && message !== undefined && !message.includes(apiMessage)) {
    text += ` (${apiMessage})`;
  }
  if (text === "") text = String(e);
  return text.length > MAX_PART ? `${text.slice(0, MAX_PART)}…` : text;
}

/**
 * 原因チェーンを `外側 ← 内側 ← …` の 1 行にする。message が同じ段は重複して出さない。
 */
export function describeError(e: unknown): string {
  const out: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  for (let depth = 0; depth < MAX_DEPTH && cur !== undefined && cur !== null; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const line = describeOne(cur);
    if (out.at(-1) !== line) out.push(line);
    cur = isObj(cur) ? cur.cause : undefined;
  }
  if (cur !== undefined && cur !== null && !seen.has(cur)) out.push("…");
  return maskSecrets(out.length > 0 ? out.join(" ← ") : String(e));
}
