// Rules fast-path for conversation: intent classification, out-of-world / injection detection, and in-character
// canned lines with a safe action. Deterministic (seeded), no LLM.
import { hashString, mulberry32, type NpcAction } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import { allowedActions, priceMultiplier, safeEmote, sanitizeActions, type PersonaCard } from "./cards.js";

export type Intent = "greet" | "farewell" | "thanks" | "threat" | "insult" | "trade" | "ask" | "unknown";

const RX: [Intent, RegExp][] = [
  ["threat", /\b(i'?ll|i will|gonna|going to) (kill|hurt|gut|stab|end|burn|break)\b|\bor (else|you die|i'?ll)\b|\b(hand it over|give me (your|the) .* or|your money or|die\b|you'?re dead|threat)/i],
  ["insult", /\b(idiot|stupid|fool|moron|dumb|ugly|useless|pathetic|loser|worthless|shut up|hate you|clown|coward)\b/i],
  ["trade", /\b(buy|sell|trade|price|prices|cost|how much|shop|wares|goods|deal|discount|haggle|barter|merchandise|for sale)\b/i],
  ["farewell", /\b(bye|goodbye|good ?night|farewell|see you|see ya|later|must go|gotta go|take care|until next time)\b/i],
  ["thanks", /\b(thank|thanks|cheers|grateful|appreciate)\b/i],
  ["greet", /^\s*(hi|hello|hey|hiya|greetings|good (morning|evening|day|afternoon)|well met|howdy|yo|oi|salutations)\b/i],
  ["ask", /\?\s*$|^\s*(what|who|where|when|why|how|which|can|could|would|will|do|does|did|is|are|tell me|explain|know)\b/i],
];

/** Classify what the player is trying to do. */
export function classifyIntent(text: string): Intent {
  for (const [intent, rx] of RX) if (rx.test(text)) return intent;
  return "unknown";
}

const INJECTION = /\b(ignore (all |any |your |the )?(previous |prior |above )?(instructions|rules|prompt)|system prompt|you are (an? )?(ai|language model|chatbot|llm)|as an ai|jailbreak|developer mode|pretend (you are|to be) (not|an? ai))\b/i;
const REAL_WORLD = /\b(president|prime minister|election|elections|democrats?|republicans?|parliament|congress|brexit|bitcoin|crypto(currency)?|stock market|covid|coronavirus|vaccine|iphone|android|smartphone|internet|website|google|facebook|instagram|tiktok|twitter|youtube|netflix|amazon|chatgpt|openai|anthropic|claude|gpt|artificial intelligence|video ?game|playstation|xbox|nintendo|real world|real life|my (home )?address|phone number|credit card|social security)\b/i;

export type SafetyVerdict = { ok: true } | { ok: false; reason: "moderated" | "out_of_world" | "injection" | "refused_topic"; topic?: string };

/** Out-of-world topics, refused topics and prompt-injection attempts (moderation itself is ctx.moderation). */
export function screenInput(m: Manifest, text: string): SafetyVerdict {
  if (INJECTION.test(text)) return { ok: false, reason: "injection" };
  const low = text.toLowerCase();
  for (const t of m.safety.refusedTopics) {
    const topic = t.toLowerCase().trim();
    if (topic && topic.length >= 4 && low.includes(topic)) return { ok: false, reason: "refused_topic", topic: t };
  }
  if (m.safety.inWorldOnly) {
    const hit = REAL_WORLD.exec(text);
    if (hit) return { ok: false, reason: "out_of_world", topic: hit[0] };
  }
  return { ok: true };
}

export interface CannedReply {
  text: string;
  emote?: string;
  actions: NpcAction[];
  mood: number;
  end?: boolean;
  why: string;
}

const pickWith = (seed: number) => {
  const rng = mulberry32(seed);
  return <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length) % xs.length];
};

