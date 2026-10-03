// Recipes 1-3: outfit_comments, appearance_state, deed_nicknames.
import type { StoredEvent } from "@liveforge/protocol";
import type { RecipeDef, RecipeRun } from "../kit.js";
import { outfitPieces } from "../facets.js";
import { LIB_EVENTS } from "../state.js";
import { humanise, rngFrom } from "../../util.js";

const str = (v: unknown) => (typeof v === "string" ? v : "");

// ------------------------------------------------------------------ 1 outfit_comments

/** What to talk about: the piece just equipped (or the most notable worn piece) and its colour / style. */
function outfitTopic(run: RecipeRun, ev?: StoredEvent) {
  const pieces = outfitPieces(run.l);
  const slot = ev?.type === "gear.equipped" ? str(ev.data.slot) || "weapon" : "";
  const piece = (slot && pieces.find((p) => p.slot === slot)) || pieces[0];
  if (!piece) return null;
  const colour = piece.colors[0] ?? pieces.find((p) => p.colors.length)?.colors[0] ?? "";
  const style = run.l.outfit?.styleTags[0] ?? piece.tags.find((t) => !/^(common|uncommon|rare|epic|legendary)$/i.test(t)) ?? "";
  const pool = piece.slot === "weapon" || piece.slot === "offhand" ? "weapon" : colour ? "colour" : style ? "style" : "item";
  return { pool, vars: { item: piece.name, colour: colour.toLowerCase(), style: humanise(style).toLowerCase(), slot: piece.slot }, reason: `${piece.name}${colour ? ` (${colour.toLowerCase()})` : ""}` };
}

export const outfitComments: RecipeDef = {
  id: "outfit_comments",
  cooldownSec: 90,
  relevant: ["gear", "color", "style"],
  pools: {
    item: [
      "That {item} suits you, {name}.", "New {item}? Where'd you find that?", "Is that a {item}? Fancy.",
      "{item}, eh? Somebody's dressing up.", "Never seen a {item} quite like that.", "I'd give a week's wages for that {item}.",
      "Hold still, let me look at that {item}.",
    ],
    colour: [
      "All that {colour}! Can't miss you across the yard.", "{colour} suits you, {name}.", "Bold choice, wearing {colour} round here.",
      "That {colour} {item} catches the eye.", "{colour}? Folk'll think you're royalty.", "Bit loud, all that {colour}, isn't it?",
    ],
    style: [
      "Going for the {style} look, are we?", "Very {style}. Very you.", "{style}, is it? It's a look.",
      "Somebody's feeling {style} today.", "That's a {style} get-up if ever I saw one.", "Bit {style} for round here, isn't it?",
    ],
    weapon: [
      "Careful where you point that {item}.", "That {item} looks like it bites.", "Mind you don't take an eye out with that {item}.",
      "Forged that {item} yourself, did you?", "A {item}? Hope you know which end is which.", "Keep that {item} sheathed in here, please.",
    ],
  },
  on: {
    "appearance.outfit": (run, ev) => commentOutfit(run, ev),
    "gear.equipped": (run, ev) => commentOutfit(run, ev),
  },
  offer(run) {
    if (!run.l.outfit || run.now - run.l.outfit.ts > 10 * 60_000) return null;
    const t = outfitTopic(run);
    return t ? { pool: t.pool, vars: t.vars, base: 0.55, reason: t.reason, emote: "look" } : null;
  },
  note(run) {
    const p = outfitPieces(run.l).slice(0, 3).map((x) => `${x.name}${x.colors[0] ? ` (${x.colors[0]})` : ""}`);
    return p.length ? `They are wearing: ${p.join(", ")}.` : null;
  },
};

function commentOutfit(run: RecipeRun, ev: StoredEvent): void {
  const t = outfitTopic(run, ev);
  if (!t) return;
  const max = Math.max(1, Math.min(3, run.num("maxSpeakers", 2)));
  let n = 0;
  for (const npc of run.speakers({ salt: t.vars.item })) {
    if (n >= max) break;
    if (!run.ready(npc) || !run.roll(`${npc}:${t.vars.item}`)) continue;
    if (run.say(npc, t.pool, { vars: t.vars, emote: "look", reason: t.reason })) n++;
  }
}

// ------------------------------------------------------------------ 2 appearance_state

const STATES = ["bloodied", "wet", "burnt", "muddy"] as const;

function dominantState(run: RecipeRun): { state: (typeof STATES)[number]; level: number } | null {
  const th = run.num("threshold", 0.5);
  let best: { state: (typeof STATES)[number]; level: number } | null = null;
  for (const s of STATES) {
    const v = run.l.appearance[s];
    if (v >= th && (!best || v > best.level)) best = { state: s, level: v };
  }
  return best;
}

