// Tiny typed event emitter (no dependencies, browser + Node).

/** Map of event name -> listener signature. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventMap = Record<string, (...args: any[]) => void>;

/** Call to remove the listener you just added. */
export type Unsubscribe = () => void;

/**
 * Minimal typed emitter. Listener exceptions are caught and logged so one bad listener never breaks the client.
 */
export class Emitter<E extends EventMap> {
  private readonly listeners = new Map<keyof E, Set<E[keyof E]>>();

  /** Adds a listener; returns a function that removes it. */
  on<K extends keyof E>(event: K, fn: E[K]): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => this.off(event, fn);
  }

  /** Adds a listener that runs at most once. */
  once<K extends keyof E>(event: K, fn: E[K]): Unsubscribe {
    const wrap = ((...args: Parameters<E[K]>) => {
      off();
      fn(...args);
    }) as E[K];
    const off = this.on(event, wrap);
    return off;
  }

  /** Removes a listener. */
  off<K extends keyof E>(event: K, fn: E[K]): void {
    this.listeners.get(event)?.delete(fn);
  }

  /** Number of listeners for an event. */
  listenerCount<K extends keyof E>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /** Removes every listener. */
  clear(): void {
    this.listeners.clear();
  }

  /** Calls every listener of `event` with `args`. */
  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[liveforge] listener for "${String(event)}" threw`, err);
      }
    }
  }
}
