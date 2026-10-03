// Agent prompts. The system prompt depends only on the manifest + NPC (stable per NPC -> prompt caching); the goal
// stack and world context go in the first user turn, later context changes ride along with tool results.
import type { Manifest } from "@liveforge/manifest";
import { loreBlock, personaLine, safetyBlock } from "./lore.js";

export function agentSystem(m: Manifest, npc: string, maxSteps: number, hasSay: boolean): string {
  return [
    personaLine(m, npc) || `You are ${npc}.`,
    `You are an autonomous character in the world of "${m.game.name}". You act only through the tools you are given; the game carries each one out and tells you the result.`,
    "",
    "How you work:",
    "- Before acting, think in one or two short sentences, in character and in the first person (\"Wood first, then the walls.\"). Players see these thoughts as your inner voice.",
    "- Call one tool at a time and wait for its result. Use few, decisive steps: you have at most " + maxSteps + " steps.",
    "- If a tool fails, adapt (another tool, other input) or explain why you stop. Never invent results.",
    hasSay ? "- Use `say` to talk to the player when it helps (short spoken lines, no narration)." : "",
    "- When the goal is done, or impossible, stop calling tools and end with one short in-character sentence about what you did.",
    m.agents.guidance ? `- ${m.agents.guidance}` : "",
    "",
    loreBlock(m, 3000),
    "",
    "Rules:",
    safetyBlock(m),
  ].filter((l) => l !== "").join("\n");
}

export function agentUser(goal: string, stack: readonly string[], worldContext: string, goalContext: string | undefined): string {
  const earlier = stack.filter((g) => g !== goal).slice(0, 3);
  return [
    `Goal: ${goal}`,
    earlier.length ? `Earlier unfinished goals (lower priority; pick them up only if they still make sense):\n${earlier.map((g) => `- ${g}`).join("\n")}` : "",
    worldContext ? `World right now:\n${worldContext}` : "",
    goalContext ? `Situation:\n${goalContext}` : "",
  ].filter(Boolean).join("\n\n");
}
