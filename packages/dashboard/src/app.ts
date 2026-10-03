// App state + a small pub/sub bus shared by every panel.
import type { Directive, StoredEvent } from "@liveforge/protocol";
import type { ConnStatus, DataSource, GameInfo, WorldSummary } from "./api/types";
import { brainSig, type BrainEntry } from "./api/brain";

export interface AppState {
  source: DataSource;
  game: GameInfo;
  worlds: WorldSummary[];
  world: string;
  /** Selected player (null = none / all). */
  player: string | null;
  conn: ConnStatus;
  connDetail?: string;
}

type Topic = "event" | "directive" | "state" | "tick" | "brain";
type Handler = (payload: unknown) => void;

/** Ring buffers of the live stream (the stream panel and the overview read these). */
export const live = {
  events: [] as StoredEvent[],
  directives: [] as Directive[],
  /** Event arrival times for the rate meter. */
  arrivals: [] as number[],
  /** Brain feed: WS {t:"brain"} entries (+ GET /v1/brain history), oldest first. */
  brain: [] as BrainEntry[],
};

const MAX_EVENTS = 1500;
const MAX_DIRECTIVES = 400;

class Bus {
  private handlers = new Map<Topic, Set<Handler>>();
  on(topic: Topic, fn: Handler): () => void {
    let set = this.handlers.get(topic);
    if (!set) this.handlers.set(topic, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  emit(topic: Topic, payload?: unknown): void {
    for (const fn of this.handlers.get(topic) ?? []) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[dashboard] ${topic} handler failed`, e);
      }
    }
  }
}

export const bus = new Bus();
let state: AppState | null = null;

export function app(): AppState {
  if (!state) throw new Error("dashboard not initialised");
  return state;
}

export function hasApp(): boolean {
  return state !== null;
}

export function initApp(s: AppState): void {
  state = s;
  live.events = [];
  live.directives = [];
  live.arrivals = [];
  live.brain = [];
  brainSeen.clear();
}

export function resetApp(): void {
  state = null;
}

export function setState(patch: Partial<AppState>): void {
  if (!state) return;
  state = { ...state, ...patch };
  bus.emit("state", state);
}

export function pushEvent(e: StoredEvent): void {
  live.events.push(e);
  if (live.events.length > MAX_EVENTS) live.events.splice(0, live.events.length - MAX_EVENTS);
  const now = Date.now();
  live.arrivals.push(now);
  while (live.arrivals.length && now - live.arrivals[0] > 60_000) live.arrivals.shift();
  bus.emit("event", e);
}

const MAX_BRAIN = 600;
const brainSeen = new Map<string, number>();

/** Add a Brain entry (de-duplicated by id and by content within 15 s) and notify panels. */
export function pushBrain(b: BrainEntry): void {
  const sig = brainSig(b);
  const prev = brainSeen.get(b.id) ?? brainSeen.get(sig);
  if (prev !== undefined && Math.abs(prev - b.ts) < 15_000) return;
  brainSeen.set(b.id, b.ts);
  brainSeen.set(sig, b.ts);
  if (brainSeen.size > 4000) brainSeen.clear();
  live.brain.push(b);
  live.brain.sort((x, y) => x.ts - y.ts);
  if (live.brain.length > MAX_BRAIN) live.brain.splice(0, live.brain.length - MAX_BRAIN);
  bus.emit("brain", b);
}

/** boss.move_added pairs: the AI upgrade re-sends the move; the later directive replaces the earlier one. */
export const replacements = {
  /** earlier directive id -> later directive id */
  replacedBy: new Map<string, string>(),
  /** later directive id -> name of the move it replaced */
  replaces: new Map<string, string>(),
};
const REPLACE_WINDOW_MS = 120_000;

function trackReplacement(d: Directive): void {
  if (d.kind !== "boss.move_added") return;
  const boss = (d.args as { boss?: string }).boss;
  for (let i = live.directives.length - 1; i >= 0; i--) {
    const p = live.directives[i];
    if (d.ts - p.ts > REPLACE_WINDOW_MS) break;
    if (p.kind !== "boss.move_added" || p.id === d.id || replacements.replacedBy.has(p.id)) continue;
    if ((p.args as { boss?: string }).boss !== boss || p.player !== d.player) continue;
    replacements.replacedBy.set(p.id, d.id);
    replacements.replaces.set(d.id, String((p.args as { move?: { name?: string } }).move?.name ?? "earlier move"));
    return;
  }
}

export function pushDirective(d: Directive): void {
  trackReplacement(d);
  live.directives.push(d);
  if (live.directives.length > MAX_DIRECTIVES) live.directives.splice(0, live.directives.length - MAX_DIRECTIVES);
  bus.emit("directive", d);
}

/** Events per minute over the last minute. */
export function eventRate(): number {
  const now = Date.now();
  return live.arrivals.filter((t) => now - t < 60_000).length;
}

/**
 * Coalesce refreshes: returns a function that runs `fn` at most once per `ms`, trailing. Panels call it on every
 * live event so projections refetch shortly after activity without hammering the server.
 */
export function throttle(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRun = 0;
  return () => {
    if (timer) return;
    const wait = Math.max(0, ms - (Date.now() - lastRun));
    timer = setTimeout(() => {
      timer = null;
      lastRun = Date.now();
      fn();
    }, wait);
  };
}
