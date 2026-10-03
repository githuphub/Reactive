// Module "quests" - OWNER: K2. Only edit files inside packages/server/src/modules/quests/.
// Quests: reactive quests, personal achievements, progression suggestions, dynamic objectives.
// Contract: docs/CONTRACTS.md. Asks owned here: quest.offer, achievement.check.
// Projections owned here: quests.log (player; QuestLog).
import { defineModule } from "../../module.js";

export default defineModule({
  id: "quests",
  description: "Quests: reactive quests, personal achievements, progression suggestions, dynamic objectives.",
  projections: [],
  signalHandlers: [],
  // Unimplemented ask kinds fall back to the core rules stubs in core/fallbacks.ts.
  asks: {},
  ticks: [],
});
