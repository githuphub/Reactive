// lf.factions: the village mind (K7 factions module). State reads, two-stage raid plans and typed handlers for the
// directives the module pushes (custom.faction_posture, custom.guard_posts).
import {
  defaultRaidPlan,
  type AskParamsInput,
  type Directive,
  type FactionMind,
  type FactionPostureArgs,
  type GuardPostsArgs,
} from "@liveforge/protocol";
import type { AskHandle } from "./ask.js";
import type { AskOptions } from "./client.js";
import type { Unsubscribe } from "./emitter.js";

/** What FactionsApi needs from the client (kept small so the client wiring is one line). */
export interface FactionsHost {
  /** Current world id. */
  world(): string;
  get<T>(path: string, query: Record<string, string | undefined>): Promise<T | undefined>;
  post<T>(path: string, body: unknown): Promise<T | undefined>;
  ask(params: AskParamsInput<"faction.raid_plan">, opts: AskOptions<"faction.raid_plan">): AskHandle<"faction.raid_plan">;
  on(kind: string, fn: (d: Directive) => void): Unsubscribe;
}

/** Threat the game reports to a village (a raid at the gate, a fire, a monster in the square ...). */
export interface ThreatReport {
  faction: string;
  /** raid | fire | monster | ... (free). Default "threat". */
  kind?: string;
  /** Who / what: a mob id, a player id ... */
  source?: string;
  /** 0-1, default 0.5. */
  level?: number;
  note?: string;
}

/**
 * Village minds (needs `modules.factions: true` in the manifest).
 *
 * ```ts
 * const mind = await lf.factions.state("oakhollow");          // posture, priceMult, trust, guards, raids ...
 * const raid = lf.factions.raidPlan({ night: 2 });            // instant rules plan, then the Haiku upgrade
 * spawner.plan((await raid.instant).result);
 * raid.onUpgrade((r) => spawner.plan(r.result));
 * lf.factions.onPosture((p) => { shop.setPrices(p.priceMult); toast(p.announcement); });
 * lf.factions.onGuardPosts((g) => g.posts.forEach(({ npc, post }) => villagers[npc].walkTo(post)));
 * ```
 */
export class FactionsApi {
  constructor(private readonly host: FactionsHost) {}

  /** One faction's mind (`GET /v1/m/factions/state`). Resolves null when the module is off or the server is unreachable. */
  async state(faction: string, world: string = this.host.world()): Promise<FactionMind | null> {
    try {
      const r = await this.host.get<{ mind?: FactionMind }>("/v1/m/factions/state", { world, faction });
      return r?.mind ?? null;
    } catch {
      return null;
    }
  }

  /** Every faction's mind in the world (faction id -> mind); {} when unavailable. */
  async all(world: string = this.host.world()): Promise<Record<string, FactionMind>> {
    try {
      const r = await this.host.get<{ factions?: Record<string, FactionMind> }>("/v1/m/factions/state", { world });
      return r?.factions ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Plan tonight's raid (ask `faction.raid_plan`, two-stage): `instant` is the rules counter-plan from the player's
   * habits, `onUpgrade` delivers the Haiku plan. Offline it answers with a plain mixed raid.
   */
  raidPlan(params: AskParamsInput<"faction.raid_plan"> = {}, opts: AskOptions<"faction.raid_plan"> = {}): AskHandle<"faction.raid_plan"> {
    return this.host.ask(params, { fallback: defaultRaidPlan(undefined, params.size ?? "medium"), ...opts });
  }

  /** The village changed posture / prices (`custom.faction_posture`). A later `stage: "ai"` call refines the rules one. */
  onPosture(fn: (args: FactionPostureArgs & { stage?: "rules" | "ai" }, directive: Directive) => void, opts: { faction?: string } = {}): Unsubscribe {
    return this.host.on("custom.faction_posture", (d) => {
      const a = d.args as FactionPostureArgs & { stage?: "rules" | "ai" };
      if (opts.faction && a.faction !== opts.faction) return;
      fn(a, d);
    });
  }

  /** Guards should move to new posts (`custom.guard_posts`). Posts: "gate", "square", "home:<npc>", "player:<id>" ... */
  onGuardPosts(fn: (args: GuardPostsArgs, directive: Directive) => void, opts: { faction?: string } = {}): Unsubscribe {
    return this.host.on("custom.guard_posts", (d) => {
      const a = d.args as GuardPostsArgs;
      if (opts.faction && a.faction !== opts.faction) return;
      fn(a, d);
    });
  }

  /** Report a threat to a village (`POST /v1/m/factions/threat`); the village re-thinks at once. */
  async reportThreat(t: ThreatReport, world: string = this.host.world()): Promise<boolean> {
    try {
      await this.host.post("/v1/m/factions/threat", { world, ...t });
      return true;
    } catch {
      return false;
    }
  }
}
