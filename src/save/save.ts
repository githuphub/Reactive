/**
 * IndexedDB persistence per seed: chunk diffs (only edited blocks) and arbitrary system state.
 *
 * Other systems persist themselves with:
 * ```ts
 * game.save.register('mobs', () => serialize(), (data) => restore(data));
 * game.save.markDirty('mobs'); // after a change (writes are debounced)
 * ```
 * `register` restores immediately if saved data exists. Values must be structured-cloneable.
 */
import { chunkIndex, chunkKey } from '../engine/constants';

const DB_NAME = 'livecraft';
const DB_VERSION = 1;
const STORE_CHUNKS = 'chunks';
const STORE_KV = 'kv';
const FLUSH_DELAY_MS = 1500;

interface Registration {
  serialize: () => unknown;
  deserialize: (data: never) => void;
}

export class SaveManager {
  private readonly diffs = new Map<number, Map<number, number>>();
  private readonly dirtyChunks = new Set<number>();
  private readonly kv = new Map<string, unknown>();
  private readonly regs = new Map<string, Registration>();
  private readonly dirtyKeys = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  private constructor(readonly seed: string, private readonly db: IDBDatabase | null) {}

  /**
   * Opens the save for a seed and loads it into memory. With `fresh`, the old save for this seed
   * is cleared first. Falls back to memory-only if IndexedDB is unavailable.
   */
  static async open(seed: string, opts: { fresh?: boolean } = {}): Promise<SaveManager> {
    let db: IDBDatabase | null = null;
    try {
      db = await openDb();
    } catch (err) {
      console.warn('[save] IndexedDB unavailable; progress will not persist', err);
    }
    const save = new SaveManager(seed, db);
    if (db) {
      if (opts.fresh) await save.clear();
      else await save.load();
    }
    window.addEventListener('pagehide', () => void save.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void save.flush();
    });
    return save;
  }

  // -- chunk diffs ----------------------------------------------------------------------------

  /** Records an edited block (called by the world store for every non-gen change). */
  recordBlock(x: number, y: number, z: number, raw: number): void {
    const key = chunkKey(x >> 4, z >> 4);
    let m = this.diffs.get(key);
    if (!m) {
      m = new Map();
      this.diffs.set(key, m);
    }
    m.set(chunkIndex(x & 15, y, z & 15), raw);
    this.dirtyChunks.add(key);
    this.scheduleFlush();
  }

  /** Saved edits of a chunk as [index, raw, index, raw, ...], or undefined. */
  diffsFor(cx: number, cz: number): Uint32Array | undefined {
    const m = this.diffs.get(chunkKey(cx, cz));
    if (!m || m.size === 0) return undefined;
    const out = new Uint32Array(m.size * 2);
    let i = 0;
    for (const [idx, raw] of m) {
      out[i++] = idx;
      out[i++] = raw;
    }
    return out;
  }

  /** Number of chunks with edits. */
  get editedChunks(): number {
    return this.diffs.size;
  }

  // -- system state ---------------------------------------------------------------------------

  /**
   * Registers a persisted state slot. If data was saved before, `deserialize` runs immediately.
   * Call `markDirty(key)` when the state changes; everything is also saved on page hide.
   */
  register<T>(key: string, serialize: () => T, deserialize: (data: T) => void): void {
    this.regs.set(key, { serialize, deserialize: deserialize as (data: never) => void });
    if (this.kv.has(key)) {
      try {
        deserialize(this.kv.get(key) as T);
      } catch (err) {
        console.error(`[save] restoring "${key}" failed`, err);
      }
    }
  }

  /** True if a value was saved for `key` (useful to decide between restore and first-run setup). */
  has(key: string): boolean {
    return this.kv.has(key);
  }

  /** Raw saved value (before any registration). */
  get<T>(key: string): T | undefined {
    return this.kv.get(key) as T | undefined;
  }

  /** Marks a registered slot (or all slots when omitted) for the next debounced write. */
  markDirty(key?: string): void {
    if (key) this.dirtyKeys.add(key);
    else for (const k of this.regs.keys()) this.dirtyKeys.add(k);
    this.scheduleFlush();
  }

  /** Writes everything pending now. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing) await this.flushing;
    for (const k of this.regs.keys()) this.dirtyKeys.add(k);
    if (!this.db) return;
    const chunks = [...this.dirtyChunks];
    const keys = [...this.dirtyKeys];
    this.dirtyChunks.clear();
    this.dirtyKeys.clear();
    if (!chunks.length && !keys.length) return;
    const db = this.db;
    this.flushing = new Promise<void>((resolve) => {
      const tx = db.transaction([STORE_CHUNKS, STORE_KV], 'readwrite');
      const cs = tx.objectStore(STORE_CHUNKS);
      const ks = tx.objectStore(STORE_KV);
      for (const key of chunks) {
        const m = this.diffs.get(key);
        if (!m) continue;
        const arr = new Uint32Array(m.size * 2);
        let i = 0;
        for (const [idx, raw] of m) {
          arr[i++] = idx;
          arr[i++] = raw;
        }
        cs.put(arr, `${this.seed}:${key}`);
      }
      for (const k of keys) {
        const reg = this.regs.get(k);
        if (!reg) continue;
        try {
          const v = reg.serialize();
          this.kv.set(k, v);
          ks.put(v, `${this.seed}:${k}`);
        } catch (err) {
          console.error(`[save] serializing "${k}" failed`, err);
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.error('[save] write failed', tx.error);
        resolve();
      };
    }).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Deletes all saved data for this seed (memory and disk). */
  async clear(): Promise<void> {
    this.diffs.clear();
    this.kv.clear();
    if (!this.db) return;
    const range = IDBKeyRange.bound(`${this.seed}:`, `${this.seed}:￿`);
    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction([STORE_CHUNKS, STORE_KV], 'readwrite');
      tx.objectStore(STORE_CHUNKS).delete(range);
      tx.objectStore(STORE_KV).delete(range);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  private async load(): Promise<void> {
    const db = this.db!;
    const prefix = `${this.seed}:`;
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    await new Promise<void>((resolve) => {
      const tx = db.transaction([STORE_CHUNKS, STORE_KV], 'readonly');
      const cReq = tx.objectStore(STORE_CHUNKS).openCursor(range);
      cReq.onsuccess = () => {
        const cur = cReq.result;
        if (!cur) return;
        const key = Number(String(cur.key).slice(prefix.length));
        const arr = cur.value as Uint32Array;
        const m = new Map<number, number>();
        for (let i = 0; i + 1 < arr.length; i += 2) m.set(arr[i], arr[i + 1]);
        this.diffs.set(key, m);
        cur.continue();
      };
      const kReq = tx.objectStore(STORE_KV).openCursor(range);
      kReq.onsuccess = () => {
        const cur = kReq.result;
        if (!cur) return;
        this.kv.set(String(cur.key).slice(prefix.length), cur.value);
        cur.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.error('[save] load failed', tx.error);
        resolve();
      };
    });
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) db.createObjectStore(STORE_CHUNKS);
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
