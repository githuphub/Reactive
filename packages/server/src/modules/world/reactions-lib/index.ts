// Reaction Library (R1) - part of the world module. 20 ready-made reaction recipes switched on by one manifest line
// (`reactions: { library: [outfit_comments, ...] }`), run through the combination engine (core/combination):
// context fingerprints, a novelty ledger per speaker x player, seeded variety and persona voice.
// Docs: docs/reactions.md. Projection: world.reaction_ledger (player). Events: lf.reactions.*.
export { ledgerProjection, ledgerOf, LEDGER, LIB_EVENTS, type LedgerState } from "./state.js";
export { libraryOn, recipeOn, libraryOf, paramsOf } from "./config.js";
export { buildSituation, type Situation } from "./facets.js";
export {
  RECIPES, onLibraryEvent, libraryTick, libraryBark, libraryContext, libraryReplyInstant, replyLibSeen, recordLlmClaim,
  wantsClaimField, noteLine, libraryHabits, libraryBossPhase, libraryState, type LibraryLine, type LibraryContext,
} from "./engine.js";
export type { RecipeDef, Offer } from "./kit.js";
