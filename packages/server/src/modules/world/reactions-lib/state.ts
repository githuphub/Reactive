// Projection "world.reaction_ledger" (player scope, R1 Reaction Library): everything the 20 recipes remember about a
// player (appearance, outfit, clock + weather, promises, claims, haggles, boss attempts, flights, visits, damage,
// town mood, nickname, collector offers) plus the combination engine's novelty ledger (recent lines per speaker),
// per-recipe cooldowns, variant use counts and the last fired reactions with their facets (dashboard).
// Deterministic: time is event.ts, everything else comes from the event or the manifest.
import { dayPhaseOf, MoveSpec, type ReactionLedger, type StoredEvent } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { ModuleContext, Projection } from "../../../module.js";
import { safeProjection } from "../util.js";

export const LEDGER = "world.reaction_ledger";

/** Internal events recorded by the Reaction Library. */
export const LIB_EVENTS = {
  fired: "lf.reactions.fired",
  line: "lf.reactions.line",
  claim: "lf.reactions.claim",
  promise: "lf.reactions.promise",
  promiseStatus: "lf.reactions.promise_status",
  nickname: "lf.reactions.nickname",
  caught: "lf.reactions.caught",
  mood: "lf.reactions.mood",
  secret: "lf.reactions.secret",
  collector: "lf.reactions.collector",
} as const;

/** Internal events that stand in for a built-in signal (claims / promises detected in npc.reply). */
export const CANONICAL: Record<string, string> = {
  [LIB_EVENTS.claim]: "social.claim",
  [LIB_EVENTS.promise]: "social.promise",
};
export const canonicalType = (t: string): string => CANONICAL[t] ?? t;

export type LedgerState = ReactionLedger;

const empty = (): LedgerState => ({
  appearance: { wet: 0, bloodied: 0, burnt: 0, muddy: 0, ts: 0 },
  outfit: null,
  time: null,
  zone: "",
  firstTs: 0,
  lastEventTs: 0,
  session: { startedAt: 0, absenceMs: 0, count: 0 },
  nickname: null,
  promises: [],
  claims: [],
  haggles: {},
  bosses: {},
  flees: [],
  companions: [],
  visits: {},
  damage: [],
  mood: { streak: 0, kind: 0, rude: 0, turned: "neutral", ts: 0 },
  collected: {},
  ledger: {},
  cooldowns: {},
  counts: {},
  fired: [],
});

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const c01 = (v: unknown, d: number): number => Math.min(1, Math.max(0, num(v, d)));
const strs = (v: unknown, max = 12): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 48)).slice(0, max) : []);
const push = <T>(list: T[], item: T, max: number) => {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
};

const KIND_ACTS = new Set(["social.gave", "world.helped", "social.promise_kept", "quest.completed"]);
const RUDE_ACTS = new Set(["social.threatened", "economy.stole", "social.lied", "world.property_damaged", "social.promise_broken"]);

/** A due time: ms epoch when it looks like one, else seconds from `ts`. */
function dueOf(v: unknown, ts: number): number | null {
  const n = num(v, NaN);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.round(n) : Math.round(ts + n * 1000);
}

function bossMem(s: LedgerState, boss: string) {
  return (s.bosses[boss] ??= { attempts: 0, deaths: 0, wins: 0, flees: 0, lastResult: "", lastPhase: 0, dodge: { left: 0, right: 0, back: 0, fwd: 0 }, flawless: [], secret: null, ts: 0 });
}

function dirOf(v: string): "left" | "right" | "back" | "fwd" | null {
  const d = v.toLowerCase();
  if (d.includes("left")) return "left";
  if (d.includes("right")) return "right";
  if (d.includes("back") || d.includes("away")) return "back";
  if (d.includes("fwd") || d.includes("forward") || d.includes("toward") || d.includes("in")) return "fwd";
  return null;
}

function findPromise(s: LedgerState, d: Record<string, unknown>) {
  const ref = str(d.ref);
  const to = str(d.to);
  if (ref) {
    const hit = s.promises.find((p) => p.ref === ref);
    if (hit) return hit;
  }
  for (let i = s.promises.length - 1; i >= 0; i--) if (s.promises[i].status === "open" && (!to || s.promises[i].to === to)) return s.promises[i];
  return undefined;
}

