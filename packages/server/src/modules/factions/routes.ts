// HTTP routes for the factions module (K7).
//   Public (SDK key) at /v1/m/factions/*:
//     GET  state?world=&faction=        one faction's mind ({faction, name, mind}); without faction: every faction
//     POST threat {world, faction, kind?, source?, level?, note?, player?}
//                                       the game reports a threat (a raid at the gate, a fire ...); re-evaluates
//   Admin at /admin/m/factions/*:
//     GET  state?world=                 every mind + the resolved config (members, guards, posts, raid mobs)
//     POST council {world, faction?}    force a council now (rules, then the LLM upgrade when keyed); returns it
import { Hono, type Context } from "hono";
import type { FactionMindState } from "@liveforge/protocol";
import type { LfEnv, ModuleContext, ModuleRoutes } from "../../module.js";
import { scopeFor } from "../world/util.js";
import { clamp, num, resolveFactions, str } from "./config.js";
import { evaluate, mindOf } from "./council.js";

type C = Context<LfEnv>;
const err = (c: C, status: 400 | 404 | 409, code: string, message: string) => c.json({ error: { code, message } }, status);

function minds(ctx: ModuleContext, world: string): FactionMindState["factions"] {
  const out: FactionMindState["factions"] = {};
  for (const f of ctx.manifest.factions) out[f.id] = mindOf(ctx, world, f.id);
  return out;
}

export function factionRoutes(contexts: Map<string, ModuleContext>): ModuleRoutes {
  const pub = new Hono<LfEnv>();
  const admin = new Hono<LfEnv>();
  const ctxOf = (c: C) => contexts.get(c.get("game")) ?? null;

  pub.get("/state", (c) => {
    const ctx = ctxOf(c);
    if (!ctx) return err(c, 409, "module_disabled", "factions module is not enabled for this game (modules.factions: true)");
    const world = c.req.query("world");
    if (!world) return err(c, 400, "bad_request", "?world= is required");
    const faction = c.req.query("faction");
    if (!faction) return c.json({ factions: minds(ctx, world) });
    const rf = resolveFactions(ctx.manifest).get(faction);
    if (!rf) return err(c, 404, "not_found", `unknown faction "${faction}"`);
    return c.json({ faction, name: rf.name, mind: mindOf(ctx, world, faction) });
  });

  pub.post("/threat", async (c) => {
    const ctx = ctxOf(c);
    if (!ctx) return err(c, 409, "module_disabled", "factions module is not enabled for this game");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const world = str(b.world);
    const faction = str(b.faction);
    if (!world || !faction) return err(c, 400, "bad_request", "body needs {world, faction}");
    if (!resolveFactions(ctx.manifest).has(faction)) return err(c, 404, "not_found", `unknown faction "${faction}"`);
    const player = str(b.player) || null;
    const sc = scopeFor(ctx, world, player);
    sc.record("lf.factions.threat", { faction, kind: str(b.kind) || "threat", source: str(b.source) || player || "unknown", level: clamp(num(b.level, 0.5), 0, 1), note: str(b.note).slice(0, 160) || undefined }, { player });
    const decision = await evaluate(sc, faction, "threat reported");
    return c.json({ ok: true, decision });
  });

  admin.get("/state", (c) => {
    const ctx = ctxOf(c);
    if (!ctx) return err(c, 409, "module_disabled", "factions module is not enabled for this game");
    const world = c.req.query("world") ?? "default";
    const config = [...resolveFactions(ctx.manifest).values()].map(({ cfg: _cfg, ...rest }) => rest);
    return c.json({ world, factions: minds(ctx, world), config });
  });

  admin.post("/council", async (c) => {
    const ctx = ctxOf(c);
    if (!ctx) return err(c, 409, "module_disabled", "factions module is not enabled for this game");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const world = str(b.world) || "default";
    const ids = str(b.faction) ? [str(b.faction)] : ctx.manifest.factions.map((f) => f.id);
    const out: Record<string, unknown> = {};
    for (const id of ids) out[id] = await evaluate(scopeFor(ctx, world, null), id, "admin", { force: true, awaitCouncil: true });
    return c.json({ world, decisions: out, factions: minds(ctx, world) });
  });

  return { public: pub, admin };
}
