// Demo data for the K7 panels (Agents, Builds, Brain, village mind, cassette badge): a scripted Livecraft loop -
// Bram builds a cosy house with a tower, Oakhollow's mind turns wary after griefing and calms down again, and a
// night raid counters a pillaring archer. Pure in-browser; DemoSource delegates to it.
import { mulberry32, type FactionMind, type FactionMindState } from "@liveforge/protocol";
import type { AgentRun, AgentStep, BrainEntry, BuildEntry, CassetteInfo, CassetteMode, VoxelPlanLike } from "./brain";

const HOUSE: VoxelPlanLike = {
  name: "Cosy tower house",
  palette: { wall: "oak_planks", trim: "spruce_log", roof: "bricks", glass: "glass" },
  ops: [
    { op: "box", from: [0, 0, 0], to: [6, 0, 5], block: "cobblestone" },
    { op: "hollow_box", from: [0, 1, 0], to: [6, 4, 5], block: "wall" },
    { op: "edges", from: [0, 1, 0], to: [6, 4, 5], block: "trim" },
    { op: "roof", style: "gable", from: [-1, 5, -1], to: [7, 5, 6], block: "roof" },
    { op: "cylinder", center: [9, 0, 2], radius: 2, height: 8, hollow: true, block: "stone_bricks" },
    { op: "door", at: [3, 1, 0], facing: "south" },
    { op: "repeat", count: 3, step: [2, 0, 0], ops: [{ op: "window", at: [1, 2, 0], block: "glass" }] },
  ],
};
const STATUE: VoxelPlanLike = {
  name: "Statue of the Mender",
  palette: { body: "wool_blue", skin: "sandstone", base: "stone_bricks", hair: "wool_yellow" },
  ops: [
    { op: "box", from: [0, 0, 0], to: [4, 0, 2], block: "base" },
    { op: "box", from: [1, 1, 1], to: [1, 3, 1], block: "body" },
    { op: "box", from: [3, 1, 1], to: [3, 3, 1], block: "body" },
    { op: "box", from: [1, 4, 1], to: [3, 7, 1], block: "body" },
    { op: "box", from: [0, 5, 1], to: [0, 7, 1], block: "skin" },
    { op: "box", from: [4, 5, 1], to: [4, 7, 1], block: "skin" },
    { op: "box", from: [1, 8, 0], to: [3, 10, 2], block: "skin" },
    { op: "box", from: [1, 11, 0], to: [3, 11, 2], block: "hair" },
  ],
};

interface ScriptStep { kind: AgentStep["kind"]; text?: string; tool?: string; input?: unknown; output?: unknown; model: string; ms: number }

const BRAM_SCRIPT: ScriptStep[] = [
  { kind: "thought", text: "A cosy house with a tower. I'll plan it first, then check what I have.", model: "sonnet", ms: 1180 },
  { kind: "tool_call", tool: "build", input: { prompt: "cosy house with a tower", site: { size: [12, 10, 8] } }, model: "sonnet", ms: 940 },
  { kind: "tool_result", tool: "build", output: { ok: true, blocks: 214, materials: { oak_planks: 88, spruce_log: 36, bricks: 63, stone_bricks: 58, glass: 3 } }, model: "rules", ms: 12 },
  { kind: "thought", text: "Short on bricks. The quarry by the river has clay.", model: "sonnet", ms: 820 },
  { kind: "tool_call", tool: "walk_to", input: { target: "river_quarry" }, model: "sonnet", ms: 610 },
  { kind: "tool_result", tool: "walk_to", output: { ok: true, arrived: [42, 63, -17] }, model: "rules", ms: 4100 },
  { kind: "tool_call", tool: "gather", input: { block: "clay", count: 20 }, model: "sonnet", ms: 530 },
  { kind: "tool_result", tool: "gather", output: { ok: true, got: { clay: 20 } }, model: "rules", ms: 6200 },
  { kind: "tool_call", tool: "say", input: { text: "Right then. Bottom up, as my father taught me." }, model: "sonnet", ms: 480 },
  { kind: "tool_result", tool: "say", output: { ok: true }, model: "rules", ms: 5 },
  { kind: "tool_call", tool: "place", input: { plan: "Cosy tower house", from: 0, to: 214, rate: 6 }, model: "sonnet", ms: 560 },
  { kind: "tool_result", tool: "place", output: { ok: true, placed: 214, seconds: 36 }, model: "rules", ms: 36000 },
  { kind: "thought", text: "Done. Proud of that tower.", model: "sonnet", ms: 390 },
];

