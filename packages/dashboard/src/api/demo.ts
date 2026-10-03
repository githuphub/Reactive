// DemoSource: an in-browser stand-in for a Liveforge server, driven by the Counterforge example manifest. It keeps an
// event log and folds it into the same projection shapes the real modules produce (player model, NPC memories,
// rumours, factions, Director, forge gallery, quests), emits directives with a `why`, and keeps cost / latency
// meters. Nothing here calls a network: it exists so the dashboard can be explored and filmed without a server.
import {
  PROTOCOL_ID, mulberry32,
  type Achievement, type BakePack, type Directive, type DirectorDecision, type DirectorState, type DirectiveLog, type EventPage,
  type FactionState, type ForgeGallery, type ForgedItem, type GalleryEntry, type MemoryEntry, type Moment, type MoveSpec,
  type PersonaMemories, type PlayerModel, type ProjectionName, type ProjectionState, type Quest, type QuestLog, type ReviewItem,
  type Rumour, type RumourState, type SimulateRequest, type StatsResponse, type StoredEvent, type ModuleStats,
} from "@liveforge/protocol";
import { parseManifest, type Manifest } from "@liveforge/manifest";
import manifestYaml from "../../../../examples/counterforge.liveforge.yaml?raw";
import { sampleBlueprint, vfxFor, SAMPLE_KINDS, type SampleKind } from "../viz/samples";
import type { BakeRequest, BakeResult, DataSource, EventQuery, GameInfo, LiveHandlers, ManifestDoc, SimulateResult, WorldSummary } from "./types";

const WORLD = "academy";
const BACKGROUND_NPCS = ["student_ada", "warden_hobb", "cook_brin", "fence_mags", "student_oli", "bellringer_tam"];
const MODULES = ["observer", "persona", "world", "director", "forge", "quests"] as const;

interface Sim {
  model: PlayerModel;
  memories: PersonaMemories;
  quests: QuestLog;
  recent: StoredEvent[];
  gold: number;
  zone: string;
  killedTypes: Set<string>;
  cooldowns: Map<string, number>;
  unlocked: Set<string>;
  bossFlags: Set<string>;
}

