// Quest progress: match incoming signals against active quest objectives, complete quests, expire stale ones.
// Objectives with a DSL `condition` are evaluated instead (windows clipped to the accept time).
import type { Quest, QuestObjective, StoredEvent } from "@liveforge/protocol";
import type { EventContext, ScopedContext, TickContext } from "../../module.js";
import { evalCondition } from "../world/dsl.js";
import { nameOf, scopeFor, str } from "../world/util.js";
import { questLog } from "./log.js";

/** Does this event advance the objective? Returns the increment (0 = no). */
export function objectiveHit(o: QuestObjective, ev: StoredEvent): number {
  const d = ev.data;
  const t = o.target;
  const any = t === "any" || t === "*";
  const eq = (v: unknown) => any || str(v) === t;
  switch (o.type) {
    case "kill":
      return ev.type === "combat.killed" && (eq(d.target_type) || eq(d.target)) ? 1 : 0;
    case "defeat_boss":
      return (ev.type === "combat.killed" && (eq(d.target) || (any && d.boss === true))) ? 1 : 0;
    case "talk":
      return ev.type === "social.talked_to" && eq(d.npc) ? 1 : 0;
    case "explore":
      return (ev.type === "movement.entered_zone" && eq(d.zone)) || (ev.type === "movement.explored" && (eq(d.zone) || eq(d.discovery))) ? 1 : 0;
    case "deliver":
      return ev.type === "social.gave" && eq(d.to) ? 1 : 0;
    case "fetch":
      return ["economy.bought", "gear.equipped", "item.picked", "item.found", "economy.stole"].includes(ev.type) && eq(d.item) ? 1 : 0;
  }
  // Custom / other types: a signal named after the type ("forge" -> forge.created, "escort" -> escort.*),
  // whose data mentions the target (or any target).
  const [ns, verb] = ev.type.split(".");
  if (ns !== o.type && verb !== o.type) return 0;
  if (any) return 1;
  return Object.values(d).some((v) => str(v) === t || (Array.isArray(v) && v.map(String).includes(t))) ? 1 : 0;
}

function completeQuest(ctx: ScopedContext, player: string, quest: Quest, why: string): void {
  ctx.record("lf.quests.completed", { questId: quest.id, title: quest.title, rewards: quest.rewards, giver: quest.giver ?? null }, { player });
  ctx.emit({ kind: "quest.update", target: "ui", args: { questId: quest.id, status: "completed" }, why: why.slice(0, 200) }, { player });
  const line = quest.dialogue?.complete;
  if (quest.giver && line && ctx.manifest.personas.some((p) => p.id === quest.giver)) {
    ctx.emit({ kind: "npc.bark", target: `npc:${quest.giver}`, args: { npc: quest.giver, text: line.slice(0, 300) }, why: `quest "${quest.title}" completed`.slice(0, 200) }, { player });
  }
}

/** Signal handler: advance objectives; complete quests whose required objectives are done. */
export function onQuestProgress(ctx: EventContext, ev: StoredEvent): void {
  const player = ev.player;
  if (!player) return;
  const log = questLog(ctx, ctx.world, player);

  // The game may report completion / failure itself.
  if (ev.type === "quest.completed" || ev.type === "quest.failed") {
    const id = str(ev.data.quest);
    const a = log.active.find((x) => x.quest.id === id);
    if (!a) return;
    if (ev.type === "quest.completed") completeQuest(ctx, player, a.quest, `game reported "${a.quest.title}" completed`);
    else {
      ctx.record("lf.quests.failed", { questId: id, reason: str(ev.data.reason) || "game" }, { player });
      ctx.emit({ kind: "quest.update", target: "ui", args: { questId: id, status: "failed" }, why: `game reported "${a.quest.title}" failed` }, { player });
    }
    return;
  }
  if (ev.type.startsWith("lf.")) return;

  for (const a of [...log.active]) {
    let changed = false;
    for (const o of a.quest.objectives) {
      const need = o.count ?? 1;
      const cur = a.progress[o.id] ?? 0;
      if (cur >= need) continue;
      let next = cur;
      if (o.condition) {
        if (evalCondition(ctx, ctx.world, player, o.condition, { notBefore: a.acceptedAt }).ok) next = need;
      } else next = Math.min(need, cur + objectiveHit(o, ev));
      if (next === cur) continue;
      changed = true;
      ctx.record("lf.quests.progress", { questId: a.quest.id, objectiveId: o.id, progress: next }, { player });
      ctx.emit({ kind: "quest.update", target: "ui", args: { questId: a.quest.id, status: "active", objectiveId: o.id, progress: next }, why: `${o.description} (${next}/${need})`.slice(0, 200) }, { player });
    }
    if (!changed) continue;
    const fresh = questLog(ctx, ctx.world, player).active.find((x) => x.quest.id === a.quest.id);
    if (fresh && fresh.quest.objectives.every((o) => o.optional || (fresh.progress[o.id] ?? 0) >= (o.count ?? 1))) {
      completeQuest(ctx, player, fresh.quest, `all objectives of "${fresh.quest.title}" done`);
    }
  }
}

/** Tick: expire active quests past their expiry and withdraw stale offers. */
export function expireTick(ctx: TickContext): void {
  const now = ctx.now();
  for (const player of ctx.activePlayers.slice(0, 200)) {
    const sc = scopeFor(ctx, ctx.world, player);
    const log = questLog(ctx, ctx.world, player);
    for (const a of log.active) {
      const exp = a.quest.expiresInSec;
      if (!exp || now - a.acceptedAt < exp * 1000) continue;
      sc.record("lf.quests.failed", { questId: a.quest.id, reason: "expired" }, { player });
      sc.emit({ kind: "quest.update", target: "ui", args: { questId: a.quest.id, status: "expired" }, why: `"${a.quest.title}" ran out of time` }, { player });
    }
    for (const q of log.offered) {
      const at = log.offeredAt[q.id];
      if (!at || !q.expiresInSec || now - at < q.expiresInSec * 1000) continue;
      sc.record("lf.quests.withdrawn", { questId: q.id, reason: "offer expired" }, { player });
      if (q.giver) ctx.log.debug("quest offer expired", { quest: q.id, giver: nameOf(ctx.manifest, q.giver) });
    }
  }
}