export class LivecraftMock {
  readonly runs: AgentRun[] = [];
  readonly builds: BuildEntry[] = [];
  readonly history: BrainEntry[] = [];
  mind: FactionMind;
  cassette: CassetteInfo = { mode: "replay", count: 42, liveAvailable: false, stats: { hits: 0, looseHits: 0, fuzzyHits: 0, misses: 0, recorded: 0 } };
  private rng = mulberry32(7);
  private n = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private step = 0;
  private phase = 0;

  constructor(private readonly push: (b: BrainEntry) => void) {
    const now = Date.now();
    this.mind = {
      faction: "oakhollow", posture: "calm", priceMult: 1, trust: { ember: 0.15, ash: 0.42 },
      damage: { count: 0, value: 0, recent: [] }, threats: [], guards: [{ npc: "captain_rowan", post: "square" }, { npc: "iron_golem", post: "gate" }],
      mood: 0.1, moodTs: now, rumours: { count: 0, sentiment: 0 }, seen: { ember: now, ash: now }, phase: "day", day: 2,
      postureSince: now - 10 * 60_000, history: [], raids: [],
    };
    // a finished build from earlier
    this.builds.push({ id: "b0", ts: now - 8 * 60_000, player: "ash", npc: "bram", prompt: "a statue of the hero who mended Mara's house", summary: "statue 5x12x3 in the player's outfit colours", source: "ai", model: "sonnet", plan: STATUE });
    this.raid(now - 6 * 60_000, 1, false);
  }

