/**
 * 上限付き並行 map(⑱・§2-E/§2-F)。items を最大 limit 件だけ同時に fn へ流し、**入力順**で結果を返す。
 * extractor の reconcile(read-only な agentic search)を並列化して wall-clock を縮めるための最小実装。
 * 書き込み(materialize/allocateId)は呼び出し側が逐次に保つ(安全性と速度の分離)。
 *
 * NOTE(重複回避・§2-F): discord-bot の `SerialQueue` は limit=1 のキューで別プリミティブ。bounded 並行を
 * 要する2つ目の consumer が現れたら、本関数と SerialQueue を共有パッケージ(packages/shared 等)へ統合する
 * (tracking issue)。それまで extractor ローカルに置き、無言の複製を避けるため本コメントを残す。
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      const item = items[i];
      if (item === undefined) continue; // noUncheckedIndexedAccess 対策(i<length なので実際は常に定義済み)
      results[i] = await fn(item, i);
    }
  };
  // 同時ワーカー数は [1, limit] かつ items 数を超えない。limit<=0 でも 1(=逐次)に落とす。
  const width = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