export const appearanceState: RecipeDef = {
  id: "appearance_state",
  cooldownSec: 60,
  relevant: ["appearance"],
  pools: {
    bloodied: [
      "You're bleeding all over the place, {name}.", "Gods, is that your blood?", "Sit down before you fall down.",
      "Someone's had a rough fight.", "You look half-dead, {name}.", "Get that wound seen to, quick.",
    ],
    wet: [
      "You're soaked to the bone, {name}.", "Fall in the fountain, did you?", "Don't drip on my floor.",
      "Wet as a drowned rat.", "Dry yourself off before you catch a chill.", "Been swimming in your clothes again?",
    ],
    burnt: [
      "You smell like a forge fire, {name}.", "Your sleeve's still smoking!", "Singed your eyebrows, did you?",
      "Playing with fire again?", "There's soot all over you.", "You look half-roasted, {name}.",
    ],
    muddy: [
      "You're tracking mud everywhere, {name}.", "Wipe your boots, for pity's sake.", "Rolled in a ditch, did you?",
      "Mud up to your knees. Lovely.", "You'll want a bath before supper.", "Been crawling through the bog, {name}?",
    ],
    healer: [
      "Come here, let me bind that cut.", "Hold still, {name}. I've bandages.", "You'll bleed out at this rate. Sit.",
      "Here, press this to it.", "Let me patch you up before you drop.", "I've a salve for that. Don't argue.",
    ],
  },
  on: {
    "appearance.state"(run) {
      const d = dominantState(run);
      if (!d) return;
      const key = `${run.id}|${d.state}`;
      const healer = d.state === "bloodied" ? run.persona("healer") : null;
      for (const npc of run.speakers({ prefer: [healer], max: 3, salt: d.state })) {
        if (!run.ready(npc, run.cooldownSec(), `${key}|${npc}`) || !run.roll(`${npc}:${d.state}`)) continue;
        const helping = npc === healer;
        run.say(npc, helping ? "healer" : d.state, {
          vars: { state: d.state }, emote: helping ? "kneel" : "stare", reason: `${d.state} ${d.level.toFixed(2)}`, cooldownKey: `${key}|${npc}`,
          ...(helping ? { effect: { effect: "concern", payload: { state: d.state, level: d.level, offer: "bandage" } } } : {}),
        });
        return;
      }
    },
  },
  offer(run) {
    const d = dominantState(run);
    return d ? { pool: d.state, base: 0.6, reason: `${d.state} ${d.level.toFixed(2)}`, emote: "stare" } : null;
  },
  note(run) {
    const d = dominantState(run);
    return d ? `They look ${d.state === "wet" ? "soaked" : d.state} right now.` : null;
  },
};

// ------------------------------------------------------------------ 3 deed_nicknames

const NICKS: Record<string, string[]> = {
  flawless: ["Untouched", "the Unscratched", "Clean-Hands", "the Ghost", "Not-A-Scratch", "Silkstep"],
  coward: ["Quickheels", "the Hare", "Runaway", "Dust-Heels", "the Bolter", "Back-Door"],
  thief: ["Sticky Fingers", "Lightfoot", "Magpie", "the Purse-Cutter", "Quickhand", "Velvet Glove"],
  wrecker: ["Wrecking Ball", "the Breaker", "Crockery Bane", "Bull-in-the-Hall", "Smash", "Hammerfall"],
  generous: ["Open-Hand", "the Generous", "Goldheart", "Soft-Purse", "the Kind", "Copper-Saint"],
  stubborn: ["Back-Again", "the Stubborn", "the Undying", "Ninelives", "Never-Learns", "Grave-Dodger"],
  lucky: ["Hair's-Breadth", "Lucky", "Last-Gasp", "the Narrow", "Close-Shave", "Death-Cheat"],
  comeback: ["the Comeback", "Never-Down", "Second-Wind", "the Rally", "Up-Again", "Turnabout"],
};

function slayerNames(boss: string): string[] {
  const word = boss.split(/\s+/).filter((w) => !/^(the|of|a)$/i.test(w)).pop() ?? "Giant";
  const w = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  return [`${w}breaker`, `${w}bane`, `${w}-Feller`, `the ${w}slayer`, `${w}'s End`, `${w}-Tamer`];
}

