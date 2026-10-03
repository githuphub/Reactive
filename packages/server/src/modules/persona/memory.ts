// Projection "persona.memories" (player scope): what every NPC remembers about this player. Summarised
// interactions with salience (decays over time, sharpens when recalled), an attitude -1..1 seeded from the NPC's
// faction, and a rolling summary of evicted / summarised entries. Deterministic: time = event ts.
import type { MemoryEntry, NpcMemory, PersonaMemories, StoredEvent } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { Projection } from "../../module.js";

export const MEMORIES = "persona.memories";

/** Internal events this module records (CONTRACTS §5). */
export const PERSONA_EVENTS = {
  memory: "lf.persona.memory",
  turn: "lf.persona.turn",
  attitude: "lf.persona.attitude",
  summary: "lf.persona.summary",
  questOffer: "lf.persona.quest_offer",
} as const;

export const MAX_ENTRIES = 12;
const MAX_SUMMARY = 700;
const HOUR = 3_600_000;

/** Half-life of a memory's salience by kind (harm and gifts are remembered longest). */
const HALF_LIFE: Record<MemoryEntry["kind"], number> = {
  conversation: 6 * HOUR, witnessed: 12 * HOUR, rumour: 6 * HOUR, gift: 48 * HOUR, harm: 72 * HOUR, trade: 12 * HOUR, other: 12 * HOUR,
};

/** Salience of an entry at time `now` (entry.ts = last time it was formed or recalled). */
export function effectiveSalience(e: MemoryEntry, now: number): number {
  const dt = Math.max(0, now - e.ts);
  return e.salience * Math.pow(0.5, dt / HALF_LIFE[e.kind ?? "other"]);
}

/** Memory state with the player's last known zone (for "witnessed" moments). */
export type MemoryState = PersonaMemories & { zone?: string };

const round = (x: number) => Math.round(x * 1000) / 1000;
const clampAtt = (x: number) => round(Math.max(-1, Math.min(1, x)));
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** The faction-seeded starting attitude of an NPC toward a new player. */
export function baseAttitude(m: Manifest, npc: string): number {
  const p = m.personas.find((x) => x.id === npc);
  return m.factions.find((f) => f.id === p?.faction)?.attitude ?? 0;
}

function npcMem(state: MemoryState, npc: string, player: string, m: Manifest): NpcMemory {
  let mem = state.npcs[npc];
  if (!mem) mem = state.npcs[npc] = { npc, player, attitude: baseAttitude(m, npc), entries: [], summary: "" };
  return mem;
}

function appendSummary(mem: NpcMemory, text: string): void {
  let s = mem.summary ? `${mem.summary} ${text}` : text;
  if (s.length > MAX_SUMMARY) {
    s = s.slice(s.length - MAX_SUMMARY);
    const cut = s.indexOf(". ");
    if (cut >= 0 && cut < 120) s = s.slice(cut + 2);
  }
  mem.summary = s.trim();
}

/** Add (or replace by ref) a memory; evicts the least salient entry into the summary when full. false = merged into an existing one. */
export function addEntry(mem: NpcMemory, entry: MemoryEntry, now: number): boolean {
  const e: MemoryEntry = { ...entry, text: entry.text.slice(0, 300), salience: round(Math.max(0, Math.min(1, entry.salience))) };
  if (e.ref) {
    const i = mem.entries.findIndex((x) => x.ref === e.ref);
    if (i >= 0) { mem.entries[i] = { ...e, ts: mem.entries[i].ts }; return false; }
  }
  // Same thing again shortly after (e.g. repeated hits): sharpen the existing memory instead.
  const dup = mem.entries.find((x) => x.text === e.text && now - x.ts < 10 * 60_000);
  if (dup) {
    dup.salience = round(Math.min(1, effectiveSalience(dup, now) + 0.1));
    dup.ts = now;
    return false;
  }
  mem.entries.push(e);
  while (mem.entries.length > MAX_ENTRIES) {
    let worst = 0;
    for (let i = 1; i < mem.entries.length; i++) if (effectiveSalience(mem.entries[i], now) < effectiveSalience(mem.entries[worst], now)) worst = i;
    const [gone] = mem.entries.splice(worst, 1);
    appendSummary(mem, gone.text.endsWith(".") ? gone.text : `${gone.text}.`);
  }
  return true;
}

