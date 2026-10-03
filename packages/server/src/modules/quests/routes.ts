// HTTP routes for the quests module.
//   Public (SDK key) at /v1/m/quests/*:
//     GET  log?world=&player=                 the player's quest log (offered / active / completed / achievements ...)
//     GET  progression?world=&player=&limit=  unlocked progression + ranked suggestions
//     POST objective {world, player, trigger?, text?, condition?, mode?, expiresInSec?, reward?}
//                                             start a dynamic objective (no condition = pick a template for the trigger)
import { Hono, type Context } from "hono";
import type { LfEnv, ModuleContext, ModuleRoutes } from "../../module.js";
import { clamp, numOr, scopeFor, str } from "../world/util.js";
import { questLog } from "./log.js";
import { suggestProgression } from "./progression.js";
import { startObjective } from "./objectives.js";

type C = Context<LfEnv>;
const err = (c: C, status: 400 | 409, code: string, message: string) => c.json({ error: { code, message } }, status);

export function questRoutes(contexts: Map<string, ModuleContext>): ModuleRoutes {
  const pub = new Hono<LfEnv>();
  const need = (c: C) => {
    const ctx = contexts.get(c.get("game")) ?? null;
    const world = c.req.query("world");
    const player = c.req.query("player");
    return { ctx, world, player };
  };
  pub.get("/log", (c) => {
    const { ctx, world, player } = need(c);
    if (!ctx) return err(c, 409, "module_disabled", "quests module not initialised for this game");
    if (!world || !player) return err(c, 400, "bad_request", "?world= and ?player= are required");
    return c.json(questLog(ctx, world, player));
  });
  pub.get("/progression", (c) => {
    const { ctx, world, player } = need(c);
    if (!ctx) return err(c, 409, "module_disabled", "quests module not initialised for this game");
    if (!world || !player) return err(c, 400, "bad_request", "?world= and ?player= are required");
    const limit = clamp(Number(c.req.query("limit") ?? 5) || 5, 1, 50);
    return c.json({ unlocked: questLog(ctx, world, player).unlocks, suggestions: suggestProgression(ctx, world, player, undefined, limit) });
  });
  pub.post("/objective", async (c) => {
    const ctx = contexts.get(c.get("game"));
    if (!ctx) return err(c, 409, "module_disabled", "quests module not initialised for this game");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const world = str(b.world);
    const player = str(b.player);
    if (!world || !player) return err(c, 400, "bad_request", "body needs {world, player}");
    const reward = b.reward && typeof b.reward === "object" ? (b.reward as Record<string, unknown>) : null;
    const res = startObjective(scopeFor(ctx, world, player), player, {
      trigger: str(b.trigger) || "game",
      text: str(b.text) || undefined,
      condition: str(b.condition) || undefined,
      mode: b.mode === "keep" ? "keep" : b.mode === "reach" ? "reach" : undefined,
      expiresInSec: typeof b.expiresInSec === "number" ? b.expiresInSec : undefined,
      reward: reward && str(reward.type) ? { type: str(reward.type), ...(reward.id ? { id: str(reward.id) } : {}), ...(typeof reward.amount === "number" ? { amount: numOr(reward.amount, 0) } : {}) } : undefined,
    });
    return res.objective ? c.json(res) : err(c, 409, "conflict", res.why);
  });
  return { public: pub };
}
