/**
 * @stratum/shared — 複数 app で複製されていた小物の共有置き場(§2-F: 3 つ目の消費者で統合)。
 * ここに置くのは「app 固有の文脈を持たない純粋な道具」だけ。LLM は @stratum/llm、KB I/O は
 * @stratum/kb-core、GitHub は @stratum/gh-client が正であり、それらの代替ではない。
 */
export { describeError, maskSecrets } from "./describe-error.js";
export { withCloneToken } from "./git-auth.js";
export { type GitExec, type SyncedKb, stripCredentials, syncKb } from "./kb-sync.js";
export { minutesDateFromPath } from "./source-date.js";
