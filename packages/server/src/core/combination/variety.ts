// Variety (Reaction Library combination engine, R1): template filling, combination weighting (more matching facets
// -> higher priority + a richer line that weaves in a second facet), and persona voice tics. Deterministic for a seed.
import { hashString, mulberry32 } from "@liveforge/protocol";
import { facetId, rankFacets, type Facet } from "./fingerprint.js";

/** Fill "{key}" placeholders; a missing key drops the placeholder (and a dangling ", " before it). */
export function fillLine(template: string, vars: Record<string, string | number | undefined | null>): string {
  return template
    .replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = vars[k];
      return v === undefined || v === null || v === "" ? "\u0000" : String(v);
    })
    .replace(/[,;:]?\s*\u0000/g, "")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Uppercase the first letter. */
export const capFirst = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Score of one candidate reaction: its base priority plus 0.15 per facet it actually uses, plus a little for how
 * rich the situation is overall. More matching facets -> higher priority.
 */
export function combinationScore(base: number, facets: Facet[], relevant: string[]): number {
  let used = 0;
  for (const f of facets) if (relevant.includes(f.kind) || relevant.includes(facetId(f))) used += 0.5 + f.weight * 0.5;
  return base + used * 0.15 + Math.min(6, facets.length) * 0.02;
}

/** Asides that weave a second facet into a line ("..., and in this rain too."). {x} = facet words. */
const ASIDES: Record<string, Record<string, string[]>> = {
  weather: {
    rain: ["And in this rain, too.", "Get out of the wet, at least.", "This rain gets into everything.", "Mind the puddles.", "Wet day for it.", "Rain won't wash that off."],
    storm: ["Hear that thunder?", "Storm's getting closer.", "Best find a roof before this storm breaks.", "Wild weather for it.", "Lightning's about tonight.", "This wind'll have your hat."],
    snow: ["Cold enough to freeze your ears off.", "Snow's settling, look.", "Don't slip on the ice.", "Wrap up warm.", "Winter's come early.", "Your breath's steaming."],
    fog: ["Can't see a thing in this fog.", "Fog hides all sorts.", "Stay close in this murk.", "Easy to get lost out there today.", "The fog's thick as porridge.", "Who knows what's out in that fog."],
    heat: ["Hot enough to bake bread on the stones.", "Get some shade.", "This heat'll do for us all.", "Drink something, you look parched.", "Sun's merciless today.", "Too hot for this."],
    "*": ["Strange weather we're having.", "Weather's turned, hasn't it?", "Mind the weather.", "Odd sort of day.", "Watch the sky.", "Weather's on everyone's mind."],
  },
  time: {
    night: ["Late to be out, mind.", "Lamps are lit, you should be in bed.", "Dark's no time for wandering.", "The night has ears.", "Quiet hour, this.", "Mind the shadows."],
    dawn: ["Barely light yet.", "You're up early.", "First light, and already busy.", "Even the birds are yawning.", "Dawn suits you.", "Early start, eh?"],
    dusk: ["Getting dark, mind.", "Lamps'll be lit soon.", "Day's nearly done.", "Best be indoors by nightfall.", "Sun's going down on us.", "Evening's coming on."],
    "*": ["Time flies.", "Long day, this.", "Hours slip by.", "It's that time again.", "Day's half gone.", "Where does the time go?"],
  },
  appearance: {
    bloodied: ["You're bleeding, you know.", "Someone should look at that cut.", "Is that your blood?", "You're dripping on the stones.", "Get that wound seen to.", "You look half-butchered."],
    wet: ["You're soaked through.", "Dry off before you catch your death.", "You're dripping everywhere.", "Fell in the fountain, did you?", "Wring yourself out.", "Wet as a drowned cat."],
    burnt: ["You smell like a bonfire.", "Your sleeve's still smoking.", "Singed, are we?", "Someone's been playing with fire.", "There's soot on your nose.", "You look half-roasted."],
    muddy: ["Wipe your boots.", "You're tracking mud everywhere.", "Rolled in a ditch, did you?", "Mud to the knees.", "You'll want a wash.", "Been crawling through the bog?"],
    "*": ["You look a sight.", "Rough day?", "You've seen better days.", "Straighten yourself up.", "What happened to you?", "You look worse for wear."],
  },
  nickname: { "*": ["Isn't that right, {x}?", "Eh, {x}?", "That's what they call you, isn't it? {x}.", "{x}, they say.", "Or should I say {x}?", "Well, {x}?"] },
  trait: {
    rich: ["Not that you'd notice the cost.", "Coin's no object for you, eh?", "Deep pockets, deep trouble.", "Mind that purse.", "Rich folk always say that.", "Spoken like someone with gold to spare."],
    broke: ["Not that you can afford it.", "Pockets empty again?", "Coin's tight, I know.", "Can't pay for much, can you?", "Times are hard.", "Poor as a church mouse."],
    famous: ["Everyone's talking about you.", "Your name's on every tongue.", "Famous folk get stared at.", "Half the town's watching you.", "You're the talk of the place.", "Can't move for gossip about you."],
    feared: ["Not that I'd argue with you.", "No offence meant.", "I want no trouble.", "Please don't take it badly.", "Easy, now.", "I'll keep my distance."],
    liar: ["If I can believe a word you say.", "Mind, you'd say anything.", "Truth's a stranger to you.", "I'll take that with salt.", "Your word's worth little.", "Can't trust a word of it."],
    "*": ["Folk say you're quite the {x}.", "Typical {x}.", "Spoken like a true {x}.", "That's the {x} in you.", "A real {x}, you are.", "Once a {x}, always a {x}."],
  },
  rumour: { "*": ["I heard what they're saying about you.", "Word gets around, you know.", "People talk.", "The gossip's already reached me.", "Don't think I haven't heard.", "News travels fast here."] },
  attitude: {
    warm: ["Always good to see you.", "You're one of the good ones.", "I mean that kindly.", "Take care of yourself.", "You know I'm fond of you.", "Come by any time."],
    cold: ["Not that I care.", "Don't push your luck.", "I'm watching you.", "Keep moving.", "Don't make me regret talking to you.", "I've not forgotten."],
  },
  status: { "*": ["{x}, I hear.", "And {x}, no less.", "{x}, they tell me.", "{x}, of all things.", "Mind, {x}.", "{x}, too."] },
};

