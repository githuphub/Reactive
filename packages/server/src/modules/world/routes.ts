// HTTP routes for the world module.
//   Public (SDK key) at /v1/m/world/*:
//     GET  rumours?world=&npc=&player=&limit=   rumours an NPC knows (hottest first; about `player` first)
//     GET  standing?world=&player=&npcs=a,b     reputation + standing per faction, NPC attitudes, shop prices, relationships
//     GET  reactions?world=&player=             reactions fired for the player that are still active
//   Admin at /admin/m/world/*:
//     GET  state?world=                          rumours + factions projection states
//     POST rumour {world, content, npcs?, heat?, sentiment?, aboutNpc?, aboutPlayer?}   seed a designer rumour
//     POST relationship {world, a, b, kind?, strength?, delta?, remove?}             change the NPC graph
//     POST reputation {world, player, faction, delta? | set?, reason?}               adjust reputation
//     GET  reactions-lib?world=&player=          Reaction Library: enabled recipes, fired reactions, novelty ledger and
//                                                live fingerprints per NPC (dashboard "Reactions" panel)
import { Hono, type Context } from "hono";
import type { LfEnv, ModuleContext, ModuleRoutes } from "../../module.js";
import { knownRumours, rumourState, seedRumour } from "./rumours.js";
import { changeReputation, factionState, standingReport } from "./factions.js";
import { activeReactions } from "./reactions.js";
import { libraryState } from "./reactions-lib/index.js";
import { clamp, factionById, numOr, personaById, scopeFor, str } from "./util.js";

type C = Context<LfEnv>;
const err = (c: C, status: 400 | 404 | 409, code: string, message: string) => c.json({ error: { code, message } }, status);

export function worldRoutes(contexts: Map<string, ModuleContext>): ModuleRoutes {
  const ctxOf = (c: C) => contexts.get(c.get("game")) ?? null;

  const pub = new Hono<LfEnv>();
  pub.get("/rumours", (c) => {
    const ctx = ctxOf(c);
    const world = c.req.query("world");
    const npc = c.req.query("npc");
    if (!ctx) return err(c, 409, "module_disabled", "world module not initialised for this game");
    if (!world || !npc) return err(c, 400, "bad_request", "?world= and ?npc= are required");
    const limit = clamp(Number(c.req.query("limit") ?? 5) || 5, 1, 50);
    return c.json({ npc, rumours: knownRumours(ctx, world, npc, { player: c.req.query("player") ?? null, limit }) });
  });
  pub.get("/standing", (c) => {
    const ctx = ctxOf(c);
    const world = c.req.query("world");
    const player = c.req.query("player");
    if (!ctx) return err(c, 409, "module_disabled", "world module not initialised for this game");
    if (!world || !player) return err(c, 400, "bad_request", "?world= and ?player= are required");
    const npcs = c.req.query("npcs")?.split(",").map((s) => s.trim()).filter(Boolean);
    return c.json(standingReport(ctx, world, player, npcs));
  });
  pub.get("/reactions", (c) => {
    const ctx = ctxOf(c);
    const world = c.req.query("world");
    const player = c.req.query("player");
    if (!ctx) return err(c, 409, "module_disabled", "world module not initialised for this game");
    if (!world || !player) return err(c, 400, "bad_request", "?world= and ?player= are required");
    return c.json({ active: activeReactions(ctx, world, player) });
  });

  const admin = new Hono<LfEnv>();
  admin.get("/reactions-lib", (c) => {
    const ctx = ctxOf(c);
    const world = c.req.query("world");
    if (!ctx) return err(c, 409, "module_disabled", "world module not initialised for this game");
    if (!world) return err(c, 400, "bad_request", "?world= is required");
    return c.json(libraryState(ctx, world, c.req.query("player") || null));
  });
  admin.get("/state", (c) => {
    const ctx = ctxOf(c);
    const world = c.req.query("world");
    if (!ctx) return err(c, 409, "module_disabled", "world module not initialised for this game");
    if (!world) return err(c, 400, "bad_request", "?world= is required");
    return c.json({ rumours: rumourState(ctx, world), factions: factionState(ctx, world) });
  });
  admin.post("/rumour", async (c) => {
    const ctx = ctxOf(c);
    if (!ctx) return err(c, 409, "module_disabled", "world module not initialised for this game");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const world = str(b.world);
    const content = str(b.content).trim();
    if (!world || !content) return err(c, 400, "bad_request", "body needs {world, content}");
    const npcs = Array.isArray(b.npcs) ? b.npcs.map(str).filter((id) => personaById(ctx.manifest, id)) : undefined;
    const r = seedRumour(scopeFor(ctx, world, null), {
      content, npcs, heat: clamp(numOr(b.heat, 0.6), 0.05, 1), sentiment: clamp(numOr(b.sentiment, 0), -1, 1),
      aboutNpc: str(b.aboutNpc) || undefined, aboutPlayer: str(b.aboutPlayer) || undefined, truthfulness: clamp(numOr(b.truthfulness, 1), 0, 1),
    });
    return r ? c.json({ rumour: r }) : err(c, 409, "conflict", "a rumour with this content was seeded moments ago (or there are no personas)");
  });
  admin.post("/relationship", async (c) => {
    const ctx = ctxOf(c);
    if (!ctx) return err(c, 409, "module_disabled", "world module not initialised for this game");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const world = str(b.world);
    const a = str(b.a);
    const bb = str(b.b);
    if (!world || !a || !bb || a === bb) return err(c, 400, "bad_request", "body needs {world, a, b} with two different npc ids");
    const ev = ctx.record("lf.world.relationship", {
      a, b: bb, ...(b.kind ? { kind: str(b.kind) } : {}), ...(typeof b.strength === "number" ? { strength: clamp(b.strength, 0, 1) } : {}),
      ...(typeof b.delta === "number" ? { delta: clamp(b.delta, -1, 1) } : {}), ...(b.remove === true ? { remove: true } : {}), reason: "admin",
    }, { world, player: null });
    return c.json({ seq: ev.seq, relationships: factionState(ctx, world).relationships });
  });
  admin.post("/reputation", async (c) => {
    const ctx = ctxOf(c);
    if (!ctx) return err(c, 409, "module_disabled", "world module not initialised for this game");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const world = str(b.world);
    const player = str(b.player);
    const faction = str(b.faction);
    if (!world || !player || !factionById(ctx.manifest, faction)) return err(c, 400, "bad_request", "body needs {world, player, faction} with a manifest faction id");
    if (typeof b.set === "number") ctx.record("lf.world.reputation", { faction, set: clamp(b.set, -1, 1), reason: str(b.reason) || "admin" }, { world, player });
    else changeReputation(scopeFor(ctx, world, player), player, faction, clamp(numOr(b.delta, 0), -1, 1), str(b.reason) || "admin");
    return c.json(standingReport(ctx, world, player));
  });

  return { public: pub, admin };
}
