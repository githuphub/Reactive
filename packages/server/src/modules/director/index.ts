// Module "director" - OWNER: K3. Only edit files inside packages/server/src/modules/director/.
// Director: boss move grammar + phase plans, squad tactics, pacing / tension, difficulty - every decision with a why.
// Contract: docs/CONTRACTS.md. Asks owned here: director.boss_phase, director.boss_move, director.encounter, director.pacing.
// Projections owned here: director.state (world; DirectorState).
import { defineModule } from "../../module.js";

export default defineModule({
  id: "director",
  description: "Director: boss move grammar + phase plans, squad tactics, pacing / tension, difficulty - every decision with a why.",
  projections: [],
  signalHandlers: [],
  // Unimplemented ask kinds fall back to the core rules stubs in core/fallbacks.ts.
  asks: {},
  ticks: [],
});