/** Entries sorted by current salience (strongest first). */
export function salientEntries(mem: NpcMemory | undefined, now: number, n = 6): (MemoryEntry & { eff: number })[] {
  if (!mem) return [];
  return mem.entries.map((e) => ({ ...e, eff: effectiveSalience(e, now) })).sort((a, b) => b.eff - a.eff).slice(0, n);
}

const isPersona = (m: Manifest, id: string) => !!id && m.personas.some((p) => p.id === id);

export const memoriesProjection: Projection<MemoryState> = {
  name: MEMORIES,
  scope: "player",
  version: 1,
  types: [
    "lf.persona.*", "lf.observer.moment", "lf.directive",
    "social.*", "world.helped", "combat.hit", "combat.killed", "economy.stole", "economy.bought", "economy.sold",
    "quest.accepted", "movement.entered_zone",
  ],
  init() {
    return { npcs: {} };
  },
  apply(state, ev: StoredEvent, env) {
    const m = env.manifest;
    const player = env.key.player ?? "";
    const d = ev.data as Record<string, unknown>;
    const t = ev.ts;
    const remember = (npc: string, text: string, kind: MemoryEntry["kind"], salience: number, attitudeDelta = 0, ref?: string) => {
      if (!isPersona(m, npc)) return;
      const mem = npcMem(state, npc, player, m);
      const fresh = addEntry(mem, { text, kind, salience, ts: t, ...(ref ? { ref } : {}) }, t);
      // Repeats within 10 minutes (a flurry of hits) sharpen the memory but only move attitude a little.
      if (attitudeDelta) mem.attitude = clampAtt(mem.attitude + (fresh ? attitudeDelta : attitudeDelta * 0.15));
    };

    switch (ev.type) {
      // ---- persona's own facts
      case PERSONA_EVENTS.memory: {
        const npc = str(d.npc);
        const e = d.entry as Partial<MemoryEntry> | undefined;
        if (!npc || !e || typeof e.text !== "string") return;
        const mem = npcMem(state, npc, player, m);
        addEntry(mem, { text: e.text, kind: e.kind ?? "other", salience: typeof e.salience === "number" ? e.salience : 0.5, ts: t, ...(e.ref ? { ref: e.ref } : {}) }, t);
        return;
      }
      case PERSONA_EVENTS.turn: {
        const npc = str(d.npc);
        if (!npc) return;
        const mem = npcMem(state, npc, player, m);
        mem.lastTalked = t;
        const said = str(d.said).slice(0, 120);
        const reply = str(d.reply).slice(0, 140);
        const mood = typeof d.mood === "number" ? d.mood : 0;
        const acts = Array.isArray(d.actions) ? (d.actions as { action?: unknown }[]).map((a) => str(a?.action)).filter(Boolean) : [];
        const text = `They said "${said}"; I said "${reply}"${acts.length ? ` and did ${acts.join(", ")}` : ""}.`;
        addEntry(mem, { text, kind: "conversation", salience: Math.min(1, 0.45 + Math.abs(mood)), ts: t, ...(d.ref ? { ref: str(d.ref) } : {}) }, t);
        if (mood) mem.attitude = clampAtt(mem.attitude + mood);
        if (Array.isArray(d.recalled)) {
          for (const r of d.recalled) {
            const e = mem.entries.find((x) => x.ts === r && x.ref !== d.ref);
            if (e) { e.salience = round(Math.min(1, effectiveSalience(e, t) + 0.15)); e.ts = t; }
          }
        }
        return;
      }
      case PERSONA_EVENTS.attitude: {
        const npc = str(d.npc);
        if (!npc || typeof d.delta !== "number") return;
        const mem = npcMem(state, npc, player, m);
        mem.attitude = clampAtt(mem.attitude + d.delta);
        if (typeof d.reason === "string" && d.reason) addEntry(mem, { text: d.reason, kind: "other", salience: Math.min(1, 0.3 + Math.abs(d.delta)), ts: t }, t);
        return;
      }
      case PERSONA_EVENTS.summary: {
        const npc = str(d.npc);
        const mem = state.npcs[npc];
        if (!mem || typeof d.summary !== "string") return;
        mem.summary = d.summary.slice(0, MAX_SUMMARY);
        if (Array.isArray(d.forget)) {
          const forget = new Set(d.forget.filter((x): x is number => typeof x === "number"));
          mem.entries = mem.entries.filter((e) => !forget.has(e.ts));
        }
        return;
      }
      case "lf.observer.moment": {
        const mo = d.moment as { kind?: unknown; evidence?: unknown; salience?: unknown; id?: unknown; data?: Record<string, unknown> } | undefined;
        if (!mo || typeof mo.salience !== "number" || mo.salience < 0.5) return;
        const zone = state.zone;
        const ev0 = Array.isArray(mo.evidence) && typeof mo.evidence[0] === "string" ? ` (${mo.evidence[0]})` : "";
        const text = `I saw them: ${str(mo.kind).replace(/_/g, " ")}${ev0}.`;
        const involved = str(mo.data?.npc);
        for (const p of m.personas) {
          if (p.id === involved) continue;
          if (zone && p.zone === zone) remember(p.id, text, "witnessed", mo.salience * 0.8, 0, str(mo.id));
        }
        if (involved && str(mo.kind) === "betrayal") remember(involved, `They betrayed me${ev0}.`, "harm", 0.95, -0.3, str(mo.id));
        return;
      }
      case "lf.directive": {
        const dir = d as { kind?: unknown; args?: { npc?: unknown; content?: unknown; rumourId?: unknown } };
        if (dir.kind === "rumour.heard" && dir.args) remember(str(dir.args.npc), `I heard: ${str(dir.args.content)}`, "rumour", 0.4, 0, str(dir.args.rumourId) || undefined);
        return;
      }
      // ---- player signals that involve an NPC
      case "movement.entered_zone": if (str(d.zone)) state.zone = str(d.zone); return;
      case "social.talked_to": { const npc = str(d.npc); if (isPersona(m, npc)) npcMem(state, npc, player, m).lastTalked = t; return; }
      case "social.gave": {
        const what = str(d.item) || (typeof d.gold === "number" ? `${d.gold} gold` : "a gift");
        const goldBoost = typeof d.gold === "number" ? Math.min(0.2, d.gold / 500) : 0;
        remember(str(d.to), `They gave me ${what}.`, "gift", 0.75, 0.12 + goldBoost);
        return;
      }
      case "world.helped": remember(str(d.npc), `They helped me${d.how ? ` (${str(d.how)})` : ""}.`, "gift", 0.75, 0.18); return;
      case "social.threatened": remember(str(d.target), "They threatened me.", "harm", 0.85, -0.25); return;
      case "social.lied": remember(str(d.to), `They lied to me${d.about ? ` about ${str(d.about)}` : ""}.`, "harm", 0.6, -0.15); return;
      case "social.said": {
        const to = str(d.to);
        if (isPersona(m, to)) npcMem(state, to, player, m).lastTalked = t;
        return;
      }
      case "combat.hit": remember(str(d.target), "They attacked me.", "harm", 0.9, -0.35); return;
      case "combat.killed": remember(str(d.target), "They struck me down.", "harm", 1, -1); return;
      case "economy.stole": if (d.seen !== false) remember(str(d.from), `They stole ${str(d.item) || "from me"}.`, "harm", 0.85, -0.3); return;
      case "economy.bought": remember(str(d.vendor), `They bought ${str(d.item) || "something"} from me for ${str(d.price)}.`, "trade", 0.3, 0.03); return;
      case "economy.sold": remember(str(d.vendor), `They sold me ${str(d.item) || "something"} for ${str(d.price)}.`, "trade", 0.3, 0.02); return;
      case "quest.accepted": remember(str(d.giver), `They agreed to help me with ${str(d.quest) || "a task"}.`, "other", 0.6, 0.06, `quest:${str(d.quest)}`); return;
      default: return;
    }
  },
};

/** Read a player's memory of one NPC (undefined when they never met). */
export function readMemory(get: (name: string, scope: { world: string; player?: string | null }) => unknown, world: string, player: string, npc: string): NpcMemory | undefined {
  try {
    return (get(MEMORIES, { world, player }) as MemoryState | undefined)?.npcs?.[npc];
  } catch {
    return undefined;
  }
}
