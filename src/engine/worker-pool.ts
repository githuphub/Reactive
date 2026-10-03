/**
 * Minimal promise-based worker pool. Each request gets an `id` that the worker echoes back.
 * Callers decide priority by only submitting when {@link WorkerPool.idle} slots exist.
 */
export class WorkerPool<Req extends object, Res extends { id: number }> {
  private readonly workers: Worker[] = [];
  private readonly load: number[] = [];
  private readonly pending = new Map<number, { worker: number; resolve: (r: Res) => void; reject: (e: unknown) => void }>();
  private nextId = 1;

  /**
   * @param factory creates one worker
   * @param size number of workers
   * @param perWorker max requests in flight per worker
   */
  constructor(factory: () => Worker, readonly size: number, private readonly perWorker = 2) {
    for (let i = 0; i < size; i++) {
      const w = factory();
      w.onmessage = (e: MessageEvent<Res>) => this.onMessage(i, e.data);
      w.onerror = (e) => console.error('[worker] error', e.message ?? e);
      this.workers.push(w);
      this.load.push(0);
    }
  }

  /** Free request slots across all workers. */
  get idle(): number {
    let n = 0;
    for (const l of this.load) n += Math.max(0, this.perWorker - l);
    return n;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  /** Sends a request to the least-loaded worker. */
  run(req: Omit<Req, 'id'>, transfer: Transferable[] = []): Promise<Res> {
    let best = 0;
    for (let i = 1; i < this.load.length; i++) if (this.load[i] < this.load[best]) best = i;
    const id = this.nextId++;
    this.load[best]++;
    return new Promise<Res>((resolve, reject) => {
      this.pending.set(id, { worker: best, resolve, reject });
      this.workers[best].postMessage({ ...req, id }, transfer);
    });
  }

  /** Posts a message to every worker (no reply expected). */
  broadcast(msg: unknown): void {
    for (const w of this.workers) w.postMessage(msg);
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(new Error('worker pool disposed'));
    this.pending.clear();
  }

  private onMessage(worker: number, res: Res): void {
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    this.load[worker]--;
    p.resolve(res);
  }
}

/** Default worker count: hardwareConcurrency - 1, clamped to 1..4. */
export function defaultWorkerCount(): number {
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(4, hc - 1));
}
