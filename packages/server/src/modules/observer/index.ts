// Module "observer" - OWNER: K1. Only edit files inside packages/server/src/modules/observer/.
// Player model: built-in + designer traits (sliding windows, decay, evidence), moments, LLM profile.
// Contract: docs/CONTRACTS.md. Asks owned here: (none).
// Projections owned here: observer.player_model (player scope; state shape PlayerModel in @liveforge/protocol).
import { defineModule } from "../../module.js";

export default defineModule({
  id: "observer",
  description: "Player model: built-in + designer traits (sliding windows, decay, evidence), moments, LLM profile.",
  projections: [],
  signalHandlers: [],
  // Unimplemented ask kinds fall back to the core rules stubs in core/fallbacks.ts.
  asks: {},
  ticks: [],
});
