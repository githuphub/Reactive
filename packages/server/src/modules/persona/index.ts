// Module "persona" - OWNER: K1. Only edit files inside packages/server/src/modules/persona/.
// Persona & Voice: persona cards, NPC x player memory, bark pools, streamed conversation with validated actions.
// Contract: docs/CONTRACTS.md. Asks owned here: npc.bark, npc.reply.
// Projections owned here: persona.memories (player scope; PersonaMemories).
import { defineModule } from "../../module.js";

export default defineModule({
  id: "persona",
  description: "Persona & Voice: persona cards, NPC x player memory, bark pools, streamed conversation with validated actions.",
  projections: [],
  signalHandlers: [],
  // Unimplemented ask kinds fall back to the core rules stubs in core/fallbacks.ts.
  asks: {},
  ticks: [],
});