  start(): void {
    this.newRun();
    this.timers.push(setInterval(() => this.tickAgent(), 1700));
    this.timers.push(setInterval(() => this.tickVillage(), 9000));
    this.cassette.stats!.hits = 3;
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  setMode(mode: CassetteMode): CassetteInfo {
    this.cassette = { ...this.cassette, mode, liveAvailable: false };
    return this.cassette;
  }

  private entry(e: Omit<BrainEntry, "id" | "ts">, ts = Date.now()): BrainEntry {
    const b: BrainEntry = { id: `demo-k7-${++this.n}`, ts, ...e };
    this.history.push(b);
    if (this.history.length > 300) this.history.shift();
    this.push(b);
    return b;
  }

  private newRun(): void {
    const run: AgentRun = { runId: `run_${this.runs.length + 1}`, npc: "bram", goal: "build me a cosy house with a tower", state: "running", startedAt: Date.now(), updatedAt: Date.now(), plan: ["plan the build", "gather missing bricks", "place blocks bottom-up", "tell the player"], steps: [] };
    this.runs.unshift(run);
    if (this.runs.length > 6) this.runs.pop();
    this.step = 0;
    this.entry({ source: "agents", actor: "bram", kind: "goal", text: run.goal, data: { runId: run.runId, npc: "bram", goal: run.goal, state: "running" }, model: "sonnet" });
  }

  private tickAgent(): void {
    const run = this.runs[0];
    if (!run) return;
    if (this.step >= BRAM_SCRIPT.length) {
      if (run.state === "running") {
        run.state = "done";
        run.summary = "Built the cosy tower house (214 blocks) and showed it off.";
        this.entry({ source: "agents", actor: "bram", kind: "goal", text: `done: ${run.goal}`, data: { runId: run.runId, npc: "bram", goal: run.goal, state: "done" }, model: "sonnet" });
      } else if (this.rng() < 0.25) this.newRun();
      return;
    }
    const s = BRAM_SCRIPT[this.step++];
    const model = this.cassette.mode === "replay" && s.model !== "rules" ? "replay" : s.model;
    const st: AgentStep = { i: run.steps.length, kind: s.kind, tool: s.tool, input: s.input, output: s.output, text: s.text, model, ms: s.ms, ts: Date.now() };
    run.steps.push(st);
    run.updatedAt = Date.now();
    const text = s.text ?? `${s.tool}(${JSON.stringify(s.input ?? s.output ?? {}).slice(0, 100)})`;
    this.entry({ source: "agents", actor: "bram", kind: s.kind ?? "thought", text, data: { runId: run.runId, npc: "bram", ...st }, model, ms: s.ms });
    if (s.tool === "build" && s.kind === "tool_call") {
      const b: BuildEntry = { id: `b${this.builds.length}`, ts: Date.now(), player: "ember", npc: "bram", prompt: "cosy house with a tower", summary: "house 7x6 with a gable brick roof, round stone-brick tower, 3 windows", source: model === "replay" ? "replay" : "ai", model, plan: HOUSE };
      this.builds.unshift(b);
      if (this.builds.length > 8) this.builds.pop();
      this.entry({ source: "builder", actor: "bram", kind: "plan", text: b.summary, data: { npc: "bram", prompt: b.prompt, plan: HOUSE, summary: b.summary, source: b.source }, model, ms: 2380 });
    }
  }

  private tickVillage(): void {
    const now = Date.now();
    const m = this.mind;
    this.phase = (this.phase + 1) % 6;
    if (this.phase === 1) {
      // griefing at Mara's house
      for (let i = 0; i < 3; i++) m.damage.recent.push({ ts: now - i * 800, player: "ember", object: ["oak_planks", "glass", "oak_door"][i], owner: "mara", value: 2 + i });
      m.damage.recent = m.damage.recent.slice(-12);
      m.damage.count += 3;
      m.damage.value += 9;
      m.trust.ember = Math.round((m.trust.ember - 0.35) * 100) / 100;
      m.mood = -0.32;
      this.decide("wary", 1.4, [{ npc: "captain_rowan", post: "gate" }, { npc: "iron_golem", post: "home:mara" }], "Doors are bolted in Oakhollow. Someone keeps breaking Mara's house, so prices rise.", `Wary: 3 things broken at Mara's in 10 min; trust ${m.trust.ember.toFixed(2)} (ember) → prices x1.4`);
    } else if (this.phase === 3) {
      m.phase = "dusk";
      this.raid(now, (m.day ?? 2), true);
    } else if (this.phase === 5) {
      m.trust.ember = Math.min(0.5, Math.round((m.trust.ember + 0.4) * 100) / 100);
      m.mood = 0.48;
      m.phase = "day";
      m.day = (m.day ?? 2) + 1;
      this.decide("calm", 0.95, [{ npc: "captain_rowan", post: "square" }, { npc: "iron_golem", post: "gate" }], "Oakhollow breathes easy again. Fair prices today.", `Calm: Mara's house repaired with Bram; trust ${m.trust.ember.toFixed(2)} (ember) → prices x0.95`);
    }
  }

  private decide(posture: FactionMind["posture"], priceMult: number, guards: FactionMind["guards"], announcement: string, why: string): void {
    const m = this.mind;
    const now = Date.now();
    const model = this.cassette.mode === "replay" ? "replay" : "rules";
    if (m.posture !== posture) m.postureSince = now;
    m.posture = posture;
    m.priceMult = priceMult;
    m.guards = guards;
    m.lastPlan = { ts: now, kind: "council", summary: `Oakhollow: ${posture}, prices x${priceMult}`, why, source: "rules", posture, priceMult, announcement };
    m.history.push({ ts: now, posture, priceMult, why, source: "rules" });
    this.entry({ source: "factions", actor: "oakhollow", kind: "decision", text: `Oakhollow → ${posture} (prices x${priceMult}). ${announcement}`, data: { faction: "oakhollow", posture, priceMult, guards, why }, model: "rules", ms: 1 });
    setTimeout(() => {
      const council = posture === "wary" ? "Shutters down, guards to the gate. Mind your hands near Mara's house." : "Welcome back, friend. The market is open.";
      m.lastPlan = { ...m.lastPlan!, ts: Date.now(), source: model === "replay" ? "replay" : "ai", model: model === "replay" ? "replay:claude-haiku-4-5" : "claude-haiku-4-5", announcement: council, why: `council: ${why.split(":")[1]?.trim() ?? why}` };
      m.history.push({ ts: Date.now(), posture, priceMult, why: m.lastPlan.why, source: m.lastPlan.source });
      this.entry({ source: "factions", actor: "oakhollow", kind: "decision", text: `Council: ${council}`, data: { faction: "oakhollow", posture, priceMult, guards }, model: model === "replay" ? "replay" : "haiku", ms: model === "replay" ? 302 : 840 });
    }, 1200);
  }

  private raid(ts: number, night: number, live: boolean): void {
    const habits = [
      { habit: "pillaring", score: 0.86, evidence: "pillared 5x (up to 9 high)" },
      { habit: "bow_heavy", score: 0.64, evidence: "23 bow shots" },
    ];
    const raid = {
      ts, player: "ember", night, size: "medium" as const,
      waves: [
        { mob: "spider", count: 4, tactic: "climb", spawn: "edge" as const },
        { mob: "skeleton", count: 3, tactic: "crossfire", spawn: "rooftops" as const },
        { mob: "zombie", count: 3, tactic: "shield_rush", spawn: "edge" as const },
      ],
      counters: [
        { habit: "pillaring", tactic: "climbing spiders + skeleton crossfire", why: "pillared 5x: spiders climb pillars; skeletons shoot from two sides" },
        { habit: "bow_heavy", tactic: "shielded zombies + rush", why: "23 bow shots: shields soak arrows and a rush closes the range" },
      ],
      captain: { name: "Lady Webweaver", taunt: "Build your pillar as high as you like, ember. My spiders climb." },
      why: "ember: pillaring (pillared 5x) + bow heavy (23 bow shots) → climbing spiders + crossfire; shielded rush; aggression 0.62, night " + night,
      source: live && this.cassette.mode === "replay" ? "replay" : "ai",
    };
    this.mind.raids.push(raid);
    this.mind.raids = this.mind.raids.slice(-10);
    if (!live) return;
    this.mind.lastPlan = { ts, kind: "raid", summary: "raid: 3 wave(s), 10 mobs (4 spider, 3 skeleton, 3 zombie)", why: raid.why, source: raid.source };
    this.entry({ source: "factions", actor: "oakhollow", kind: "thought", text: `Threat model for ember: ${habits.map((h) => `${h.habit} ${h.score} (${h.evidence})`).join("; ")}`, data: { habits }, model: "rules", ms: 3 });
    this.entry({ source: "factions", actor: "oakhollow", kind: "plan", text: `raid night ${night}: 4 spider (climb, edge), 3 skeleton (crossfire, rooftops), 3 zombie (shield_rush, edge) · Lady Webweaver: "${raid.captain.taunt}"`, data: { plan: raid }, model: raid.source === "replay" ? "replay" : "haiku", ms: raid.source === "replay" ? 298 : 910 });
    this.entry({ source: "factions", actor: "oakhollow", kind: "decision", text: `why: ${raid.why}`, data: { counters: raid.counters }, model: raid.source === "replay" ? "replay" : "haiku" });
  }

  state(): FactionMindState {
    return { factions: { oakhollow: structuredClone(this.mind) } };
  }
}
