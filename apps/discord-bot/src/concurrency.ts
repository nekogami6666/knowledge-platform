/**
 * プロセス内の直列実行キュー(design.md §6.2)。
 * 同時に複数の /ask を受けてもクラッシュせず、1 件ずつ順に処理する。
 *
 * 優先度(ADR-0035 追記 2026-10-08): 待機中のタスクは high → low の順に取り出す(同じ優先度は FIFO)。
 * 利用者の操作(/ask・鮮度確認の 👍/🗑)は high、裏方の同期(all_visible の定期同期・/ask の先回り同期・
 * ロールバック後の片付け)は low にし、/ask が裏方の同期の列の後ろに並ばないようにする。
 * 実行中のタスクは優先度にかかわらず中断しない(常に同時実行 1)。既定は high(従来の FIFO と同じ挙動)。
 * low は high が続く限り待たされる(/ask は低頻度のため飢餓は実用上起きない前提)。
 */

/** タスクの優先度。 */
export type QueuePriority = "high" | "low";

export interface EnqueueOptions {
  /** 既定 "high"。 */
  priority?: QueuePriority;
}

interface Job {
  task: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (err: unknown) => void;
}

export class SerialQueue {
  private readonly waiting: Record<QueuePriority, Job[]> = { high: [], low: [] };
  private running: Job | null = null;

  /** 実行中 + 待機中のタスク数(優先度を問わない)。 */
  get pending(): number {
    return (this.running === null ? 0 : 1) + this.waiting.high.length + this.waiting.low.length;
  }

  /**
   * いま priority のタスクを積んだら、その前に実行される(実行中 + 先に取り出される待機中の)タスク数
   * (進捗表示「前に N 件」用・ADR-0035 D5)。high なら待機中の low は数えない(追い越すため)。
   */
  aheadOf(priority: QueuePriority): number {
    return (
      (this.running === null ? 0 : 1) +
      this.waiting.high.length +
      (priority === "low" ? this.waiting.low.length : 0)
    );
  }

  /**
   * task を「先に取り出されるタスクの完了後」に実行し、その結果を返す。
   * あるタスクが失敗しても後続は実行され続ける(失敗は呼び出し側の Promise にのみ伝播)。
   */
  enqueue<T>(task: () => Promise<T>, opts?: EnqueueOptions): Promise<T> {
    const priority = opts?.priority ?? "high";
    return new Promise<T>((resolve, reject) => {
      this.waiting[priority].push({ task, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  /** 実行中が無ければ次のタスクを取り出して実行する(high 優先・同じ優先度は FIFO)。 */
  private pump(): void {
    if (this.running !== null) return;
    const next = this.waiting.high.shift() ?? this.waiting.low.shift();
    if (next === undefined) return;
    this.running = next;
    // 従来どおり task は enqueue の呼び出しより後(マイクロタスク)で始める。
    // 呼び出し側へ結果を返す前に実行中を外す(await の直後に pending が完了分を数えないように)。
    const done = (): void => {
      this.running = null;
      this.pump();
    };
    void Promise.resolve()
      .then(next.task)
      .then(
        (v) => {
          done();
          next.resolve(v);
        },
        (err: unknown) => {
          done();
          next.reject(err);
        },
      );
  }
}
