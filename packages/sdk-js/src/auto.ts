// Auto-emitters for the Reaction Library (R1): the signals a game would otherwise have to remember to send.
//  - session.started on start (with the last-seen time kept in storage, so absence_recap works across reloads)
//  - world.time ticker (your clock, or a simulated day/night cycle) + weather changes
//  - appearance tracker (wet / bloodied / burnt / muddy, with optional decay; sends only real changes)
//  - outfit tracker (appearance.outfit when the worn set changes)
//  - visited places (movement.visited once per entry)
//
//   const auto = autoEmit(lf, { clock: { dayLengthMin: 20 }, appearance: { decay: { muddy: 0.02, wet: 0.05 } } });
//   auto.setWeather("rain");  auto.appearance({ bloodied: 0.7 });  auto.visited("inn", "inn");
//   auto.outfit({ body: { id: "robe_1", name: "Crimson Robe", tags: ["regal"], colors: ["crimson"] } });
import type { Weather } from "@liveforge/protocol";
import type { LiveforgeClient } from "./client.js";
import { defaultStorage, stableStringify, type StorageLike } from "./util.js";

export type AppearanceKey = "wet" | "bloodied" | "burnt" | "muddy";
export type AppearanceState = Partial<Record<AppearanceKey, number>>;

export interface OutfitPiece {
  id: string;
  name: string;
  tags?: string[];
  colors?: string[];
}

export interface AutoEmitOptions {
  /** Send session.started now (default true). */
  session?: boolean;
  /** Where the last-seen time is kept (default localStorage; null = none, the server then uses its log). */
  storage?: StorageLike | null;
  /** World clock: emit world.time. `false` = off (default on with a simulated 24-minute day). */
  clock?:
    | false
    | {
        /** Your game's hour 0-24 (when omitted a simulated clock runs). */
        hour?: () => number;
        /** Your day counter. */
        day?: () => number;
        /** Your weather (else setWeather()). */
        weather?: () => Weather | string;
        /** Simulated clock: real minutes per in-game day (default 24). */
        dayLengthMin?: number;
        /** Simulated clock: starting hour (default 9). */
        startHour?: number;
        /** How often to check (default 5000 ms). A signal is sent only when the hour, phase or weather changes. */
        everyMs?: number;
      };
  /** Appearance tracker options. */
  appearance?: {
    /** Poll your own state (else call appearance()). */
    read?: () => AppearanceState;
    /** Per-second decay toward 0, e.g. {muddy: 0.02, wet: 0.05}. */
    decay?: AppearanceState;
    /** Smallest change that is worth a signal (default 0.1). */
    threshold?: number;
    /** Poll / decay interval (default 1000 ms). */
    everyMs?: number;
  };
  /** Same place within this many ms counts as the same visit (default 60 s). */
  revisitMs?: number;
}

type ClockOpts = Exclude<AutoEmitOptions["clock"], false | undefined>;

const APPEARANCE_KEYS: AppearanceKey[] = ["wet", "bloodied", "burnt", "muddy"];
const clamp01 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const phaseOf = (h: number) => (h >= 5 && h < 8 ? "dawn" : h >= 8 && h < 18 ? "day" : h >= 18 && h < 21 ? "dusk" : "night");

export class AutoEmitter {
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly storage: StorageLike | null;
  private readonly startedAt = Date.now();
  private weather: string = "clear";
  private lastTime = "";
  private state: Record<AppearanceKey, number> = { wet: 0, bloodied: 0, burnt: 0, muddy: 0 };
  private sent: Record<AppearanceKey, number> = { wet: 0, bloodied: 0, burnt: 0, muddy: 0 };
  private lastOutfit = "";
  private place: { id: string; at: number } | null = null;
  private stopped = false;

  constructor(private readonly lf: LiveforgeClient, private readonly opts: AutoEmitOptions = {}) {
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    if (opts.session !== false) this.sessionStarted();
    if (opts.clock !== false) this.startClock(opts.clock ?? {});
    this.startAppearance();
    // last seen: kept fresh while playing so the next session can report the absence
    this.timers.push(setInterval(() => this.touch(), 30_000));
    const g = globalThis as { addEventListener?: (t: string, f: () => void) => void };
    g.addEventListener?.("pagehide", () => this.touch());
  }

  private get seenKey(): string {
    return `liveforge:lastSeen:${this.lf.world}:${this.lf.player}`;
  }

  private touch(): void {
    try { this.storage?.setItem(this.seenKey, String(Date.now())); } catch { /* storage full / blocked */ }
  }

  /** Send session.started (done automatically on start). `lastSeenTs` overrides the stored last-seen time. */
  sessionStarted(lastSeenTs?: number): void {
    let last = lastSeenTs;
    if (last === undefined) {
      try {
        const v = Number(this.storage?.getItem(this.seenKey));
        if (Number.isFinite(v) && v > 0) last = v;
      } catch { /* ignore */ }
    }
    this.lf.signal("session.started", last ? { last_seen_ts: last } : {});
    this.touch();
  }

  // ------------------------------------------------------------------ clock + weather

  private clockOpts(): ClockOpts {
    return this.opts.clock || {};
  }

