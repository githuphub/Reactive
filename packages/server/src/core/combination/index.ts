// Combination engine (Reaction Library, R1): pure, deterministic building blocks shared by World (recipes),
// Persona (bark / reply context injection) and the Director (boss lines). No ctx, no LLM, no clock.
//  - fingerprint: facets -> stable hash + readable context sentence
//  - novelty: seeded variant choice that never repeats a line still in the speaker's ledger
//  - variety: template filling, combination weighting, facet asides, persona voice tics
export * from "./fingerprint.js";
export * from "./novelty.js";
export * from "./variety.js";