interface MetricAcc {
  asks: number; upgrades: number; cacheHits: number; errors: number;
  instant: number[]; upgrade: number[]; inTok: number; outTok: number; usd: number;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const title = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const handle = (p: string) => title(p.replace(/^sim_/, ""));

export class DemoSource implements DataSource {
  readonly mode = "demo" as const;
  readonly label = "Demo data";
  private readonly m: Manifest;
  private readonly rng = mulberry32(20261003);
  private seq = 0;
  private dirSeq = 0;
  private log: StoredEvent[] = [];
  private sims = new Map<string, Sim>();
  private rumours: RumourState = { rumours: [], spread: [] };
  private factions: FactionState = { reputation: {}, relationships: [] };
  private director: DirectorState = { aggression: 0.45, difficultyMode: "hidden", tension: [], bosses: {}, timeline: [] };
  private gallery: ForgeGallery = { entries: [] };
  private directiveLog: DirectiveLog = { directives: [] };
  private review: ReviewItem[] = [];
  private metrics = new Map<string, MetricAcc>();
  private tokenLog: { ts: number; tokens: number }[] = [];
  private usdToday = 0;
  private cache = { entries: 140, hits: 0, misses: 0 };
  private listeners = new Set<LiveHandlers>();
  private queue: { player: string; type: string; data: Record<string, unknown> }[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private started = Date.now();
  private tensionNow = 0.2;

  constructor() {
    const r = parseManifest(manifestYaml, { filename: "examples/counterforge.liveforge.yaml" });
    if (!r.ok) throw new Error(`demo manifest is invalid: ${r.errors.map((e) => e.message).join("; ")}`);
    this.m = r.manifest;
    for (const k of MODULES) this.metrics.set(k, { asks: 0, upgrades: 0, cacheHits: 0, errors: 0, instant: [], upgrade: [], inTok: 0, outTok: 0, usd: 0 });
    this.factions.relationships = this.m.relationships.map((x) => ({ a: x.a, b: x.b, kind: x.kind, strength: x.strength }));
    this.factions.relationships.push(
      { a: "kit", b: "fence_mags", kind: "ally", strength: 0.8 },
      { a: "pell", b: "warden_hobb", kind: "friend", strength: 0.5 },
      { a: "student_ada", b: "student_oli", kind: "friend", strength: 0.6 },
      { a: "cook_brin", b: "pell", kind: "family", strength: 0.7 },
    );
    for (const b of this.m.bosses) this.director.bosses[b.id] = { phase: 1, invented: [], attune: null };
    this.seed();
    this.timers.push(setInterval(() => this.drain(), 170));
    this.timers.push(setInterval(() => this.ambient(), 1100));
    this.timers.push(setInterval(() => this.tick(), 2200));
  }

  // ------------------------------------------------------------------------------------------ DataSource

  async game(): Promise<GameInfo> {
    const modules: Record<string, boolean> = {};
    for (const k of MODULES) modules[k] = true;
    return {
      id: this.m.game.id,
      name: this.m.game.name,
      protocol: PROTOCOL_ID,
      serverVersion: "demo",
      modules,
      personas: this.m.personas.map((p) => ({ id: p.id, name: p.name, role: p.role, faction: p.faction, zone: p.zone })),
      factions: this.m.factions.map((f) => ({ id: f.id, name: f.name })),
      bosses: this.m.bosses.map((b) => ({ id: b.id, name: b.name, phases: b.phases })),
      games: [{ id: this.m.game.id, name: this.m.game.name }],
    };
  }

  async manifest(): Promise<ManifestDoc> {
    return { manifest: this.m, yaml: manifestYaml, filename: "counterforge.liveforge.yaml" };
  }

  async worlds(): Promise<WorldSummary[]> {
    return [{
      id: WORLD,
      events: this.log.length,
      lastEventAt: this.log.at(-1)?.receivedAt ?? null,
      players: [...this.sims.entries()].map(([id, s]) => ({ id, events: s.model.eventCount, lastSeen: s.model.lastSeen ?? null })),
    }];
  }

  async events(q: EventQuery): Promise<EventPage> {
    let list = this.log;
    if (q.player) list = list.filter((e) => e.player === q.player);
    if (q.after !== undefined) list = list.filter((e) => e.seq > q.after!);
    if (q.type) {
      const t = q.type;
      list = list.filter((e) => (t.endsWith(".*") ? e.type.startsWith(t.slice(0, -1)) : e.type === t));
    }
    const limit = q.limit ?? 100;
    const page = q.after !== undefined ? list.slice(0, limit) : list.slice(-limit);
    return { events: structuredClone(page), next: null };
  }

  async projection<N extends ProjectionName>(name: N, _world: string, player?: string | null): Promise<ProjectionState<N> | null> {
    const s = player ? this.sims.get(player) : undefined;
    const out: unknown = (() => {
      switch (name) {
        case "observer.player_model": return s?.model ?? null;
        case "persona.memories": return s?.memories ?? null;
        case "quests.log": return s?.quests ?? null;
        case "world.rumours": return this.rumours;
        case "world.factions": return this.factions;
        case "director.state": return this.director;
        case "forge.gallery": return this.gallery;
        case "core.directives": return this.directiveLog;
        default: return null;
      }
    })();
    return out === null ? null : (structuredClone(out) as ProjectionState<N>);
  }

  async projectionAll<N extends ProjectionName>(name: N, world: string): Promise<{ player: string; state: ProjectionState<N> }[]> {
    const out: { player: string; state: ProjectionState<N> }[] = [];
    for (const id of this.sims.keys()) {
      const st = await this.projection(name, world, id);
      if (st) out.push({ player: id, state: st });
    }
    return out;
  }

  async stats(): Promise<StatsResponse> {
    const modules: Record<string, ModuleStats> = {};
    for (const [k, a] of this.metrics) {
      modules[k] = {
        asks: a.asks, upgrades: a.upgrades, cacheHits: a.cacheHits, errors: a.errors,
        instantMs: { p50: pct(a.instant, 50), p95: pct(a.instant, 95) },
        upgradeMs: { p50: pct(a.upgrade, 50), p95: pct(a.upgrade, 95) },
        inputTokens: a.inTok, outputTokens: a.outTok, usd: Math.round(a.usd * 10000) / 10000,
      };
    }
    const now = Date.now();
    this.tokenLog = this.tokenLog.filter((t) => now - t.ts < 60_000);
    return {
      game: this.m.game.id,
      since: this.started,
      modules,
      budgets: {
        game: {
          tokensLastMin: this.tokenLog.reduce((s, t) => s + t.tokens, 0),
          tokensPerMin: this.m.budgets.game.tokensPerMin,
          usdToday: Math.round(this.usdToday * 10000) / 10000,
          usdPerDay: this.m.budgets.game.usdPerDay,
        },
      },
      cache: { ...this.cache },
      ws: { connections: 2 + this.listeners.size },
    };
  }

  async simulate(req: SimulateRequest): Promise<SimulateResult> {
    const list = req.signals ?? [];
    for (const s of list) this.queue.push({ player: req.player, type: s.type, data: s.data ?? {} });
    return { accepted: list.length, rejected: [], lastSeq: null };
  }

  async reviewList(): Promise<ReviewItem[]> {
    return structuredClone(this.review);
  }

  async reviewSet(id: string, status: ReviewItem["status"], note?: string): Promise<ReviewItem> {
    const it = this.review.find((r) => r.id === id);
    if (!it) throw new Error(`no review item ${id}`);
    it.status = status;
    it.updatedAt = Date.now();
    if (note) it.note = note;
    const g = this.gallery.entries.find((e) => e.id === id);
    if (g) g.review = status;
    return structuredClone(it);
  }

  async bake(req: BakeRequest): Promise<BakeResult> {
    const n = Math.max(1, Math.min(24, Math.round(req.count ?? 6)));
    const family = req.kind.replace(/^forge\./, "");
    const fam = family === "creature" ? "hound" : family === "prop" ? "lantern" : family === "armour_set" ? "helm" : undefined;
    for (let i = 0; i < n; i++) {
      const prompt = req.prompts?.length ? req.prompts[i % req.prompts.length] : undefined;
      this.forge("_bake", false, { ...(prompt ? { prompt } : {}), ...(fam ? { family: fam } : {}) }, undefined, true);
    }
    return { queued: n, skipped: 0, ai: req.ai ? "running" : "off" };
  }

  async bakeExport(): Promise<BakePack> {
    const entries: BakePack["entries"] = {};
    for (const r of this.review.filter((x) => x.status === "approved")) {
      const item = r.payload as ForgedItem;
      (entries[r.kind] ??= []).push({ key: item.id, result: item, tags: item.tags });
    }
    return { protocol: "liveforge-protocol/1", game: this.m.game.id, createdAt: Date.now(), entries };
  }

  connect(_world: string, h: LiveHandlers): () => void {
    this.listeners.add(h);
    queueMicrotask(() => h.onStatus("demo"));
    for (const e of this.log.slice(-120)) h.onEvent(structuredClone(e));
    return () => this.listeners.delete(h);
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.listeners.clear();
  }

  // ------------------------------------------------------------------------------------------ simulation core

  private sim(player: string): Sim {
    let s = this.sims.get(player);
    if (!s) {
      s = {
        model: { player, traits: {}, moments: [], profile: null, stats: {}, eventCount: 0 },
        memories: { npcs: {} },
        quests: { offered: [], active: [], completed: [], failed: [], achievements: [] },
        recent: [],
        gold: 60,
        zone: "courtyard",
        killedTypes: new Set(),
        cooldowns: new Map(),
        unlocked: new Set(),
        bossFlags: new Set(),
      };
      for (const f of this.m.factions) (this.factions.reputation[f.id] ??= {})[player] = f.attitude;
      this.sims.set(player, s);
    }
    return s;
  }

  private record(type: string, data: Record<string, unknown>, player: string | null, origin: StoredEvent["origin"] = "sdk", tsOverride?: number): StoredEvent {
    const now = tsOverride ?? Date.now();
    const e: StoredEvent = { seq: ++this.seq, game: this.m.game.id, world: WORLD, player, session: player ? `${player}-s1` : null, type, data, ts: now, receivedAt: now, origin };
    this.log.push(e);
    if (this.log.length > 6000) this.log.splice(0, 1000);
    if (!tsOverride) for (const l of this.listeners) l.onEvent(structuredClone(e));
    return e;
  }

  private emit(kind: string, target: string, args: Record<string, unknown>, why: string, player: string | null, source: string, silent = false): Directive {
    const d: Directive = { id: `d${++this.dirSeq}`, kind, target, args, why: why.slice(0, 200), ts: Date.now(), world: WORLD, player, source };
    this.directiveLog.directives.push({ id: d.id, kind, target, why: d.why, ts: d.ts, player, source });
    if (this.directiveLog.directives.length > 200) this.directiveLog.directives.shift();
    this.record("lf.directive", { ...d }, player, "module", silent ? d.ts : undefined);
    if (!silent) for (const l of this.listeners) l.onDirective(structuredClone(d));
    return d;
  }

  private ask(module: string, opts: { upgrade?: boolean; cached?: boolean; tokens?: [number, number] } = {}) {
    const a = this.metrics.get(module)!;
    a.asks++;
    a.instant.push(2 + this.rng() * 9 + (this.rng() < 0.05 ? 20 : 0));
    if (opts.cached) {
      a.cacheHits++;
      this.cache.hits++;
      return;
    }
    this.cache.misses++;
    if (opts.upgrade !== false) {
      a.upgrades++;
      a.upgrade.push(module === "forge" ? 2200 + this.rng() * 2600 : module === "observer" ? 2600 + this.rng() * 1800 : 650 + this.rng() * 1500);
      const [i, o] = opts.tokens ?? [900 + Math.round(this.rng() * 700), 120 + Math.round(this.rng() * 260)];
      a.inTok += i;
      a.outTok += o;
      const usd = (i * 1 + o * 5) / 1_000_000;
      a.usd += usd;
      this.usdToday += usd;
      this.tokenLog.push({ ts: Date.now(), tokens: i + o });
      this.cache.entries++;
    }
    if (a.instant.length > 400) a.instant.splice(0, 100);
    if (a.upgrade.length > 400) a.upgrade.splice(0, 100);
    if (this.rng() < 0.01) a.errors++;
  }

  /** Feed one signal through every "module". */
  private ingest(player: string, type: string, data: Record<string, unknown>, silent = false, ts?: number) {
    const s = this.sim(player);
    const e = this.record(type, data, player, "sdk", silent ? ts ?? Date.now() : undefined);
    s.recent.push(e);
    if (s.recent.length > 140) s.recent.shift();
    s.model.eventCount++;
    s.model.lastSeen = e.ts;
    this.applyStats(s, type, data);
    this.observe(s, e, silent);
    this.persona(s, e, silent);
    this.world(s, e, silent);
    this.directorOn(s, e, silent);
    if (type === "forge.created") this.forge(player, silent, data);
  }

  private applyStats(s: Sim, type: string, d: Record<string, unknown>) {
    const st = s.model.stats;
    const inc = (k: string, n = 1) => (st[k] = (Number(st[k]) || 0) + n);
    if (type === "economy.gold") s.gold = Number(d.amount) || s.gold;
    if (type === "economy.sold") s.gold += Number(d.price) || 0;
    if (type === "economy.bought") s.gold = Math.max(0, s.gold - (Number(d.price) || 0));
    if (type === "economy.stole") s.gold += Number(d.value) || 0;
    if (type === "movement.entered_zone") s.zone = String(d.zone);
    if (type === "combat.killed") inc("kills");
    if (type === "combat.died") inc("deaths");
    if (type === "combat.dodged") inc("dodges");
    if (type === "forge.created") inc("forged");
    st.gold = s.gold;
    st.zone = s.zone;
  }

  private count(s: Sim, type: string, pred?: (d: Record<string, unknown>) => boolean): number {
    let n = 0;
    for (const e of s.recent) if (e.type === type && (!pred || pred(e.data))) n++;
    return n;
  }

  private observe(s: Sim, e: StoredEvent, silent: boolean) {
    const c = (t: string, p?: (d: Record<string, unknown>) => boolean) => this.count(s, t, p);
    const dodges = c("combat.dodged");
    const left = c("combat.dodged", (d) => d.direction === "left");
    const sold = c("economy.sold");
    const bought = c("economy.bought");
    const said = c("social.said");
    const talked = c("social.talked_to");
    const gave = c("social.gave") + c("world.helped");
    const kills = c("combat.killed");
    const civ = c("combat.killed", (d) => d.target_type === "civilian");
    const stole = c("economy.stole");
    const lied = c("social.lied");
    const explored = c("movement.explored");
    const threatened = c("social.threatened");
    const npcs = new Set(s.recent.filter((x) => x.type === "social.said").map((x) => String(x.data.to))).size;
    const forged = c("forge.created");
    const T: Record<string, [number, string]> = {
      dodger: [dodges / 16, `dodged ${dodges}x recently${dodges ? `, ${Math.round((left / dodges) * 100)}% to the left` : ""}`],
      rich: [s.gold / 1600, `${s.gold} forge-marks on hand`],
      hoarder: [(sold / 10) * (bought ? 0.4 : 1), `sold ${sold} items, bought ${bought}`],
      pacifist: [((said + talked + gave) / 18) * (kills ? 0.15 : 1), `${said + talked + gave} social actions, ${kills} kills`],
      chatterbox: [said / 14, `said ${said} things to ${npcs} NPCs`],
      beloved: [gave / 5, `gave or helped ${gave}x`],
      murderer: [civ / 6, `killed ${civ} civilians`],
      feared: [civ / 8 + threatened / 12, `${threatened} threats, ${civ} civilian kills`],
      thief: [stole / 7, `stole ${stole}x`],
      liar: [lied / 4, `caught lying ${lied}x`],
      explorer: [explored / 12, `${explored} discoveries`],
      famous: [s.model.moments.length / 6, `${s.model.moments.length} notable moments`],
      forge_happy: [forged / 5, `forged ${forged} items recently`],
    };
    for (const [name, [raw, ev]] of Object.entries(T)) {
      const target = clamp(raw);
      const prev = s.model.traits[name];
      if (!prev && target < 0.04) continue;
      const score = clamp((prev?.score ?? 0) + (target - (prev?.score ?? 0)) * 0.45);
      const evidence = prev?.evidence[0] === ev ? prev.evidence : [ev, ...(prev?.evidence ?? [])].slice(0, 5);
      s.model.traits[name] = { score: Math.round(score * 1000) / 1000, evidence, updatedAt: e.ts, designer: name === "forge_happy" ? true : undefined };
    }
    // moments
    const d = e.data;
    if (e.type === "gear.equipped" && Number(d.value) >= 800) this.moment(s, "absurd_purchase", [`equipped a ${d.value}-mark ${d.name ?? d.item}`], 0.8, silent);
    if (e.type === "combat.killed" && typeof d.target_type === "string" && !s.killedTypes.has(d.target_type)) {
      s.killedTypes.add(d.target_type);
      this.moment(s, "first_kill_of_type", [`first ${String(d.target_type).replace(/_/g, " ")} killed (${d.target})`], d.target_type === "civilian" ? 0.85 : 0.4, silent);
    }
    if (e.type === "movement.fled" && Number(d.hp) < 0.25) this.moment(s, "near_death_escape", [`fled at ${Math.round(Number(d.hp) * 100)}% hp`], 0.75, silent);
    if (e.type === "boss.phase_cleared" && d.flawless) this.moment(s, "flawless_phase", [`cleared ${d.boss} phase ${d.phase} untouched`], 0.9, silent);
    if (e.type === "economy.stole" && s.memories.npcs[String(d.from)]?.entries.some((x) => x.kind === "gift")) {
      this.moment(s, "betrayal", [`stole from ${d.from} after giving them gifts`], 0.85, silent);
    }
    if (civ === 3 && e.type === "combat.killed" && !s.bossFlags.has("massacre")) {
      s.bossFlags.add("massacre");
      this.moment(s, "courtyard_massacre", ["three civilians killed in the courtyard"], 0.95, silent);
    }
    // profile every 14 events
    if (s.model.eventCount % 14 === 0) {
      this.ask("observer", { tokens: [1800, 140] });
      s.model.profile = { text: this.profileText(s), updatedAt: e.ts, eventCount: s.model.eventCount };
    }
    this.achievements(s, silent);
  }

  private profileText(s: Sim): string {
    const top = Object.entries(s.model.traits).sort((a, b) => b[1].score - a[1].score).slice(0, 3).map(([k]) => k);
    const name = handle(s.model.player);
    const blurbs: Record<string, string> = {
      dodger: "never stands still when something swings at them, and favours rolling left",
      rich: "carries far more forge-marks than any student should",
      hoarder: "sells everything and spends nothing",
      pacifist: "would rather talk their way past a Hollow than fight it",
      chatterbox: "has an opinion for every NPC in the courtyard",
      beloved: "is the porters' favourite errand-runner",
      murderer: "has left a trail of bodies across the courtyard",
      feared: "makes the wardens step aside",
      thief: "has light fingers and a heavier purse every hour",
      liar: "tells a different story to every porter",
      explorer: "has mapped corridors the Faculty forgot existed",
      famous: "is the talk of the refectory",
      forge_happy: "cannot walk past the Great Anvil without forging something",
    };
    if (!top.length) return `${name} has only just arrived at the Academy; the Anvil is still taking their measure.`;
    const parts = top.map((t) => blurbs[t] ?? `shows strong ${t.replace(/_/g, " ")} tendencies`);
    const last = s.model.moments[0];
    return `${name} ${parts[0]}${parts[1] ? `, and ${parts[1]}` : ""}. ${parts[2] ? `They also ${parts[2]}. ` : ""}${last ? `Most recently: ${last.evidence[0] ?? last.kind.replace(/_/g, " ")}.` : ""}`.trim();
  }

  private moment(s: Sim, kind: string, evidence: string[], salience: number, silent: boolean) {
    const m: Moment = { id: `m${this.seq}_${kind}`, kind, ts: Date.now(), evidence, salience };
    s.model.moments.unshift(m);
    s.model.moments = s.model.moments.slice(0, 50);
    this.record("lf.observer.moment", { moment: m }, s.model.player, "module", silent ? m.ts : undefined);
    this.emit("moment", "ui", { moment: m }, `${kind.replace(/_/g, " ")}: ${evidence[0]}`, s.model.player, "observer", silent);
    if (salience >= 0.6) this.newRumour(s, m, silent);
    if (salience >= 0.75) this.offerQuest(s, m, silent);
  }

  private achievements(s: Sim, silent: boolean) {
    const t = (k: string) => s.model.traits[k]?.score ?? 0;
    const defs: [string, string, string, string, string, string, Achievement["rarity"]][] = [
      ["untouchable", "Untouchable", "Dodged the Forge Titan so often it started aiming left.", "trait(dodger) > 0.8", "wind", "#3987e5", "epic"],
      ["dragons_ledger", "Dragon's Ledger", "Hoarded over a thousand forge-marks and spent none.", "trait(hoarder) > 0.7 & stat(gold) > 1000", "coin", "#c98500", "rare"],
      ["silver_tongue", "Silver Tongue", "Talked to everyone in the courtyard. Twice.", "trait(chatterbox) > 0.8", "speech", "#d55181", "uncommon"],
      ["courtyard_butcher", "Courtyard Butcher", "The porters still won't say your name.", "trait(murderer) > 0.7", "skull", "#e66767", "legendary"],
      ["light_fingers", "Light Fingers", "Ten pockets, zero witnesses (mostly).", "trait(thief) > 0.7", "hand", "#9085e9", "rare"],
      ["cartographer", "Cartographer", "Found corridors the Faculty forgot.", "trait(explorer) > 0.8", "compass", "#199e70", "rare"],
      ["wordsmith", "Wordsmith", "Forge five items in five minutes.", "count(forge.created, 5m) >= 5", "anvil", "#d95926", "common"],
    ];
    const vals: Record<string, boolean> = {
      untouchable: t("dodger") > 0.8, dragons_ledger: t("hoarder") > 0.7 && s.gold > 1000, silver_tongue: t("chatterbox") > 0.8,
      courtyard_butcher: t("murderer") > 0.7, light_fingers: t("thief") > 0.7, cartographer: t("explorer") > 0.8,
      wordsmith: this.count(s, "forge.created") >= 5,
    };
    for (const [id, ttl, desc, cond, glyph, color, rarity] of defs) {
      if (!vals[id] || s.unlocked.has(id)) continue;
      s.unlocked.add(id);
      const a: Achievement = { id: `${id}_${s.model.player}`, title: ttl, description: desc, icon: { glyph, color }, condition: cond, rarity, personal: id !== "wordsmith", unlockedAt: Date.now() };
      s.quests.achievements.unshift(a);
      this.ask("quests", { tokens: [1100, 160] });
      this.emit("achievement.unlocked", "player", { achievement: a }, `${cond} became true`, s.model.player, "quests", silent);
    }
  }

  private offerQuest(s: Sim, m: Moment, silent: boolean) {
    if (s.quests.offered.length + s.quests.active.length >= 3) return;
    const templates: Record<string, Omit<Quest, "id">> = {
      absurd_purchase: { title: "A Purse Too Heavy", summary: "Pell has heard Kit is sizing up your purse. Catch her in the act before the Undercroft gets rich.", giver: "pell", objectives: [{ id: "o1", type: "talk", target: "kit", description: "Confront Kit Quickfingers in the courtyard" }, { id: "o2", type: "deliver", target: "pell", description: "Bring Pell proof of the plot" }], rewards: [{ type: "reputation", id: "porters", amount: 0.2 }, { type: "gold", amount: 120 }], dialogue: { offer: "Young master, word is someone's eyeing that circlet. Fancy catching a thief?" } },
      courtyard_massacre: { title: "Ashes in the Courtyard", summary: "The wardens want a reckoning. Archivist Marrow offers a quieter path: atone at the Old Lecture Hall.", giver: "marrow", objectives: [{ id: "o1", type: "defeat_boss", target: "hollow_professor", description: "Face the Hollow Professor" }], rewards: [{ type: "title", id: "penitent", description: "the Penitent" }], dialogue: { offer: "Blood on my steps. You will answer for it, one way or another." } },
      near_death_escape: { title: "Lessons in Retreat", summary: "Vale noticed you barely made it out. A refresher on the forge's defensive forms.", giver: "vale", objectives: [{ id: "o1", type: "forge", target: "shield", description: "Forge a shield at the Anvil" }, { id: "o2", type: "survive", target: "forge_hall", count: 60, description: "Survive a minute in the Forge Hall" }], rewards: [{ type: "item", id: "warding_charm" }] },
      first_kill_of_type: { title: "Know Your Hollows", summary: "Marrow wants a sample of every Hollow you meet, for the archive.", giver: "marrow", objectives: [{ id: "o1", type: "fetch", target: "hollow_ash", count: 3, description: "Collect three Hollow ashes" }], rewards: [{ type: "gold", amount: 80 }] },
      flawless_phase: { title: "The Titan's Attention", summary: "The Titan studies flawless students closely. Vale suggests you change your style before it adapts.", giver: "vale", objectives: [{ id: "o1", type: "defeat_boss", target: "forge_titan", description: "Defeat the Forge Titan" }], rewards: [{ type: "title", id: "unreadable", description: "the Unreadable" }] },
      betrayal: { title: "Broken Trust", summary: "Pell knows what you took. Return it, or the Lodge closes its doors.", giver: "pell", objectives: [{ id: "o1", type: "deliver", target: "pell", description: "Return what you stole" }], rewards: [{ type: "reputation", id: "porters", amount: 0.3 }] },
    };
    const t = templates[m.kind];
    if (!t) return;
    const q: Quest = { ...t, id: `q_${m.kind}_${s.model.player}`.slice(0, 64), origin: { kind: "moment", ref: m.id } };
    if (s.quests.offered.some((x) => x.id === q.id)) return;
    s.quests.offered.unshift(q);
    this.ask("quests", { tokens: [2400, 420] });
    this.emit("quest.offer", `npc:${q.giver}`, { quest: q, giver: q.giver }, `reactive quest from moment ${m.kind}: ${m.evidence[0]}`, s.model.player, "quests", silent);
    if (!silent) {
      const pl = s.model.player;
      setTimeout(() => {
        const idx = s.quests.offered.findIndex((x) => x.id === q.id);
        if (idx < 0) return;
        s.quests.offered.splice(idx, 1);
        s.quests.active.unshift({ quest: q, acceptedAt: Date.now(), progress: {} });
        this.record("quest.accepted", { quest: q.id, giver: q.giver }, pl);
      }, 6000);
    }
  }

  private memory(s: Sim, npc: string, entry: Omit<MemoryEntry, "ts">, attitudeDelta: number) {
    const mem = (s.memories.npcs[npc] ??= { npc, player: s.model.player, attitude: 0, entries: [], summary: "" });
    mem.entries.unshift({ ...entry, ts: Date.now() });
    mem.entries = mem.entries.slice(0, 24);
    mem.attitude = Math.round(clamp(mem.attitude + attitudeDelta, -1, 1) * 100) / 100;
    if (entry.kind === "conversation") mem.lastTalked = Date.now();
    const name = handle(s.model.player);
    const a = mem.attitude;
    mem.summary = a > 0.5 ? `${name} is a friend; kind, talkative and generous with small gifts.`
      : a > 0.15 ? `${name} is pleasant enough. Worth a word when they pass.`
      : a < -0.5 ? `${name} is dangerous. Keep the door shut and the wardens close.`
      : a < -0.15 ? `${name} is not to be trusted; watch your purse.`
      : `${name} is a new face. Nothing remarkable yet.`;
  }

  private persona(s: Sim, e: StoredEvent, silent: boolean) {
    const d = e.data;
    const personaIds = new Set(this.m.personas.map((p) => p.id));
    const lines: Record<string, string> = {
      "What do you know about the Veil?": "Asked what I know of the Veil. Curious one.",
      "Tell me about the Titan.": "Wanted to know about the Titan. Told them to watch its feet.",
      "I brought you something.": "Brought me something, unprompted.",
      "Any news from the lodge?": "Fishing for gossip. I gave them a little.",
      "I'd rather talk than fight.": "Said they'd rather talk than fight. Rare in this place.",
    };
    if (e.type === "social.said" && typeof d.to === "string" && personaIds.has(d.to)) {
      this.memory(s, d.to, { text: lines[String(d.text)] ?? `They said: "${String(d.text).slice(0, 80)}"`, salience: 0.45, kind: "conversation" }, 0.04);
      this.ask("persona", { cached: this.rng() < 0.25, tokens: [2100, 160] });
    }
    if (e.type === "social.talked_to" && typeof d.npc === "string" && personaIds.has(d.npc)) {
      const p = this.m.personas.find((x) => x.id === d.npc)!;
      const text = p.greeting ?? p.barks[0] ?? "Well met.";
      this.ask("persona", { cached: true });
      this.emit("npc.bark", `npc:${p.id}`, { npc: p.id, text, voice: p.voice }, `greeting on approach (attitude ${(s.memories.npcs[p.id]?.attitude ?? 0).toFixed(2)})`, s.model.player, "persona", silent);
    }
    if (e.type === "social.gave" && typeof d.to === "string" && personaIds.has(d.to)) {
      this.memory(s, d.to, { text: `Gave me ${String(d.item ?? "a gift").replace(/_/g, " ")}. Thoughtful.`, salience: 0.7, kind: "gift" }, 0.15);
    }
    if (e.type === "world.helped" && typeof d.npc === "string" && personaIds.has(d.npc)) {
      this.memory(s, d.npc, { text: `Helped me: ${d.how ?? "lent a hand"}.`, salience: 0.65, kind: "gift" }, 0.18);
    }
    if (e.type === "economy.stole" && typeof d.from === "string" && personaIds.has(d.from)) {
      this.memory(s, d.from, { text: `My ${String(d.item ?? "purse")} went missing when they were near.`, salience: 0.8, kind: "harm" }, -0.25);
    }
    if (e.type === "economy.sold" && typeof d.vendor === "string" && personaIds.has(d.vendor)) {
      if (this.rng() < 0.4) this.memory(s, d.vendor, { text: `Sold me ${String(d.item).replace(/_/g, " ")} for ${d.price}. Drives a hard bargain.`, salience: 0.3, kind: "trade" }, 0.02);
    }
    if (e.type === "combat.killed" && d.target_type === "civilian") {
      for (const p of this.m.personas.filter((x) => x.zone === s.zone)) {
        this.memory(s, p.id, { text: `Watched them cut down ${String(d.target).replace(/_\d+$/, "").replace(/_/g, " ")} in the ${s.zone}.`, salience: 0.95, kind: "witnessed" }, -0.3);
      }
    }
    if (e.type === "gear.equipped" && Number(d.value) >= 500) {
      const kit = this.m.personas.find((x) => x.id === "kit");
      if (kit && s.zone === "courtyard") {
        this.memory(s, "kit", { text: `Saw a ${d.name ?? d.item} worth a fortune on their head.`, salience: 0.85, kind: "witnessed" }, 0.05);
        this.ask("persona", { tokens: [1900, 90] });
        this.emit("npc.bark", "npc:kit", { npc: "kit", text: `Ooh, a ${String(d.name ?? "new hat")}! Heavy, is it? Must be.`, emote: "grin", voice: kit.voice }, `gear comment: equipped ${d.name ?? d.item} (${d.value} marks)`, s.model.player, "persona", silent);
      }
    }
  }

  private world(s: Sim, e: StoredEvent, silent: boolean) {
    const rep = (f: string, delta: number) => {
      const row = (this.factions.reputation[f] ??= {});
      row[s.model.player] = Math.round(clamp((row[s.model.player] ?? 0) + delta, -1, 1) * 100) / 100;
    };
    const t = e.type;
    if (t === "economy.stole") { rep("undercroft", 0.05); rep("faculty", -0.04); rep("porters", -0.03); }
    if (t === "combat.killed" && e.data.target_type === "civilian") { rep("faculty", -0.12); rep("porters", -0.1); rep("undercroft", 0.03); }
    if (t === "social.gave" || t === "world.helped") { rep("porters", 0.06); rep("faculty", 0.02); }
    if (t === "movement.explored") rep("faculty", 0.01);
    if (t === "economy.sold") rep("porters", 0.01);
    // reaction rules (manifest `reactions`), evaluated with the demo's trait scores
    const rich = s.model.traits.rich?.score ?? 0;
    const famous = s.model.traits.famous?.score ?? 0;
    const now = Date.now();
    const fire = (id: string, cooldownSec: number) => {
      if ((s.cooldowns.get(id) ?? 0) > now) return false;
      s.cooldowns.set(id, now + cooldownSec * 1000);
      return true;
    };
    if (rich > 0.6 && s.zone === "courtyard" && fire("pickpocket_rich", 600)) {
      this.ask("world", { tokens: [1500, 220] });
      this.emit("npc.action", "npc:kit", { npc: "kit", action: { action: "steal", args: { gold: 50 } }, line: "Pardon me, love - dropped something?" }, `reaction pickpocket_rich: trait(rich)=${rich.toFixed(2)} & zone=courtyard`, s.model.player, "world", silent);
    }
    if (famous > 0.7 && fire("porters_gossip_famous", 900)) {
      this.emit("npc.bark", "npc:pell", { npc: "pell", text: "Everyone's talking about you, young master!" }, `reaction porters_gossip_famous: trait(famous)=${famous.toFixed(2)}`, s.model.player, "world", silent);
    }
    const murderer = s.model.traits.murderer?.score ?? 0;
    if (murderer > 0.5 && fire("guards_keep_distance", 300)) {
      this.emit("world.reaction", "world", { rule: "feared_guards", effect: "guards keep distance, children flee", data: { zone: s.zone } }, `trait(murderer)=${murderer.toFixed(2)}: wardens hold back, students scatter`, s.model.player, "world", silent);
    }
  }

  private newRumour(s: Sim, m: Moment, silent: boolean) {
    const name = handle(s.model.player);
    const templates: Record<string, string> = {
      absurd_purchase: `${name} wears a hat worth more than the Lodge`,
      courtyard_massacre: `${name} killed three students in the courtyard`,
      first_kill_of_type: `${name} cut down a ${m.evidence[0]?.match(/first (.+?) killed/)?.[1] ?? "Hollow"} without blinking`,
      near_death_escape: `${name} crawled out of the Forge Hall on one hit point`,
      flawless_phase: `${name} danced through the Titan without a scratch`,
      betrayal: `${name} robs the very people they bring tea to`,
    };
    const content = templates[m.kind] ?? `${name}: ${m.evidence[0] ?? m.kind}`;
    const origin = this.m.personas.find((p) => p.zone === s.zone)?.id ?? "pell";
    const r: Rumour = {
      id: `r${this.rumours.rumours.length + 1}`,
      content,
      truthfulness: 1,
      heat: 0.85,
      origin: { kind: "moment", ref: m.id, npc: origin },
      about: { player: s.model.player },
      knownBy: [origin],
      createdAt: Date.now(),
      mutations: 0,
      history: [],
    };
    this.rumours.rumours.unshift(r);
    this.rumours.rumours = this.rumours.rumours.slice(0, 30);
    this.ask("world", { tokens: [1300, 120] });
    this.record("lf.world.rumour", { rumourId: r.id, content, origin }, s.model.player, "module", silent ? r.createdAt : undefined);
    this.emit("rumour.heard", `npc:${origin}`, { npc: origin, rumourId: r.id, content, heat: r.heat }, `new rumour from moment ${m.kind} (salience ${m.salience})`, null, "world", silent);
  }

  private spreadRumours(silent = false) {
    const all = [...this.m.personas.map((p) => p.id), ...BACKGROUND_NPCS];
    const zoneOf = (id: string) => this.m.personas.find((p) => p.id === id)?.zone ?? (id.startsWith("student") || id === "cook_brin" ? "courtyard" : id === "fence_mags" ? "undercroft" : "courtyard");
    for (const r of this.rumours.rumours) {
      r.heat = Math.round(Math.max(0, r.heat - 0.025) * 1000) / 1000;
      if (r.heat < 0.12 || r.knownBy.length >= all.length) continue;
      if (this.rng() > 0.55) continue;
      const from = r.knownBy[Math.floor(this.rng() * r.knownBy.length)];
      const linked = this.factions.relationships.filter((x) => x.a === from || x.b === from).map((x) => (x.a === from ? x.b : x.a));
      const near = all.filter((n) => zoneOf(n) === zoneOf(from));
      const pool = [...linked, ...linked, ...near, ...all].filter((n) => !r.knownBy.includes(n));
      if (!pool.length) continue;
      const to = pool[Math.floor(this.rng() * pool.length)];
      r.knownBy.push(to);
      r.heat = clamp(r.heat + 0.06);
      this.rumours.spread.push({ rumourId: r.id, from, to, ts: Date.now() });
      if (this.rumours.spread.length > 400) this.rumours.spread.shift();
      if (this.rng() < 0.3) {
        r.history = [r.content, ...(r.history ?? [])].slice(0, 6);
        r.content = this.mutate(r.content);
        r.mutations++;
        r.truthfulness = Math.round(Math.max(0, r.truthfulness - 0.12) * 100) / 100;
      }
      const pl = r.about?.player;
      if (pl && this.m.personas.some((p) => p.id === to)) {
        const s = this.sims.get(pl);
        if (s) this.memory(s, to, { text: `Heard from ${from.replace(/_/g, " ")}: "${r.content}"`, salience: 0.5 * r.truthfulness + 0.3, kind: "rumour" }, r.content.match(/kill|rob|stole/) ? -0.08 : 0.03);
      }
      if (!silent && this.m.personas.some((p) => p.id === to)) {
        this.emit("rumour.heard", `npc:${to}`, { npc: to, rumourId: r.id, content: r.content, heat: r.heat }, `spread ${from} -> ${to} (${linked.includes(to) ? "relationship" : "proximity"})`, null, "world");
      }
    }
  }

  private mutate(c: string): string {
    const swaps: [RegExp, string][] = [
      [/three/, "five"], [/five/, "a dozen"], [/a hat/, "a crown"], [/one hit point/, "no hit points at all"],
      [/more than the Lodge/, "more than the whole Academy"], [/without a scratch/, "with their eyes closed"], [/a dozen/, "half the Academy"],
      [/cut down/, "tore apart"], [/robs/, "fleeces"], [/students/, "students and a warden"],
    ];
    for (const [re, to] of swaps) if (re.test(c)) return c.replace(re, to);
    return c.endsWith("!") ? c : `${c}, they say`;
  }

  private decision(kind: string, summary: string, why: string, source: DirectorDecision["source"], data?: Record<string, unknown>) {
    this.director.timeline.push({ ts: Date.now(), kind, summary: summary.slice(0, 200), why: why.slice(0, 300), source, data });
    if (this.director.timeline.length > 200) this.director.timeline.shift();
  }

  private directorOn(s: Sim, e: StoredEvent, silent: boolean) {
    const t = e.type;
    if (t.startsWith("combat.")) this.tensionNow = clamp(this.tensionNow + (t === "combat.hurt" ? 0.07 : t === "combat.killed" ? 0.05 : 0.025));
    const dodger = s.model.traits.dodger?.score ?? 0;
    const titan = this.director.bosses.forge_titan;
    if (titan && dodger > 0.55 && !s.bossFlags.has("titan_counter")) {
      s.bossFlags.add("titan_counter");
      const dodges = this.count(s, "combat.dodged");
      const left = this.count(s, "combat.dodged", (d) => d.direction === "left");
      const move: MoveSpec = {
        name: "Leftward Reckoning", taunt: "You always roll left, little smith. So does my hammer.", shape: "beam", element: "fire",
        pattern: "fan", count: 3, telegraph: 0.9, speed: 1.3, size: 1.2, damage_budget: 16, status: "burning", bias: "left",
        engine: { moveId: "sweep", params: { arc: 200 } },
      };
      // Two stages, like the real Director: a rules move now, the AI move replaces it a moment later.
      const rulesMove: MoveSpec = { ...move, name: "Sweeping Correction", taunt: "Stand still, student.", pattern: "line", count: 2, bias: "left", status: "none", damage_budget: 14 };
      const pct = Math.round((left / Math.max(1, dodges)) * 100);
      const rulesWhy = `${s.model.player} dodges ${pct}% left (${dodges} dodges): rules counter, line sweep`;
      titan.invented = [rulesMove, ...titan.invented].slice(0, 3);
      titan.attune = "fire";
      this.ask("director", { tokens: [2600, 380] });
      this.decision("boss_move", "Forge Titan learns Sweeping Correction", rulesWhy, "rules", { boss: "forge_titan", move: rulesMove.name });
      this.emit("boss.move_added", "boss:forge_titan", { boss: "forge_titan", move: rulesMove, engineMove: rulesMove.engine }, rulesWhy, s.model.player, "director", silent);
      const why = `${s.model.player} dodges left ${pct}% of the time (${dodges} dodges): fan sweep biased left`;
      const upgrade = () => {
        titan.invented = [move, ...titan.invented.filter((m) => m.name !== rulesMove.name)].slice(0, 3);
        this.decision("boss_move", "Forge Titan learns Leftward Reckoning (left-biased fire sweep)", why, "ai", { boss: "forge_titan", move: move.name });
        this.emit("boss.move_added", "boss:forge_titan", { boss: "forge_titan", move, engineMove: move.engine }, why, s.model.player, "director", silent);
      };
      if (silent) upgrade();
      else setTimeout(upgrade, 2600);
      this.emit("boss.adapt", "boss:forge_titan", { boss: "forge_titan", aggression: this.director.aggression, attune: "fire", taunt: move.taunt }, "attune to fire to punish the left roll", s.model.player, "director", silent);
      this.setAggression(this.director.aggression + 0.12, `${s.model.player} is evading comfortably (dodger ${dodger.toFixed(2)}): raise pressure`, silent, s.model.player);
    }
    const murderer = s.model.traits.murderer?.score ?? 0;
    if (murderer > 0.45 && !s.bossFlags.has("wardens")) {
      s.bossFlags.add("wardens");
      const why = `${s.model.player} killed civilians in the ${s.zone}: send wardens (within maxWaveSize ${this.m.clamps.pacing.maxWaveSize})`;
      this.ask("director", { tokens: [1700, 260] });
      this.decision("encounter", "Warden squad dispatched to the courtyard (shield-wall)", why, "rules", { units: 4 });
      this.emit("spawn.wave", "spawner:courtyard_gate", { zone: s.zone, units: [{ type: "warden", count: 4, tactic: "shield-wall" }, { type: "warden_captain", count: 1, elite: true, modifiers: ["rallying"], tactic: "focus-healer" }] }, why, s.model.player, "director", silent);
    }
    if (t === "boss.phase_cleared" && titan) {
      titan.phase = Math.min(3, (Number(e.data.phase) || titan.phase) + 1);
      this.decision("boss_phase", `Forge Titan enters phase ${titan.phase}`, `phase ${e.data.phase} cleared by ${s.model.player}; counters: ${titan.invented.map((m) => m.name).join(", ") || "none yet"}`, "rules");
    }
    const pacifist = s.model.traits.pacifist?.score ?? 0;
    if (pacifist > 0.6 && !s.bossFlags.has("pacifist_pacing")) {
      s.bossFlags.add("pacifist_pacing");
      const why = `${s.model.player} avoids combat (pacifist ${pacifist.toFixed(2)}): fewer spawns, more talk`;
      this.decision("difficulty", "Ease combat pressure; offer dialogue routes", why, "ai");
      this.setAggression(this.director.aggression - 0.12, why, silent, s.model.player);
    }
  }

  private setAggression(v: number, why: string, silent: boolean, player: string | null) {
    const c = this.m.clamps.difficulty;
    const prev = this.director.aggression;
    const step = Math.max(-c.maxStep, Math.min(c.maxStep, v - prev));
    const next = Math.round(clamp(prev + step, c.aggressionMin, c.aggressionMax) * 100) / 100;
    if (next === prev) return;
    this.director.aggression = next;
    this.decision("difficulty", `Aggression ${prev.toFixed(2)} -> ${next.toFixed(2)}`, why, "rules", { from: prev, to: next });
    this.emit("difficulty.set", "world", { aggression: next, mode: this.director.difficultyMode, reason: why.slice(0, 200) }, why, player, "director", silent);
  }

  private forge(player: string, silent: boolean, data: Record<string, unknown> = {}, ts?: number, bake = false) {
    const kind = (typeof data.family === "string" && (SAMPLE_KINDS as string[]).includes(data.family) ? data.family : SAMPLE_KINDS[Math.floor(this.rng() * SAMPLE_KINDS.length)]) as SampleKind;
    const elements = ["fire", "ice", "lightning", "veil", "physical"];
    const element = elements[Math.floor(this.rng() * elements.length)];
    const adjectives: Record<string, string[]> = { fire: ["Ember", "Cinder", "Kiln"], ice: ["Rime", "Frostbit", "Glacier"], lightning: ["Storm", "Arc", "Thunder"], veil: ["Veilborn", "Hollow", "Whisper"], physical: ["Iron", "Anvil", "Plain"] };
    const nouns: Record<SampleKind, string> = { sword: "Blade", axe: "Cleaver", staff: "Stave", hammer: "Maul", shield: "Ward", helm: "Crown", hound: "Hound", lantern: "Lantern", spear: "Lance" };
    const adj = adjectives[element][Math.floor(this.rng() * 3)];
    const name = `${adj} ${nouns[kind]}`;
    const creature = kind === "hound";
    const prop = kind === "lantern";
    const askKind = creature ? "forge.creature" : prop ? "forge.prop" : kind === "helm" ? "forge.armour_set" : typeof data.prompt === "string" ? "forge.item" : "forge.loot";
    const bp = sampleBlueprint(kind, element === "veil" ? "veil" : element, name);
    const stats = creature ? { hp: 40 + Math.round(this.rng() * 60), damage: 6 + Math.round(this.rng() * 10), speed: 30 + Math.round(this.rng() * 50) }
      : { damage: 10 + Math.round(this.rng() * 70), speed: 10 + Math.round(this.rng() * 70), range: 5 + Math.round(this.rng() * 60), special: Math.round(this.rng() * 40) };
    const rarity = ["common", "uncommon", "rare", "epic", "legendary"][Math.min(4, Math.floor(this.rng() * this.rng() * 5 + 0.5))];
    const item = {
      id: `f${this.gallery.entries.length + 1}_${kind}`,
      name,
      flavor: typeof data.prompt === "string" ? `Forged from the words: "${data.prompt}".` : `Context loot themed on the last fight in the ${this.sims.get(player)?.zone ?? "forge hall"}.`,
      family: kind,
      rarity,
      element,
      stats,
      tags: [element, ...(this.rng() < 0.5 ? ["Swift"] : ["Heavy"])],
      blueprint: bp,
      vfx: vfxFor(element === "physical" ? "fire" : element),
      creativity: Math.round(this.rng() * 80) / 100,
      ...(creature ? { role: "minion", behaviour: "charge" } : {}),
    };
    const source: GalleryEntry["source"] = bake ? "bake" : this.rng() < 0.65 ? "ai" : this.rng() < 0.5 ? "cache" : "rules";
    const pending = bake || this.rng() < 0.35;
    const key = typeof data.prompt === "string" ? data.prompt : undefined;
    const entry = { id: item.id, askKind, ts: ts ?? Date.now(), player: bake ? null : player, source, result: item, review: pending ? "pending" : "none", ...(key ? { key } : {}) } as GalleryEntry;
    this.gallery.entries.unshift(entry);
    this.gallery.entries = this.gallery.entries.slice(0, 60);
    if (pending) this.review.unshift({ id: item.id, kind: askKind, status: "pending", payload: item, createdAt: entry.ts, updatedAt: entry.ts });
    this.ask("forge", { cached: source === "cache", upgrade: source !== "rules", tokens: [3200, 900] });
    if (!silent && !bake) this.emit("forge.ready", "player", { jobId: `job_${item.id}`, state: "done", item: creature || prop ? undefined : item, blueprint: bp }, `${askKind} upgrade ready (${source})`, player, "forge");
  }

  // ------------------------------------------------------------------------------------------ clocks

  private drain() {
    const n = Math.min(this.queue.length, 2);
    for (let i = 0; i < n; i++) {
      const q = this.queue.shift()!;
      this.ingest(q.player, q.type, q.data);
    }
  }

  private ambientStep = 0;
  private ambient() {
    if (this.queue.length > 30) return;
    const r = this.rng;
    const step = this.ambientStep++;
    const who = step % 3 === 2 ? "ash" : "ember";
    const choices: [number, () => void][] = [
      [3, () => this.ingest(who, "combat.hit", { target: "hollow", target_type: "hollow", damage: 8 + Math.round(r() * 14), weapon: "sword", element: "fire" })],
      [2, () => this.ingest(who, "combat.dodged", { source: "forge_titan", attack: "slam", direction: r() < 0.5 ? "left" : "right" })],
      [2, () => this.ingest(who, "combat.hurt", { source: "slag_imp", damage: 6, hp: Math.round((0.3 + r() * 0.6) * 100) / 100 })],
      [1, () => this.ingest(who, "combat.killed", { target: `hollow_${step}`, target_type: ["hollow", "slag_imp", "chalk_wraith", "ash_hound"][Math.floor(r() * 4)] })],
      [1, () => this.ingest(who, "forge.created", { prompt: ["a sword that remembers its last swing", "a lantern for the lecture hall", "a hound made of slag", "a frost spear"][Math.floor(r() * 4)], family: ["sword", "lantern", "hound", "spear"][Math.floor(r() * 4)] })],
      [2, () => this.ingest(who, "social.said", { text: ["Morning, Pell.", "What's new at the lodge?", "Seen the Titan today?"][Math.floor(r() * 3)], to: ["pell", "vale", "marrow"][Math.floor(r() * 3)] })],
      [1, () => this.ingest(who, "movement.entered_zone", { zone: ["courtyard", "forge_hall", "library"][Math.floor(r() * 3)] })],
      [1, () => this.ingest(who, "economy.bought", { item: "tonic", price: 12, vendor: "pell" })],
    ];
    const total = choices.reduce((s, c) => s + c[0], 0);
    let x = r() * total;
    for (const [w, fn] of choices) {
      x -= w;
      if (x <= 0) {
        fn();
        break;
      }
    }
  }

  private tick() {
    this.tensionNow = clamp(this.tensionNow * 0.86 + (this.queue.length ? 0.05 : 0) + this.rng() * 0.04);
    const v = Math.round(this.tensionNow * 1000) / 1000;
    this.director.tension.push({ ts: Date.now(), value: v });
    if (this.director.tension.length > 200) this.director.tension.shift();
    const recent = this.director.tension.slice(-4);
    if (recent.length === 4 && recent.every((x) => x.value > 0.62) && !this.director.timeline.slice(-3).some((d) => d.kind === "pacing")) {
      const sec = this.m.clamps.pacing.breatherSec;
      const why = `tension above 0.62 for ${recent.length} samples: breather within ${sec[0]}-${sec[1]}s`;
      this.decision("pacing", "Breather: pause spawns 15s, drop a loot cache", why, "rules");
      this.emit("pacing.breather", "world", { seconds: 15, loot: true }, why, null, "director");
    }
    this.spreadRumours();
    for (const s of this.sims.values()) for (const mem of Object.values(s.memories.npcs)) for (const en of mem.entries) en.salience = Math.round(Math.max(0.05, en.salience * 0.995) * 1000) / 1000;
  }

  // ------------------------------------------------------------------------------------------ seed history

  /** Pre-populate ~10 minutes of history so every panel has something to show on first load. */
  private seed() {
    const t0 = Date.now() - 10 * 60_000;
    let t = t0;
    const at = () => (t += 1500 + Math.floor(this.rng() * 2000));
    const hist: [string, string, Record<string, unknown>][] = [
      ["ember", "movement.entered_zone", { zone: "courtyard", kind: "hub" }],
      ["ember", "social.talked_to", { npc: "vale" }],
      ["ember", "social.said", { text: "What do you know about the Veil?", to: "vale" }],
      ["ember", "forge.created", { prompt: "a sword that hums when Hollows are near", family: "sword" }],
      ["ember", "movement.entered_zone", { zone: "forge_hall", kind: "arena" }],
      ["ember", "combat.hit", { target: "hollow_1", target_type: "hollow", damage: 14, weapon: "sword" }],
      ["ember", "combat.killed", { target: "hollow_1", target_type: "hollow" }],
      ["ember", "combat.hurt", { source: "slag_imp", damage: 22, hp: 0.12 }],
      ["ember", "movement.fled", { from: "slag_imp", hp: 0.12 }],
      ["ash", "movement.entered_zone", { zone: "library" }],
      ["ash", "social.said", { text: "Tell me about the Titan.", to: "marrow" }],
      ["ash", "social.gave", { to: "marrow", item: "returned_book" }],
      ["ash", "movement.explored", { discovery: "professor_notes", zone: "library" }],
      ["ash", "forge.created", { prompt: "a staff that stores lecture notes as lightning", family: "staff" }],
      ["ember", "forge.created", { prompt: "an axe of cooled slag", family: "axe" }],
      ["ember", "combat.dodged", { source: "forge_titan", attack: "slam", direction: "left" }],
      ["ember", "combat.dodged", { source: "forge_titan", attack: "barrage", direction: "left" }],
      ["ember", "boss.phase_cleared", { boss: "forge_titan", phase: 1, flawless: true }],
      ["ash", "forge.created", { prompt: "a lantern that burns Veil-light", family: "lantern" }],
      ["ember", "forge.created", { prompt: "a hound made of slag and spite", family: "hound" }],
      ["ash", "forge.created", { prompt: "a horned helm for the cold library", family: "helm" }],
      ["ember", "forge.created", { prompt: "a hammer for breaking promises", family: "hammer" }],
      ["ash", "forge.created", { prompt: "a shield etched with the Academy crest", family: "shield" }],
    ];
    for (const [p, type, data] of hist) {
      const ts = at();
      this.ingest(p, type, data, true, ts);
      for (let i = 0; i < 3; i++) this.director.tension.push({ ts: ts - i * 400, value: Math.round(clamp(0.25 + Math.sin(ts / 40_000) * 0.2 + this.rng() * 0.2) * 1000) / 1000 });
    }
    this.director.tension.sort((a, b) => a.ts - b.ts);
    this.decision("encounter", "Opening wave: 3 Hollows (flank) in the Forge Hall", "warm-up encounter at aggression 0.45; ember's first fight", "rules");
    this.decision("pacing", "Breather after ember's near-death escape", "hp 12% then fled: 20 s breather and a tonic drop", "rules");
    this.rumours.rumours.push({
      id: "r0", content: "The Forge Titan was once a student who forged too well", truthfulness: 0.9, heat: 0.4,
      origin: { kind: "designer", npc: "vale" }, knownBy: ["vale", "marrow", "student_ada"], createdAt: t0, mutations: 0, history: [],
    });
    this.rumours.spread.push({ rumourId: "r0", from: "vale", to: "marrow", ts: t0 + 1000 }, { rumourId: "r0", from: "marrow", to: "student_ada", ts: t0 + 5000 });
    for (let i = 0; i < 4; i++) this.spreadRumours(true);
    for (const m of this.metrics.values()) {
      for (let i = 0; i < 30; i++) m.instant.push(2 + this.rng() * 8);
    }
  }
}
