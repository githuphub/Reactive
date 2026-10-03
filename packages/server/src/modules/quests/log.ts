// Projection "quests.log" (player scope): offered / active / completed / failed quests, unlocked achievements,
// plus K2 extensions: offer times, generated personal achievements (not yet unlocked), dynamic objectives and
// progression unlocks. Folds "lf.quests.*" events and the SDK's quest.accepted signal.
import type { Achievement, Quest, QuestLog } from "@liveforge/protocol";
import type { ModuleContext, Projection } from "../../module.js";
import { safeProjection, str } from "../world/util.js";

/** A dynamic objective inside an encounter (spec §3.6): condition + reward + expiry. */
export interface DynamicObjective {
  id: string;
  text: string;
  /** DSL; windows are clipped to `startedAt`. */
  condition: string;
  reward: { type: string; id?: string; amount?: number };
  /** reach = completes as soon as the condition is true; keep = must stay true until expiry (fails when it breaks). */
  mode: "reach" | "keep";
  startedAt: number;
  expiresAt: number;
  status: "active" | "completed" | "failed" | "expired";
  /** What triggered it ("director:boss_phase", "moment:comeback", "game"). */
  trigger: string;
  endedAt?: number;
}

export interface UnlockRecord {
  id: string;
  name: string;
  kind: string;
  at: number;
}

export type QuestLogState = QuestLog & {
  offeredAt: Record<string, number>;
  /** Personal achievements generated for this player that are not unlocked yet. */
  personal: Achievement[];
  /** Active + recently finished dynamic objectives (newest last, <= 20). */
  objectives: DynamicObjective[];
  unlocks: UnlockRecord[];
};

const MAX_OFFERED = 10;
const MAX_DONE = 100;

const empty = (): QuestLogState => ({ offered: [], active: [], completed: [], failed: [], achievements: [], offeredAt: {}, personal: [], objectives: [], unlocks: [] });

function ensure(s: QuestLogState): QuestLogState {
  s.offeredAt ??= {};
  s.personal ??= [];
  s.objectives ??= [];
  s.unlocks ??= [];
  return s;
}

function finish(s: QuestLogState, questId: string, ts: number, into: "completed" | "failed"): void {
  const i = s.active.findIndex((a) => a.quest.id === questId);
  const j = s.offered.findIndex((q) => q.id === questId);
  const title = i >= 0 ? s.active[i].quest.title : j >= 0 ? s.offered[j].title : "";
  if (i < 0 && (into === "completed" || j < 0)) return;
  if (i >= 0) s.active.splice(i, 1);
  else if (j >= 0) s.offered.splice(j, 1);
  s[into].push({ questId, title, at: ts });
  if (s[into].length > MAX_DONE) s[into].splice(0, s[into].length - MAX_DONE);
}

export const questLogProjection: Projection<QuestLogState> = {
  name: "quests.log",
  scope: "player",
  version: 1,
  types: ["lf.quests.*", "quest.accepted"],
  init: () => empty(),
  apply(s, ev) {
    ensure(s);
    const d = ev.data;
    switch (ev.type) {
      case "lf.quests.offered": {
        const q = d.quest as Quest | undefined;
        if (!q?.id) return;
        const i = s.offered.findIndex((x) => x.id === q.id);
        if (i >= 0) s.offered[i] = q;
        else {
          s.offered.push(q);
          s.offeredAt[q.id] = ev.ts;
        }
        // An upgraded copy of an already accepted quest updates the active entry.
        const a = s.active.find((x) => x.quest.id === q.id);
        if (a) a.quest = q;
        while (s.offered.length > MAX_OFFERED) delete s.offeredAt[s.offered.shift()!.id];
        return;
      }
      case "lf.quests.withdrawn": {
        const id = str(d.questId);
        s.offered = s.offered.filter((q) => q.id !== id);
        delete s.offeredAt[id];
        return;
      }
      case "quest.accepted": {
        const id = str(d.quest);
        const i = s.offered.findIndex((q) => q.id === id);
        if (i < 0 || s.active.some((a) => a.quest.id === id)) return;
        const [q] = s.offered.splice(i, 1);
        delete s.offeredAt[id];
        s.active.push({ quest: q, acceptedAt: ev.ts, progress: {} });
        return;
      }
      case "lf.quests.progress": {
        const a = s.active.find((x) => x.quest.id === d.questId);
        if (a && typeof d.progress === "number") a.progress[str(d.objectiveId)] = d.progress;
        return;
      }
      case "lf.quests.completed":
        finish(s, str(d.questId), ev.ts, "completed");
        return;
      case "lf.quests.failed":
        finish(s, str(d.questId), ev.ts, "failed");
        return;
      case "lf.quests.achievement": {
        const a = d.achievement as Achievement | undefined;
        if (!a?.id || s.achievements.some((x) => x.id === a.id)) return;
        s.achievements.push({ ...a, unlockedAt: a.unlockedAt ?? ev.ts });
        s.personal = s.personal.filter((x) => x.id !== a.id);
        return;
      }
      case "lf.quests.personal": {
        const a = d.achievement as Achievement | undefined;
        if (!a?.id || s.achievements.some((x) => x.id === a.id)) return;
        const i = s.personal.findIndex((x) => x.id === a.id);
        if (i >= 0) s.personal[i] = a;
        else s.personal.push(a);
        return;
      }
      case "lf.quests.objective": {
        const o = d.objective as DynamicObjective | undefined;
        if (!o?.id) return;
        const i = s.objectives.findIndex((x) => x.id === o.id);
        if (i >= 0) s.objectives[i] = o;
        else s.objectives.push(o);
        if (s.objectives.length > 20) s.objectives = s.objectives.filter((x, k) => x.status === "active" || k >= s.objectives.length - 20);
        return;
      }
      case "lf.quests.unlock": {
        const u = d.unlock as UnlockRecord | undefined;
        if (u?.id && !s.unlocks.some((x) => x.id === u.id)) s.unlocks.push({ ...u, at: u.at ?? ev.ts });
        return;
      }
    }
  },
};

/** The player's quest log (empty when the quests module is disabled). */
export function questLog(ctx: Pick<ModuleContext, "projections">, world: string, player: string): QuestLogState {
  const s = safeProjection<QuestLogState>(ctx, "quests.log", { world, player });
  return s ? ensure(s) : empty();
}