function moodStep(s: LedgerState, type: string, d: Record<string, unknown>, ts: number) {
  const rude = RUDE_ACTS.has(type) || ((type === "social.claim" || type === LIB_EVENTS.claim) && d.truth === false);
  const kind = KIND_ACTS.has(type);
  if (!rude && !kind) return;
  if (kind) { s.mood.streak = s.mood.streak >= 0 ? s.mood.streak + 1 : 1; s.mood.kind++; }
  else { s.mood.streak = s.mood.streak <= 0 ? s.mood.streak - 1 : -1; s.mood.rude++; }
  s.mood.ts = ts;
}

export function applyLedger(s: LedgerState, ev: StoredEvent, m: Manifest): void {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const ts = ev.ts;
  if (!s.firstTs) s.firstTs = ts;
  const ledgerSize = m.reactions.engine.ledgerSize;
  moodStep(s, ev.type, d, ts);

  switch (ev.type) {
    // ---------------------------------------------------------------- engine bookkeeping
    case LIB_EVENTS.fired: {
      const recipe = str(d.recipe);
      const speaker = str(d.speaker) || "world";
      if (d.channel !== "bark") {
        s.cooldowns[`${recipe}|${speaker}`] = ts;
        s.cooldowns[`${recipe}|*`] = ts;
      }
      if (typeof d.cooldownKey === "string") s.cooldowns[d.cooldownKey] = ts;
      const ck = `${recipe}|${str(d.pool)}|${speaker}|${str(d.fingerprint)}`;
      s.counts[ck] = (s.counts[ck] ?? 0) + 1;
      const keys = Object.keys(s.counts);
      if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete s.counts[k];
      const line = str(d.line);
      if (line) push((s.ledger[speaker] ??= []), { ts, line, recipe, fingerprint: str(d.fingerprint), variant: Math.round(num(d.variant, -1)) }, ledgerSize);
      push(s.fired, {
        ts, recipe, speaker, ...(line ? { line } : {}), ...(d.effect ? { effect: str(d.effect) } : {}),
        fingerprint: str(d.fingerprint), facets: strs(d.facets, 16), ...(d.sentence ? { sentence: str(d.sentence).slice(0, 400) } : {}),
        why: str(d.why).slice(0, 200), directives: strs(d.directives, 8),
      }, 60);
      return;
    }
    case LIB_EVENTS.line: {
      const speaker = str(d.speaker);
      const line = str(d.line);
      if (speaker && line) push((s.ledger[speaker] ??= []), { ts, line, recipe: str(d.recipe) || "persona", fingerprint: str(d.fingerprint), variant: Math.round(num(d.variant, -1)) }, ledgerSize);
      if (typeof d.cooldownKey === "string") s.cooldowns[d.cooldownKey] = ts;
      return;
    }
    case LIB_EVENTS.nickname:
      if (str(d.name)) s.nickname = { name: str(d.name).slice(0, 40), deed: str(d.deed).slice(0, 80), ts };
      return;
    case LIB_EVENTS.caught: {
      const at = num(d.claimTs, -1);
      const c = s.claims.find((x) => x.ts === at);
      if (c) c.caught = true;
      return;
    }
    case LIB_EVENTS.mood:
      s.mood.turned = str(d.turned) || s.mood.turned;
      s.mood.streak = 0;
      return;
    case LIB_EVENTS.secret: {
      const boss = str(d.boss);
      const mv = MoveSpec.safeParse(d.move);
      if (boss && mv.success) bossMem(s, boss).secret = mv.data;
      return;
    }
    case LIB_EVENTS.collector: {
      const item = str(d.item);
      if (!item) return;
      const prev = s.collected[item];
      s.collected[item] = { name: str(d.name) || prev?.name || item, offeredAt: num(d.offeredAt, prev?.offeredAt ?? ts), theftAt: d.theftAt === undefined ? prev?.theftAt ?? null : num(d.theftAt, ts) };
      return;
    }
    case LIB_EVENTS.promiseStatus: {
      const p = s.promises.find((x) => x.ref === str(d.ref));
      if (!p) return;
      if (d.status === "broken" || d.status === "kept") { p.status = d.status; p.resolvedAt = ts; }
      if (d.reminded === true) p.reminded = true;
      return;
    }
  }
  if (ev.type.startsWith("lf.") && !(ev.type in CANONICAL)) return;

  // ---------------------------------------------------------------- player facts (signals + canonical internals)
  const prevSeen = s.lastEventTs;
  s.lastEventTs = Math.max(s.lastEventTs, ts);
  const type = canonicalType(ev.type);
  switch (type) {
    case "session.started": {
      const last = num(d.last_seen_ts, 0);
      const seen = last > 0 ? last : prevSeen;
      s.session = { startedAt: ts, absenceMs: seen > 0 ? Math.max(0, ts - seen) : 0, count: s.session.count + 1 };
      break;
    }
    case "appearance.state":
      s.appearance = {
        wet: d.wet === undefined ? s.appearance.wet : c01(d.wet, 0),
        bloodied: d.bloodied === undefined ? s.appearance.bloodied : c01(d.bloodied, 0),
        burnt: d.burnt === undefined ? s.appearance.burnt : c01(d.burnt, 0),
        muddy: d.muddy === undefined ? s.appearance.muddy : c01(d.muddy, 0),
        ts,
      };
      break;
    case "appearance.outfit": {
      const slots: NonNullable<LedgerState["outfit"]>["slots"] = {};
      const raw = d.slots && typeof d.slots === "object" ? (d.slots as Record<string, unknown>) : {};
      for (const [slot, v] of Object.entries(raw).slice(0, 16)) {
        if (!v || typeof v !== "object") continue;
        const o = v as Record<string, unknown>;
        const name = str(o.name) || str(o.id);
        if (!name) continue;
        slots[slot.slice(0, 24)] = { id: (str(o.id) || name).slice(0, 64), name: name.slice(0, 64), tags: strs(o.tags), colors: strs(o.colors ?? o.colours, 4) };
      }
      s.outfit = { slots, styleTags: strs(d.style_tags), ts };
      break;
    }
    case "gear.equipped": {
      const slot = str(d.slot) || "weapon";
      const name = str(d.name) || str(d.item);
      if (!name) break;
      const outfit = s.outfit ?? { slots: {}, styleTags: [], ts };
      outfit.slots[slot.slice(0, 24)] = { id: (str(d.item) || name).slice(0, 64), name: name.slice(0, 64), tags: strs(d.tags), colors: strs(d.colors ?? d.colours, 4) };
      outfit.ts = ts;
      s.outfit = outfit;
      break;
    }
    case "gear.unequipped":
      if (s.outfit) { delete s.outfit.slots[str(d.slot)]; s.outfit.ts = ts; }
      break;
    case "world.time": {
      const hour = ((num(d.hour, s.time?.hour ?? 12) % 24) + 24) % 24;
      s.time = {
        hour,
        day: Math.round(num(d.day, s.time?.day ?? 0)),
        weather: (str(d.weather) || s.time?.weather || "clear").toLowerCase().slice(0, 16),
        phase: (str(d.phase) || dayPhaseOf(hour)).toLowerCase().slice(0, 16),
        ts,
      };
      break;
    }
    case "movement.entered_zone": {
      const zone = str(d.zone);
      if (!zone) break;
      s.zone = zone;
      visit(s, zone, "zone", ts);
      break;
    }
    case "movement.visited": {
      const place = str(d.place);
      if (place) visit(s, place, (str(d.kind) || "area").toLowerCase(), ts);
      if (str(d.zone)) s.zone = str(d.zone);
      break;
    }
    case "social.promise": {
      const to = str(d.to);
      if (!to) break;
      const ref = (str(d.ref) || `p${ts.toString(36)}`).slice(0, 64);
      if (s.promises.some((p) => p.ref === ref && p.status === "open")) break;
      // a loan accepted from broke_support: social.promise {ref: "loan_...", owed}
      const debt = typeof d.debt === "number" ? d.debt : ref.startsWith("loan_") ? num(d.owed ?? d.amount, 0) : 0;
      const dueLabel = typeof d.due === "string" && !Number.isFinite(Number(d.due)) ? d.due.slice(0, 48) : "";
      push(s.promises, { ref, to, text: str(d.text).slice(0, 200), made: ts, due: dueOf(typeof d.due === "string" ? Number(d.due) : d.due, ts), status: "open", reminded: false, ...(dueLabel ? { dueLabel } : {}), ...(debt > 0 ? { debt } : {}) }, 30);
      break;
    }
    case "social.promise_kept":
    case "social.promise_broken": {
      const p = findPromise(s, d);
      if (p && p.status === "open") { p.status = type === "social.promise_kept" ? "kept" : "broken"; p.resolvedAt = ts; }
      break;
    }
    case "social.claim":
      push(s.claims, { to: str(d.to), text: str(d.text).slice(0, 200), truth: typeof d.truth === "boolean" ? d.truth : null, ts, caught: false }, 20);
      break;
    case "economy.haggled": {
      const npc = str(d.npc);
      if (!npc) break;
      const h = (s.haggles[npc] ??= { count: 0, won: 0, lost: 0, lastDeltaPct: 0, ts });
      h.count++;
      if (str(d.outcome) === "won") h.won++;
      else if (str(d.outcome) === "lost") h.lost++;
      h.lastDeltaPct = num(d.delta_pct, 0);
      h.ts = ts;
      break;
    }
    case "combat.boss_attempt": {
      const boss = str(d.boss);
      if (!boss) break;
      const b = bossMem(s, boss);
      b.attempts = Math.max(b.attempts + 1, Math.round(num(d.attempt, 0)));
      const result = str(d.result);
      if (result === "died") b.deaths++;
      else if (result === "won") b.wins++;
      else if (result === "fled") b.flees++;
      b.lastResult = result;
      b.lastPhase = num(d.phase, b.lastPhase);
      const dd = d.dodge_dirs && typeof d.dodge_dirs === "object" ? (d.dodge_dirs as Record<string, unknown>) : {};
      b.dodge.left += Math.max(0, num(dd.left, 0));
      b.dodge.right += Math.max(0, num(dd.right, 0));
      b.dodge.back += Math.max(0, num(dd.back, 0));
      b.dodge.fwd += Math.max(0, num(dd.fwd ?? dd.forward, 0));
      b.ts = ts;
      if (result === "fled") push(s.flees, { ts, from: boss }, 20);
      break;
    }
    case "combat.dodged": {
      const src = str(d.source);
      const dir = dirOf(str(d.direction));
      if (src && dir && m.bosses.some((b) => b.id === src)) bossMem(s, src).dodge[dir] += 1;
      break;
    }
    case "combat.phase_flawless": {
      const boss = str(d.boss);
      if (boss) push(bossMem(s, boss).flawless, num(d.phase, 1), 9);
      break;
    }
    case "combat.fled":
    case "movement.fled":
      push(s.flees, { ts, from: str(d.from) || str(d.zone) || s.zone }, 20);
      break;
    case "companion.died":
      push(s.companions, { companion: str(d.companion), killer: str(d.killer), ts }, 10);
      break;
    case "world.property_damaged":
    case "world.destroyed":
      push(s.damage, { owner: str(d.owner), object: str(d.object) || "something", value: Math.max(0, num(d.value, 10)), ts }, 30);
      break;
  }
}

function visit(s: LedgerState, place: string, kind: string, ts: number) {
  const key = place.slice(0, 64);
  const v = s.visits[key];
  if (!v) {
    s.visits[key] = { kind, count: 1, sessions: 1, lastSession: s.session.count, firstTs: ts, lastTs: ts };
    return;
  }
  v.count++;
  // a separate visit: a new session, or 10+ minutes since the last one
  if (v.lastSession !== s.session.count || ts - v.lastTs > 10 * 60_000) v.sessions++;
  v.lastSession = s.session.count;
  v.lastTs = ts;
  if (kind !== "zone") v.kind = kind;
}

export const ledgerProjection: Projection<LedgerState> = {
  name: LEDGER,
  scope: "player",
  version: 1,
  types: ["*"],
  init: () => empty(),
  apply(state, ev, env) {
    if (ev.type === "lf.directive") return;
    applyLedger(state, ev, env.manifest);
  },
};

/** The ledger for one player (empty when the world module / library is off). */
export function ledgerOf(ctx: Pick<ModuleContext, "projections">, world: string, player: string): LedgerState {
  return safeProjection<LedgerState>(ctx, LEDGER, { world, player }) ?? empty();
}