/** A deed worth a nickname, from one event (null = not notable enough). */
function deedOf(run: RecipeRun, ev: StoredEvent): { kind: string; text: string; names: string[] } | null {
  const d = ev.data as Record<string, unknown>;
  const l = run.l;
  switch (ev.type) {
    case "lf.observer.moment": {
      const kind = str((d.moment as { kind?: unknown } | undefined)?.kind);
      if (kind === "flawless_phase") return { kind: "flawless", text: "a flawless fight", names: NICKS.flawless };
      if (kind === "near_death_escape") return { kind: "lucky", text: "escaping death by a hair", names: NICKS.lucky };
      if (kind === "comeback") return { kind: "comeback", text: "a last-gasp comeback", names: NICKS.comeback };
      return null;
    }
    case "combat.killed": {
      const target = str(d.target);
      const boss = run.m.bosses.find((b) => b.id === target);
      if (boss || d.boss === true) return { kind: `slayer:${target}`, text: `bringing down ${run.name(target)}`, names: slayerNames(boss?.name ?? humanise(target)) };
      return null;
    }
    case "combat.boss_attempt": {
      const boss = str(d.boss);
      const b = l.bosses[boss];
      if (str(d.result) === "won") return { kind: `slayer:${boss}`, text: `beating ${run.name(boss)}`, names: slayerNames(run.name(boss)) };
      if (b && b.deaths >= 4) return { kind: "stubborn", text: `${b.deaths} tries at ${run.name(boss)}`, names: NICKS.stubborn };
      return null;
    }
    case "combat.phase_flawless": return { kind: "flawless", text: `a flawless phase against ${run.name(str(d.boss))}`, names: NICKS.flawless };
    case "combat.fled":
    case "movement.fled":
      return l.flees.filter((f) => run.now - f.ts < 30 * 60_000).length >= 3 ? { kind: "coward", text: "running from every fight", names: NICKS.coward } : null;
    case "economy.stole": return d.seen === false ? null : { kind: "thief", text: "light fingers", names: NICKS.thief };
    case "world.property_damaged": return l.damage.filter((x) => run.now - x.ts < 30 * 60_000).length >= 2 ? { kind: "wrecker", text: "breaking things", names: NICKS.wrecker } : null;
    case "social.gave": return (typeof d.gold === "number" && d.gold >= 50) || d.item ? { kind: "generous", text: "giving freely", names: NICKS.generous } : null;
  }
  return null;
}

function coin(run: RecipeRun, ev: StoredEvent): void {
  const deed = deedOf(run, ev);
  if (!deed) return;
  const cur = run.l.nickname;
  if (cur && (cur.deed === deed.kind || run.now - cur.ts < run.num("minGapSec", 300) * 1000)) return;
  const r = rngFrom(`${run.player}:${deed.kind}:${run.l.fired.length}`);
  const name = deed.names[Math.floor(r() * deed.names.length) % deed.names.length];
  if (cur?.name === name) return;
  run.ctx.record(LIB_EVENTS.nickname, { name, deed: deed.kind }, { player: run.player });
  const speaker = run.speakers({ salt: name, max: 1 })[0];
  if (speaker) run.say(speaker, "coin", { vars: { nick: name, deed: deed.text }, emote: "grin", reason: `${name} for ${deed.text}`, effect: { effect: "nickname", payload: { nickname: name, deed: deed.kind, because: deed.text } } });
  else run.effect("player", "nickname", { nickname: name, deed: deed.kind, because: deed.text }, { reason: `${name} for ${deed.text}` });
  run.rumour(`nick:${name}`, "rumour", { vars: { nick: name, deed: deed.text }, sentiment: deed.kind === "coward" || deed.kind === "thief" || deed.kind === "wrecker" ? -0.3 : 0.3, heat: 0.65 });
}

export const deedNicknames: RecipeDef = {
  id: "deed_nicknames",
  cooldownSec: 300,
  relevant: ["nickname"],
  pools: {
    coin: [
      "After {deed}? You're {nick} now, like it or not.", "From now on I'm calling you {nick}.", "{nick}! That's what they'll call you after {deed}.",
      "Ha! {nick}, that's you. {deed}, honestly.", "There goes {nick}. Has a ring to it.", "We've a name for you now: {nick}.",
    ],
    use: [
      "Morning, {nick}!", "If it isn't {nick}, large as life.", "Oi, {nick}! Over here.",
      "Well, well. {nick} in the flesh.", "Make way for {nick}!", "Look who it is. {nick}.",
      "{nick}! Done anything worth a new name today?",
    ],
    rumour: [
      "They're calling {player} \"{nick}\" now, after {deed}.", "Heard the new name? \"{nick}\". Earned it by {deed}, they say.",
      "Everyone's saying \"{nick}\" since {deed}.", "\"{nick}\" - that's what folk call {player} these days.",
      "Some wag started calling {player} \"{nick}\". It stuck.", "Ask anyone about \"{nick}\". It's {player}, after {deed}.",
    ],
  },
  on: {
    "lf.observer.moment": coin, "combat.killed": coin, "combat.boss_attempt": coin, "combat.phase_flawless": coin,
    "combat.fled": coin, "movement.fled": coin, "economy.stole": coin, "world.property_damaged": coin, "social.gave": coin,
  },
  offer(run) {
    const n = run.l.nickname;
    return n ? { pool: "use", vars: { nick: n.name }, base: 0.45, reason: `nickname ${n.name}`, emote: "wave" } : null;
  },
  note(run) {
    const n = run.l.nickname;
    return n ? `Around town they call this player "${n.name}". You may use it.` : null;
  },
};
