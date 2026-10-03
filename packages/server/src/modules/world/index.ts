// Module "world" - OWNER: K2. Only edit files inside packages/server/src/modules/world/.
// World reactions: rumours (spread + mutation), factions + reputation, NPC relationships, reactive rules.
// Contract: docs/CONTRACTS.md. Asks owned here: world.reactions.
// Projections owned here: world.rumours (world; RumourState), world.factions (world; FactionState).
import { defineModule } from "../../module.js";

export default defineModule({
  id: "world",
  description: "World reactions: rumours (spread + mutation), factions + reputation, NPC relationships, reactive rules.",
  projections: [],
  signalHandlers: [],
  // Unimplemented ask kinds fall back to the core rules stubs in core/fallbacks.ts.
  asks: {},
  ticks: [],
});