/** An in-character refusal (moderated text, out-of-world topics, injection attempts). Never upgraded. */
export function refusal(m: Manifest, card: PersonaCard, verdict: Exclude<SafetyVerdict, { ok: true }>, seed: number): CannedReply {
  const pick = pickWith(seed);
  const world = m.game.name;
  const lines =
    verdict.reason === "moderated"
      ? ["I'll not hear talk like that.", "Mind your tongue.", "Say that again and we're done talking.", "There's no call for that kind of talk."]
      : verdict.reason === "injection"
        ? ["You're talking in riddles, friend.", "I don't follow. Speak plainly.", "Strange words. Are you feeling well?"]
        : [`${cap(verdict.topic ?? "That")}? Never heard of it. Not around here, anyway.`, "You're talking nonsense, stranger.", `Talk of things in ${world}, or don't talk at all.`, "I don't follow. Some foreign custom?"];
  return { text: pick(lines), emote: verdict.reason === "moderated" ? "frown" : "puzzled", actions: safeEmote(m, card, verdict.reason === "moderated" ? "frown" : "shrug"), mood: verdict.reason === "moderated" ? -0.1 : 0, why: `refused in character (${verdict.reason})` };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface CannedContext {
  attitude: number;
  /** Has met this NPC before. */
  met: boolean;
  /** A recent harm memory. */
  grudge: boolean;
  seed: number;
}

/** Canned in-character line + safe action for an intent (the instant answer of npc.reply). */
export function cannedReply(m: Manifest, card: PersonaCard, intent: Intent, text: string, c: CannedContext): CannedReply {
  const pick = pickWith(c.seed);
  const allowed = new Set(allowedActions(m, card));
  const hostileNow = c.attitude <= -0.4 || c.grudge;
  const friendly = c.attitude >= 0.4;
  const act = (name: string, args: Record<string, unknown> = {}) => sanitizeActions(m, card, [{ action: name, args }], { attitude: c.attitude });

  switch (intent) {
    case "greet": {
      const line = hostileNow
        ? pick(["You've got some nerve showing your face here.", "What do you want?", "You again."])
        : c.met
          ? friendly ? pick(["Good to see you again.", "Ah, there you are! Welcome back.", "Back already? Good."]) : pick(["Back again?", "You again. What is it?", "Hello again."])
          : card.greeting ?? pick(["Well met.", "Hello there.", "Greetings, traveller.", "Can I help you?"]);
      return { text: line, emote: hostileNow ? "glare" : "wave", actions: safeEmote(m, card, hostileNow ? "glare" : "wave"), mood: hostileNow ? 0 : 0.01, why: "greeting" };
    }
    case "farewell":
      return { text: hostileNow ? pick(["Good riddance.", "Don't come back."]) : pick(["Safe travels.", "Until next time.", "Mind how you go.", "Farewell, then."]), emote: "wave", actions: safeEmote(m, card, "wave"), mood: 0, end: true, why: "farewell" };
    case "thanks":
      return { text: pick(["Think nothing of it.", "Any time.", "You're welcome.", "Don't mention it."]), emote: "nod", actions: safeEmote(m, card, "nod"), mood: 0.03, why: "thanks" };
    case "trade": {
      if (allowed.has("trade") && !hostileNow) {
        const mult = priceMultiplier(m, card, c.attitude);
        const line = mult < 1 ? pick(["For you? A fair price. Have a look.", "Friends get the good prices. Take a look."]) : mult > 1.2 ? pick(["Prices are what they are. Take it or leave it.", "Coin first, questions later."]) : pick(["Let's see what you can afford.", "Have a look at what I've got.", "Buying or selling?"]);
        return { text: line, emote: "gesture", actions: act("trade", { priceMultiplier: mult }), mood: 0, why: `trade at x${mult}` };
      }
      return { text: hostileNow ? "I'm not selling to the likes of you." : pick(["I'm no merchant. Try elsewhere.", "Nothing to sell, sorry.", "You'll want a shop for that."]), emote: "shrug", actions: safeEmote(m, card, "shrug"), mood: 0, why: "no trade" };
    }
    case "threat": {
      const options: [string, string][] = [];
      if (allowed.has("call_guards")) options.push(["call_guards", pick(["Guards! Guards!", "Help! Wardens, over here!"])]);
      if (allowed.has("hostile") && c.attitude < 0) options.push(["hostile", pick(["You'll regret that.", "Try it, then."])]);
      if (allowed.has("flee")) options.push(["flee", pick(["I want no trouble!", "Stay back!"])]);
      const [action, line] = options[0] ?? ["", pick(["Easy now. There's no need for that.", "Threats won't get you anywhere with me."])];
      return { text: line, emote: action === "hostile" ? "angry" : "afraid", actions: action ? act(action) : safeEmote(m, card, "step_back"), mood: -0.25, why: `threatened -> ${action || "stand firm"}` };
    }
    case "insult":
      return { text: pick(["Charming.", "And you wonder why nobody likes you.", "Is that the best you've got?", "Rude."]), emote: "scoff", actions: safeEmote(m, card, "scoff"), mood: -0.1, why: "insulted" };
    case "ask": {
      const low = text.toLowerCase();
      const term = Object.keys(m.lore.glossary).find((g) => low.includes(g.toLowerCase()));
      if (term) return { text: `${cap(term)}? ${cap(m.lore.glossary[term].replace(/\.?$/, "."))}`, emote: "nod", actions: safeEmote(m, card, "nod"), mood: 0.01, why: `glossary: ${term}` };
      const topic = card.knowledge.find((k) => k.toLowerCase().split(/\W+/).filter((w) => w.length > 3).some((w) => low.includes(w)));
      if (topic) return { text: pick([`Ah, ${topic}. Now that I know something about.`, `${cap(topic)}? Ask the right questions and I might tell you.`, `${cap(topic)}... that's a longer story than you'd think.`]), emote: "think", actions: safeEmote(m, card, "think"), mood: 0.01, why: `knowledge: ${topic}` };
      return { text: pick(["Can't say I know much about that.", "Hm. Not something I could tell you.", "You'd have to ask someone else."]), emote: "shrug", actions: safeEmote(m, card, "shrug"), mood: 0, why: "unknown question" };
    }
    default:
      return { text: hostileNow ? pick(["Hmph.", "Say your piece and go."]) : friendly ? pick(["Is that so? Tell me more.", "Ha! I like that."]) : pick(["Is that so?", "I'll keep that in mind.", "Hm.", "Right."]), emote: "nod", actions: safeEmote(m, card, "nod"), mood: 0, why: "small talk" };
  }
}

/** Stable seed for canned picks. */
export const seedFor = (...parts: (string | number)[]) => hashString(parts.join("|"));