  private simHour(): number {
    const c = this.clockOpts();
    const dayMs = Math.max(1, c.dayLengthMin ?? 24) * 60_000;
    const elapsed = (Date.now() - this.startedAt) / dayMs;
    return ((c.startHour ?? 9) + elapsed * 24) % 24;
  }

  private simDay(): number {
    const c = this.clockOpts();
    const dayMs = Math.max(1, c.dayLengthMin ?? 24) * 60_000;
    return Math.floor(((c.startHour ?? 9) / 24) + (Date.now() - this.startedAt) / dayMs);
  }

  private startClock(c: ClockOpts): void {
    this.tickClock(true);
    this.timers.push(setInterval(() => this.tickClock(false), Math.max(500, c.everyMs ?? 5000)));
  }

  /** Emit world.time when the whole hour, phase or weather changed (or `force`). */
  tickClock(force = false): void {
    if (this.stopped || this.opts.clock === false) return;
    const c = this.clockOpts();
    const hour = c.hour ? c.hour() : this.simHour();
    const day = c.day ? c.day() : this.simDay();
    const weather = String(c.weather ? c.weather() : this.weather);
    const key = `${Math.floor(hour)}|${phaseOf(hour)}|${weather}|${day}`;
    if (!force && key === this.lastTime) return;
    this.lastTime = key;
    this.lf.signal("world.time", { hour: Math.round(hour * 100) / 100, day, weather, phase: phaseOf(hour) });
  }

  /** Change the weather (sent right away). */
  setWeather(weather: Weather | string): void {
    this.weather = weather;
    this.tickClock(true);
  }

  /** Report the time yourself (games with their own clock and no `clock.hour` getter). */
  setTime(hour: number, day?: number, weather?: Weather | string): void {
    if (weather) this.weather = weather;
    this.lf.signal("world.time", { hour, ...(day !== undefined ? { day } : {}), weather: this.weather, phase: phaseOf(((hour % 24) + 24) % 24) });
  }

  // ------------------------------------------------------------------ appearance

  private startAppearance(): void {
    const a = this.opts.appearance ?? {};
    const every = Math.max(200, a.everyMs ?? 1000);
    this.timers.push(setInterval(() => {
      if (a.read) this.merge(a.read());
      if (a.decay) for (const k of APPEARANCE_KEYS) if (a.decay[k]) this.state[k] = Math.max(0, this.state[k] - (a.decay[k] ?? 0) * (every / 1000));
      this.flushAppearance();
    }, every));
  }

  private merge(s: AppearanceState): void {
    for (const k of APPEARANCE_KEYS) if (s[k] !== undefined) this.state[k] = clamp01(s[k]);
  }

  private flushAppearance(): void {
    const th = this.opts.appearance?.threshold ?? 0.1;
    const changed: AppearanceState = {};
    for (const k of APPEARANCE_KEYS) {
      const v = Math.round(this.state[k] * 100) / 100;
      if (Math.abs(v - this.sent[k]) >= th || (v === 0 && this.sent[k] > 0)) {
        changed[k] = v;
        this.sent[k] = v;
      }
    }
    if (Object.keys(changed).length) this.lf.signal("appearance.state", changed);
  }

  /** Set appearance values 0-1 (e.g. {bloodied: 0.8} after a hit). Only real changes are sent. */
  appearance(state: AppearanceState): void {
    this.merge(state);
    this.flushAppearance();
  }

  /** Add to an appearance value (e.g. addAppearance("muddy", 0.2) per puddle). */
  addAppearance(key: AppearanceKey, amount: number): void {
    this.appearance({ [key]: clamp01(this.state[key] + amount) });
  }

  // ------------------------------------------------------------------ outfit

  /** Report what the player wears; sent only when it changed. */
  outfit(slots: Record<string, OutfitPiece | null | undefined>, styleTags: string[] = []): void {
    const clean: Record<string, OutfitPiece> = {};
    for (const [slot, p] of Object.entries(slots)) if (p && p.name) clean[slot] = { id: p.id || p.name, name: p.name, tags: p.tags ?? [], colors: p.colors ?? [] };
    const key = stableStringify({ clean, styleTags });
    if (key === this.lastOutfit) return;
    this.lastOutfit = key;
    this.lf.signal("appearance.outfit", { slots: clean, style_tags: styleTags });
  }

  // ------------------------------------------------------------------ places

  /** The player entered a place (inn, shop, area ...). Sent once per entry. Returns true when a signal was sent. */
  visited(place: string, kind = "area", zone?: string): boolean {
    const now = Date.now();
    if (this.place && this.place.id === place && now - this.place.at < (this.opts.revisitMs ?? 60_000)) {
      this.place.at = now;
      return false;
    }
    this.place = { id: place, at: now };
    this.lf.signal("movement.visited", { place, kind, ...(zone ? { zone } : {}) });
    return true;
  }

  /** The player left the current place (the next visited() of it counts as a new visit). */
  left(): void {
    this.place = null;
  }

  /** Stop all timers (and remember the last-seen time). */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.touch();
  }
}

/** Start the Reaction Library auto-emitters for a client. */
export function autoEmit(lf: LiveforgeClient, opts: AutoEmitOptions = {}): AutoEmitter {
  return new AutoEmitter(lf, opts);
}