/**
 * Weave one extra facet into a line (combination weighting: the richer the situation, the more likely). Facet kinds
 * the recipe already talks about are skipped. Returns the line unchanged when nothing fits.
 */
export function weave(line: string, facets: Facet[], o: { seed: number; skipKinds: string[]; richness?: number }): { text: string; woven: string | null } {
  const r = mulberry32(o.seed ^ 0x5bd1e995);
  const candidates = rankFacets(facets).filter((f) => !o.skipKinds.includes(f.kind) && ASIDES[f.kind]);
  if (!candidates.length) return { text: line, woven: null };
  const chance = Math.min(0.85, 0.25 + 0.12 * (o.richness ?? facets.length));
  if (r() > chance) return { text: line, woven: null };
  const f = candidates[Math.floor(r() * Math.min(2, candidates.length))];
  const pool = ASIDES[f.kind][f.key] ?? ASIDES[f.kind]["*"];
  if (!pool?.length) return { text: line, woven: null };
  const aside = fillLine(pool[Math.floor(r() * pool.length) % pool.length], { x: f.kind === "nickname" ? f.key : f.key.replace(/_/g, " ") });
  const base = /[.!?]$/.test(line) ? line : `${line}.`;
  return { text: `${base} ${aside}`, woven: facetId(f) };
}

/** Speech tics by style word (persona voice.style + personality). */
const TICS: [RegExp, string[]][] = [
  [/\b(gruff|stern|severe|grim|terse)\b/i, ["Hmph. ", "Listen. ", "Right. ", "Look. "]],
  [/\b(chatty|gossip|talkative|warm)\b/i, ["Oh, ", "Well, well. ", "Ooh, ", "Now then, "]],
  [/\b(cheerful|sly|quick|playful)\b/i, ["Heh. ", "Oh-ho! ", "Psst. ", "Well now, "]],
  [/\b(whisper|quiet|hushed|soft)\b/i, ["Shh. ", "Quietly, now. ", "Hush. ", "Between us, "]],
  [/\b(calm|knowing|dry|patient|wise)\b/i, ["Hm. ", "Indeed. ", "Ah. ", "Mm. "]],
  [/\b(booming|pompous|grand|lecturing)\b/i, ["Attend! ", "Mark this: ", "Note well: ", "Ahem. "]],
  [/\b(nervous|timid|anxious|afraid)\b/i, ["Er, ", "Um. ", "S-sorry, ", "Oh dear. "]],
];

/** Add a persona's speech tic now and then (seeded) so the same template sounds like whoever says it. */
export function voiceTic(line: string, persona: { personality?: string; style?: string } | undefined, seed: number): string {
  if (!persona) return line;
  const words = `${persona.style ?? ""} ${persona.personality ?? ""}`;
  const hit = TICS.find(([rx]) => rx.test(words));
  if (!hit) return line;
  const r = mulberry32(hashString(`${seed}:tic`));
  if (r() > 0.4) return line;
  const tic = hit[1][Math.floor(r() * hit[1].length) % hit[1].length];
  if (line.startsWith(tic.trim())) return line;
  const rest = tic.endsWith(", ") ? line.charAt(0).toLowerCase() + line.slice(1) : line;
  return `${tic}${rest}`;
}
