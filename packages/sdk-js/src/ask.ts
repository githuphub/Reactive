// AskHandle: the two-stage answer of one ask. `instant` resolves first (rules / cache / bake), then an optional
// AI `upgrade` follows (WS or long-poll); streamed replies deliver partial sentences in between.
import type { AskKind, AskResponse } from "@liveforge/protocol";
import type { Unsubscribe } from "./emitter.js";

/** One streamed piece of an upgrade (npc.reply with stream:true). */
export interface AskPartial {
  /** This chunk's text (usually one sentence). */
  text: string;
  /** Everything streamed so far, joined with spaces. */
  full: string;
  seq: number;
  /** True on the last chunk (the final `upgrade` follows). */
  done: boolean;
}

/** What `client.ask()` returns. */
export interface AskHandle<K extends AskKind = AskKind> {
  /** Ask id (client-generated; upgrades and chunks reuse it). */
  readonly id: string;
  readonly kind: K;
  /**
   * The instant answer (rules, cache or bake pack). When the server is unreachable it resolves from the local
   * fallback cache / packs / `setFallback` (source "cache" | "bake" | "rules"); it rejects only when nothing local
   * exists either.
   */
  readonly instant: Promise<AskResponse<K>>;
  /** The AI upgrade, or null when none comes (no AI key, budget, `upgrade:false`, timeout, offline). Never rejects. */
  readonly upgrade: Promise<AskResponse<K> | null>;
  /** The best answer: the upgrade when one arrives, else the instant answer. */
  readonly final: Promise<AskResponse<K>>;
  /** Streamed partial text (npc.reply with stream:true). Late subscribers get the chunks so far replayed. */
  onPartial(fn: (partial: AskPartial) => void): Unsubscribe;
  /** Like onPartial with (text, seq) arguments (the K0 client stub's name). */
  onChunk(fn: (text: string, seq: number) => void): Unsubscribe;
  /** Runs once with the upgrade (right away if it already arrived). Not called when there is no upgrade. */
  onUpgrade(fn: (response: AskResponse<K>) => void): Unsubscribe;
  /** The newest answer received so far (undefined before the instant answer). */
  readonly latest: AskResponse<K> | undefined;
  /** True once the upgrade settled (arrived, or known not to come). */
  readonly settled: boolean;
  /** Stop waiting for an upgrade (`upgrade` resolves null). */
  cancel(): void;
}

/** Internal implementation; the client drives it. */
export class AskHandleImpl<K extends AskKind> implements AskHandle<K> {
  readonly instant: Promise<AskResponse<K>>;
  readonly upgrade: Promise<AskResponse<K> | null>;
  readonly final: Promise<AskResponse<K>>;
  private resolveInstantFn!: (r: AskResponse<K>) => void;
  private rejectInstantFn!: (e: unknown) => void;
  private resolveUpgradeFn!: (r: AskResponse<K> | null) => void;
  private instantDone = false;
  private upgradeDone = false;
  private earlyUpgrade: AskResponse<K> | null | undefined = undefined;
  private readonly partials: AskPartial[] = [];
  private readonly partialFns = new Set<(p: AskPartial) => void>();
  private readonly upgradeFns = new Set<(r: AskResponse<K>) => void>();
  private _latest: AskResponse<K> | undefined;
  private upgradeValue: AskResponse<K> | null = null;
  /** Called when the handle settles (the client drops it from its pending map). */
  onSettled: (() => void) | null = null;

  constructor(readonly id: string, readonly kind: K) {
    this.instant = new Promise<AskResponse<K>>((res, rej) => {
      this.resolveInstantFn = res;
      this.rejectInstantFn = rej;
    });
    this.upgrade = new Promise<AskResponse<K> | null>((res) => {
      this.resolveUpgradeFn = res;
    });
    this.final = this.instant.then(async (inst) => (await this.upgrade) ?? inst);
    // Mark as handled so ignoring one of them never raises "unhandled rejection"; awaiting still rejects.
    this.instant.catch(() => {});
    this.final.catch(() => {});
  }

  get latest(): AskResponse<K> | undefined {
    return this._latest;
  }

  get settled(): boolean {
    return this.upgradeDone;
  }

  get instantSettled(): boolean {
    return this.instantDone;
  }

  onPartial(fn: (p: AskPartial) => void): Unsubscribe {
    for (const p of this.partials) safe(() => fn(p));
    this.partialFns.add(fn);
    return () => this.partialFns.delete(fn);
  }

  onChunk(fn: (text: string, seq: number) => void): Unsubscribe {
    return this.onPartial((p) => fn(p.text, p.seq));
  }

  onUpgrade(fn: (r: AskResponse<K>) => void): Unsubscribe {
    if (this.upgradeDone) {
      if (this.upgradeValue) safe(() => fn(this.upgradeValue as AskResponse<K>));
      return () => {};
    }
    this.upgradeFns.add(fn);
    return () => this.upgradeFns.delete(fn);
  }

  cancel(): void {
    this.settleUpgrade(null);
  }

  // ---- driven by the client

  resolveInstant(r: AskResponse<K>): void {
    if (this.instantDone) return;
    this.instantDone = true;
    this._latest = r;
    this.resolveInstantFn(r);
    if (this.earlyUpgrade !== undefined) {
      const up = this.earlyUpgrade;
      this.earlyUpgrade = undefined;
      // Let `instant` listeners run first ("resolve instant, then fire onUpgrade").
      queueMicrotask(() => this.settleUpgrade(up));
    }
  }

  rejectInstant(err: unknown): void {
    if (this.instantDone) return;
    this.instantDone = true;
    this.rejectInstantFn(err);
    this.settleUpgrade(null);
  }

  /** Upgrade (or null = none coming). Buffered until the instant answer resolved. */
  settleUpgrade(r: AskResponse<K> | null): void {
    if (this.upgradeDone) return;
    if (!this.instantDone) {
      if (r) this.earlyUpgrade = r;
      else if (this.earlyUpgrade === undefined) this.earlyUpgrade = null;
      return;
    }
    this.upgradeDone = true;
    this.upgradeValue = r;
    if (r) {
      this._latest = r;
      for (const fn of this.upgradeFns) safe(() => fn(r));
    }
    this.upgradeFns.clear();
    this.partialFns.clear();
    this.resolveUpgradeFn(r);
    this.onSettled?.();
  }

  pushPartial(seq: number, text: string, done: boolean): void {
    if (this.upgradeDone) return;
    if (this.partials.some((p) => p.seq === seq)) return;
    const full = [...this.partials.map((p) => p.text), text].join(" ").replace(/\s+/g, " ").trim();
    const p: AskPartial = { text, full, seq, done };
    this.partials.push(p);
    for (const fn of this.partialFns) safe(() => fn(p));
  }
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error("[liveforge] ask listener threw", err);
  }
}
