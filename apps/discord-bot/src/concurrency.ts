/**
 * プロセス内の直列実行キュー(design.md §6.2)。
 * 同時に複数の /ask を受けてもクラッシュせず、1 件ずつ順に処理する。
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;

  /** 実行中 + 待機中のタスク数(進捗表示「前に N 件」用・ADR-0035 D5)。 */
  get pending(): number {
    return this.count;
  }

  /**
   * task を「前の処理の完了後」に実行し、その結果を返す。
   * あるタスクが失敗しても後続は実行され続ける(失敗は呼び出し側の Promise にのみ伝播)。
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.count += 1;
    const run = this.tail.then(task, task).finally(() => {
      this.count -= 1;
    });
    // 後続が前段の成否に影響されないよう、失敗を飲み込んだ Promise を tail にする。
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
