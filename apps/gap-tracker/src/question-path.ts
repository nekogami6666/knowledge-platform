/**
 * questions/open のファイル名解決(ADR-0027 D3)。
 * gap-tracker 起票は `<id>.md`、extractor 起票は `<id>-<slug>.md` と basename の形式が混在する。
 * ID からパスを再構成せず、ディレクトリ列挙から実体を発見する(ingest の回答捕捉と close の
 * answered 移動が extractor 起票質問でも機能するための要・KP #112 スコープ)。
 */

/**
 * 列挙した basename 群から questionId に対応するファイルを探す。
 * `<id>.md` の完全一致、または `<id>-`(slug 区切り)で始まるもの。ID の suffix は固定長
 * (旧4桁 / 乱数6文字・ADR-0026)なので `<id>-` プレフィックスが別 ID に誤一致することはない。
 */
export function matchOpenQuestionBasename(
  names: readonly string[],
  questionId: string,
): string | undefined {
  return names.find((n) => n === `${questionId}.md` || n.startsWith(`${questionId}-`));
}
