// Brain feed + view models for the K7 panels (Agents, Builds, Brain, cassette badge). Brain entries are the protocol
// BrainEntry (K6): pushed over WS {t:"brain"} and kept in the server ring (GET /v1/brain). Agent runs and builds are
// read tolerantly (normaliseRuns / buildFromEvent) so the panels render whatever the server version sends.
import type { BrainEntry, StoredEvent, VoxelPlan } from "@liveforge/protocol";

export { BRAIN_SOURCES, type BrainEntry, type BrainModel } from "@liveforge/protocol";

/** One step of an agent run (agents.runs projection, lf.agents.step). */
export interface AgentStep {
  i?: number;
  kind?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  ok?: boolean;
  text?: string;
  model?: string;
  ms?: number;
  ts?: number;
}

export interface AgentRun {
  runId: string;
  npc: string;
  goal: string;
  state?: string;
  startedAt?: number;
  updatedAt?: number;
  plan?: string[];
  steps: AgentStep[];
  summary?: string;
}

/** lf.builder.planned {npc?, prompt, plan, summary, source}. */
export interface BuildEntry {
  id: string;
  ts: number;
  player: string | null;
  npc?: string;
  prompt: string;
  summary: string;
  source: string;
  model?: string;
  plan: VoxelPlanLike;
  materials?: Record<string, number>;
}

/** Spec §3 Voxel DSL v1 (loose mirror). */
/** A Voxel DSL plan as stored in lf.builder.planned (validated with clampVoxelPlan before expanding). */
export type VoxelPlanLike = VoxelPlan;

export type CassetteMode = "live" | "record" | "replay";
export interface CassetteInfo {
  mode: CassetteMode;
  count: number;
  liveAvailable: boolean;
  dir?: string;
  stats?: { hits: number; looseHits: number; fuzzyHits: number; misses: number; recorded: number };
  cassettes?: { key: string; model: string; createdAt: number; preview: string; streamed: boolean }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
/** De-dupe key: the same step can arrive as a WS brain entry and as an event. */
export const brainSig = (b: BrainEntry): string => `${b.source}|${b.kind}|${b.actor}|${b.text.slice(0, 80)}`;

export const MODEL_COLORS: Record<string, string> = { sonnet: "#9085e9", haiku: "#3987e5", rules: "#8a93a6", cache: "#199e70", replay: "#c98500" };
export const BRAIN_SOURCE_COLORS: Record<string, string> = {
  agents: "#ff7a2f", builder: "#c98500", factions: "#d95926", director: "#9085e9", reactions: "#d55181", forge: "#199e70", persona: "#3987e5",
};

/** Tolerant reader for the agents.runs projection: {runs: [...]}, a bare array, or {runs: {id: run}}. */
export function normaliseRuns(st: unknown): AgentRun[] {
  const list: unknown[] = Array.isArray(st) ? st : isObj(st) && Array.isArray(st.runs) ? st.runs : isObj(st) && isObj(st.runs) ? Object.values(st.runs) : [];
  const out: AgentRun[] = [];
  for (const r of list) {
    if (!isObj(r)) continue;
    const steps = (Array.isArray(r.steps) ? r.steps : []).filter(isObj).map((x, i) => ({ i: typeof x.i === "number" ? x.i : i, ...x }) as AgentStep);
    out.push({
      runId: s(r.runId) || s(r.id) || `run${out.length}`,
      npc: s(r.npc) || s(r.agent) || "?",
      goal: s(r.goal) || "",
      state: s(r.state) || s(r.status) || undefined,
      startedAt: typeof r.startedAt === "number" ? r.startedAt : typeof r.ts === "number" ? r.ts : undefined,
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : undefined,
      plan: Array.isArray(r.plan) ? r.plan.map(s) : undefined,
      steps,
      summary: s(r.summary) || undefined,
    });
  }
  return out.sort((a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0));
}

/** lf.builder.planned event -> BuildEntry (null when it carries no plan). */
export function buildFromEvent(e: StoredEvent): BuildEntry | null {
  const d = e.data;
  const plan = isObj(d.plan) && Array.isArray(d.plan.ops) ? (d.plan as unknown as VoxelPlanLike) : null;
  if (!plan) return null;
  return {
    id: `ev${e.seq}`, ts: e.ts, player: e.player, npc: s(d.npc) || undefined, prompt: s(d.prompt), summary: s(d.summary), source: s(d.source) || "rules",
    model: s(d.model) || undefined, plan, ...(isObj(d.materials) ? { materials: d.materials as Record<string, number> } : {}),
  };
}
