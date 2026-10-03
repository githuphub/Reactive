// Recipes 4, 5, 6, 14, 15: lies_caught, promises_remembered, town_mood, coward_rumour, companion_grief.
import type { StoredEvent } from "@liveforge/protocol";
import { capFirst, fillLine } from "../../../../core/combination/index.js";
import type { RecipeDef, RecipeRun } from "../kit.js";
import { LIB_EVENTS, type LedgerState } from "../state.js";
import { knownRumours } from "../../rumours.js";
import { personaById, safeProjection } from "../../util.js";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const NEGATION = /\b(never|didn'?t|did not|not|no|haven'?t|wasn'?t|isn'?t|nothing|nobody|none)\b/i;
const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 4));

/** Does what the game / world knows contradict this claim? Returns the reason or null. */
export function contradiction(run: RecipeRun, to: string, text: string): string | null {
  const low = text.toLowerCase();
  const model = safeProjection<{ stats?: Record<string, unknown> }>(run.ctx, "observer.player_model", { world: run.world, player: run.player });
  const gold = typeof model?.stats?.gold === "number" ? model.stats.gold : null;
  if (gold !== null && /\b(broke|poor|penniless|no (gold|money|coin)|can'?t afford)\b/.test(low) && gold >= 200) return `they carry ${Math.round(gold)} gold`;
  if (gold !== null && /\b(rich|wealthy|loaded|plenty of (gold|money|coin))\b/.test(low) && gold < 20) return `they have ${Math.round(gold)} gold`;
  if (!NEGATION.test(low)) return null;
  const said = words(low);
  for (const r of knownRumours(run.ctx, run.world, to, { player: run.player, limit: 8 })) {
    if (r.about?.player !== run.player) continue;
    for (const w of words(r.content)) if (said.has(w)) return `the rumour "${r.content.slice(0, 80)}"`;
  }
  return null;
}

// ------------------------------------------------------------------ 4 lies_caught

function onClaim(run: RecipeRun, ev: StoredEvent): void {
  const d = ev.data as Record<string, unknown>;
  const to = str(d.to);
  const text = str(d.text);
  if (!to || !text) return;
  const reason = d.truth === false ? "the game knows it's false" : d.truth === null || d.truth === undefined ? contradiction(run, to, text) : null;
  if (!reason) return;
  run.ctx.record(LIB_EVENTS.caught, { claimTs: ev.ts, to, text: text.slice(0, 200), reason }, { player: run.player });
  run.attitude(to, -run.num("trustDrop", 0.2), { text: `They lied to me: "${text.slice(0, 120)}".`, kind: "harm", salience: 0.8 });
  run.reputation(personaById(run.m, to)?.faction, -run.num("reputationDrop", 0.05), `lied to ${run.name(to)}`);
  run.rumour(`lie:${to}`, "rumour", { vars: { to: run.name(to), claim: text.slice(0, 60) }, sentiment: -0.4, heat: 0.55, knownBy: [to] });
  const payload = { npc: to, claim: text.slice(0, 200), contradictedBy: reason };
  // a claim made in conversation was already called out in the reply itself
  if (d.via === "reply" || !personaById(run.m, to)) run.effect(`npc:${to}`, "lie_caught", payload, { reason, speaker: to });
  else run.say(to, d.truth === false ? "callout" : "callout_rumour", { vars: { claim: text.slice(0, 60) }, emote: "narrow_eyes", reason, effect: { effect: "lie_caught", payload } });
}

export const liesCaught: RecipeDef = {
  id: "lies_caught",
  cooldownSec: 0,
  relevant: ["status:caught_lying", "rumour"],
  pools: {
    callout: [
      "That's a lie and we both know it, {name}.", "Don't spin me tales. I know better.", "Liar. I can see it in your face.",
      "You must think I was born yesterday.", "Funny, that's not how it happened at all.", "I'll remember you said that, {name}. And that it wasn't true.",
    ],
    callout_rumour: [
      "That's not what I heard, {name}.", "Odd. The whole town says otherwise.", "Really? Word around here is different.",
      "Hm. Folk tell a very different story.", "You'd best get your story straight. I've heard the truth.", "Strange. The gossip says the opposite.",
    ],
    remember: [
      "Still telling tales, {name}?", "Going to lie to me again today?", "I've not forgotten your little story.",
      "Mind your tongue. I know what you're like.", "Say what you like. I'll check it twice.", "Ah, my favourite storyteller.",
    ],
    rumour: [
      "{player} was caught lying to {to}.", "{player} told {to} a whopper - \"{claim}\" - and got caught.", "Don't believe a word {player} says. Ask {to}.",
      "{to} caught {player} in a lie.", "{player}'s been spinning tales to {to}.", "They say {player} lied straight to {to}'s face.",
    ],
  },
  on: { "social.claim": onClaim, "social.lied": (run, ev) => {
    const to = str(ev.data.to);
    if (!to || !personaById(run.m, to) || !run.ready(to, 30)) return;
    run.say(to, "callout", { vars: { claim: str(ev.data.about) }, emote: "narrow_eyes", reason: "lied", effect: { effect: "lie_caught", payload: { npc: to, about: str(ev.data.about) } } });
  } },
  offer(run, npc) {
    const c = [...run.l.claims].reverse().find((x) => x.caught && x.to === npc && run.now - x.ts < 60 * 60_000);
    return c ? { pool: "remember", vars: { claim: c.text.slice(0, 60) }, base: 0.6, reason: "caught lying earlier", emote: "narrow_eyes" } : null;
  },
  note(run, npc) {
    const c = [...run.l.claims].reverse().find((x) => x.caught && x.to === npc);
    return c ? `They lied to you earlier ("${c.text.slice(0, 80)}") and you caught it. Your trust is lower.` : null;
  },
};

// ------------------------------------------------------------------ 5 promises_remembered

type Promise_ = LedgerState["promises"][number];
const dueOf = (run: RecipeRun, p: Promise_) => p.due ?? p.made + run.num("defaultDueSec", 900) * 1000;
const inMin = (ms: number) => Math.max(1, Math.round(ms / 60_000));

export const promisesRemembered: RecipeDef = {
  id: "promises_remembered",
  cooldownSec: 60,
  relevant: ["status:owes_promise", "status:debtor"],
  pools: {
    made: [
      "I'll hold you to that, {name}.", "A promise, then. Don't make me regret it.", "Your word. I'll remember it.",
      "Right. \"{promise}\". I've written it down, in a manner of speaking.", "Good. I'll be waiting.", "Promise made. Mind it's kept.",
    ],
    reminder: [
      "Don't forget: \"{promise}\". Time's running short.", "You promised me, {name}. {left} minutes, by my reckoning.", "Tick tock. Your promise, remember?",
      "Still waiting on that promise of yours.", "I hope you haven't forgotten what you said.", "\"{promise}\" - you did say that, didn't you?",
    ],
    kept: [
      "You kept your word. That's rare round here.", "Promise kept! I knew I could trust you, {name}.", "Well done. I won't forget it.",
      "A person of their word. Thank you.", "You did it. Exactly as you said.", "Good as your word, {name}. Good as gold.",
    ],
    broken: [
      "You promised, {name}. You promised.", "So much for your word.", "I trusted you. I won't make that mistake again.",
      "\"{promise}\", you said. Hollow words.", "Don't bother promising me anything again.", "Broken promises have long memories, {name}.",
    ],
    rumour: [
      "{player} broke a promise to {to}.", "Don't take {player}'s word for anything - ask {to}.", "{player} swore to {to}, then didn't deliver.",
      "{to}'s still waiting on {player}'s promise.", "{player} promised {to} the world and gave nothing.", "Word is {player}'s promises aren't worth spit.",
    ],
  },
  on: {
    "social.promise"(run, ev) {
      const p = run.l.promises.find((x) => x.made === ev.ts && x.to === str(ev.data.to));
      if (!p || p.debt) return;
      run.attitude(p.to, 0, { text: `They promised me: "${p.text.slice(0, 120)}".`, kind: "other", salience: 0.75 });
      const payload = { ref: p.ref, npc: p.to, text: p.text, due: p.dueLabel ?? dueOf(run, p) };
      if (ev.data.via === "reply" || !personaById(run.m, p.to)) run.effect(`npc:${p.to}`, "promise_made", payload, { reason: `promise to ${run.name(p.to)}`, speaker: p.to });
      else run.say(p.to, "made", { vars: { promise: p.text.slice(0, 60) }, emote: "nod", reason: `promise: ${p.text.slice(0, 40)}`, effect: { effect: "promise_made", payload } });
    },
    "social.promise_kept"(run, ev) {
      const p = run.l.promises.find((x) => x.status === "kept" && x.resolvedAt === ev.ts);
      if (!p || p.debt) return;
      run.attitude(p.to, run.num("attitudeKept", 0.2), { text: `They kept their promise: "${p.text.slice(0, 120)}".`, kind: "gift", salience: 0.8 });
      if (personaById(run.m, p.to)) run.say(p.to, "kept", { vars: { promise: p.text.slice(0, 60) }, emote: "smile", reason: "promise kept", effect: { effect: "promise_kept", payload: { ref: p.ref, npc: p.to } } });
    },
    "social.promise_broken"(run, ev) {
      const p = run.l.promises.find((x) => x.status === "broken" && x.resolvedAt === ev.ts);
      if (p && !p.debt) breakPromise(run, p, false);
    },
  },
  tick(run) {
    for (const p of run.l.promises) {
      if (p.status !== "open" || p.debt) continue;
      if (p.dueLabel) continue; // the game owns in-game due times (it sends promise_kept / promise_broken)
      const due = dueOf(run, p);
      if (p.due !== null && run.now > due + 60_000) {
        run.ctx.record(LIB_EVENTS.promiseStatus, { ref: p.ref, status: "broken" }, { player: run.player });
        breakPromise(run, p, true);
      } else if (!p.reminded && run.now >= due - run.num("remindBeforeSec", 120) * 1000 && run.now - p.made > 30_000) {
        run.ctx.record(LIB_EVENTS.promiseStatus, { ref: p.ref, reminded: true }, { player: run.player });
        if (personaById(run.m, p.to)) run.say(p.to, "reminder", { vars: { promise: p.text.slice(0, 60), left: inMin(due - run.now) }, emote: "tap_foot", reason: `promise due in ${inMin(due - run.now)} min`, effect: { effect: "promise_reminder", payload: { ref: p.ref, npc: p.to, dueInSec: Math.round((due - run.now) / 1000) } } });
      }
    }
  },
  offer(run, npc) {
    const p = run.l.promises.find((x) => x.status === "open" && x.to === npc && !x.debt && run.now - x.made > 60_000);
    return p ? { pool: "reminder", vars: { promise: p.text.slice(0, 60), left: inMin(dueOf(run, p) - run.now) }, base: 0.55, reason: "open promise", emote: "tap_foot" } : null;
  },
  note(run, npc) {
    const open = run.l.promises.filter((x) => x.to === npc).slice(-3);
    if (!open.length) return null;
    return open.map((p) => `They promised you "${p.text.slice(0, 80)}" - ${p.status === "open" ? (p.dueLabel ? `due ${p.dueLabel}` : `due in ${inMin(dueOf(run, p) - run.now)} min`) : p.status}.`).join(" ");
  },
};

function breakPromise(run: RecipeRun, p: Promise_, auto: boolean): void {
  run.attitude(p.to, -run.num("attitudeBroken", 0.3), { text: `They broke their promise: "${p.text.slice(0, 120)}".`, kind: "harm", salience: 0.85 });
  run.rumour(`broken:${p.ref}`, "rumour", { vars: { to: run.name(p.to) }, sentiment: -0.5, heat: 0.6, knownBy: [p.to] });
  const payload = { ref: p.ref, npc: p.to, text: p.text, auto };
  if (personaById(run.m, p.to)) run.say(p.to, "broken", { vars: { promise: p.text.slice(0, 60) }, emote: "turn_away", reason: auto ? "promise ran out" : "promise broken", effect: { effect: "promise_broken", payload } });
  else run.effect("player", "promise_broken", payload, { reason: "promise broken" });
}

// ------------------------------------------------------------------ 6 town_mood

const MOOD_TYPES = ["social.gave", "world.helped", "social.promise_kept", "quest.completed", "social.threatened", "economy.stole", "social.lied", "world.property_damaged", "social.promise_broken", "social.claim"];

function moodCheck(run: RecipeRun): void {
  const need = Math.max(2, run.num("streak", 3));
  const s = run.l.mood;
  const turn = s.streak >= need ? "warm" : s.streak <= -need ? "cold" : null;
  if (!turn || turn === s.turned) return;
  run.ctx.record(LIB_EVENTS.mood, { turned: turn }, { player: run.player });
  const shift = run.num("reputationShift", 0.05) * (turn === "warm" ? 1 : -1);
  for (const f of run.m.factions) run.reputation(f.id, shift, turn === "warm" ? "kind streak" : "rude streak");
  const price = Math.round((1 + (turn === "warm" ? -1 : 1) * run.num("priceShift", 0.1)) * 100) / 100;
  const speakers = run.speakers({ max: 2, salt: turn, anywhere: true });
  const payload = { mood: turn === "warm" ? 0.5 : -0.5, moodLabel: turn, price_mult: price, streak: Math.abs(s.streak) };
  if (speakers[0]) run.say(speakers[0], turn, { emote: turn === "warm" ? "smile" : "scowl", reason: `${Math.abs(s.streak)} ${turn === "warm" ? "kind" : "rude"} acts in a row`, effect: { effect: "town_mood", payload, target: "world" } });
  else run.effect("world", "town_mood", payload, { reason: `${turn} streak` });
  if (speakers[1]) run.say(speakers[1], `${turn}_bark`, { reason: `town turned ${turn}` });
}

export const townMood: RecipeDef = {
  id: "town_mood",
  cooldownSec: 120,
  relevant: ["status:town_warm", "status:town_cold"],
  pools: {
    warm: [
      "You know, {name}, folk round here are starting to like you.", "Word of your kindness is getting about.", "The whole town's warming to you, {name}.",
      "People are saying good things about you. Keep it up.", "You've been good to us. We notice.", "Funny how a little kindness changes a place, eh?",
    ],
    cold: [
      "People are sick of you, {name}.", "The town's turned against you. Can't say I blame them.", "Folk cross the street when they see you now.",
      "You've made yourself unwelcome here.", "Keep this up and nobody'll sell you so much as a crust.", "Mind yourself. Patience is wearing thin.",
    ],
    warm_bark: [
      "There's our good neighbour!", "Always a pleasure, {name}.", "Folk speak well of you.",
      "Saved you the good seat.", "You're welcome here, {name}.", "Kind deeds don't go unnoticed.",
    ],
    cold_bark: [
      "Hmph. You.", "Move along.", "We know what you've been up to.",
      "Don't expect any favours.", "Prices just went up. For you.", "Nobody wants trouble, {name}.",
    ],
  },
  on: Object.fromEntries(MOOD_TYPES.map((t) => [t, (run: RecipeRun) => moodCheck(run)])),
  offer(run) {
    const t = run.l.mood.turned;
    return t === "warm" || t === "cold" ? { pool: `${t}_bark`, base: 0.4, reason: `town ${t}` } : null;
  },
  note(run) {
    const t = run.l.mood.turned;
    return t === "warm" ? "The town has grown fond of this player lately." : t === "cold" ? "The town has turned against this player lately." : null;
  },
};

// ------------------------------------------------------------------ 14 coward_rumour

function onFlee(run: RecipeRun, ev: StoredEvent): void {
  if (ev.type === "combat.boss_attempt" && str(ev.data.result) !== "fled") return;
  const windowMs = run.num("windowMin", 30) * 60_000;
  const recent = run.l.flees.filter((f) => run.now - f.ts < windowMs);
  if (recent.length < run.num("flees", 3) || !run.readyAny()) return;
  const from = recent[recent.length - 1]?.from || "a fight";
  run.rumour("coward", "rumour", { vars: { from: run.name(from), count: recent.length }, sentiment: -0.4, heat: 0.7 });
  const jeerer = run.speakers({ max: 1, salt: "coward" })[0];
  if (jeerer) run.say(jeerer, "jeer", { vars: { count: recent.length }, emote: "smirk", reason: `${recent.length} flights in ${Math.round(windowMs / 60_000)} min`, effect: { effect: "coward", payload: { flees: recent.length, challenger: false } } });
  const challenger = run.str("challenger", "a bounty hunter");
  run.say("world", "challenger", {
    vars: { challenger }, reason: "coward rumour draws a challenger",
    effect: { effect: "challenger", target: "world", payload: { name: challenger, unit: run.str("challengerUnit", "bounty_hunter"), count: 1, zone: run.l.zone || undefined, flees: recent.length, ...(recent[recent.length - 1]?.from && run.m.bosses.some((b) => b.id === recent[recent.length - 1].from) ? { boss: recent[recent.length - 1].from } : {}) } },
  });
}

export const cowardRumour: RecipeDef = {
  id: "coward_rumour",
  cooldownSec: 900,
  relevant: ["status:coward"],
  pools: {
    jeer: [
      "Running again, {name}? That's {count} times now.", "Look, it's the fastest legs in town.", "Brave as a mouse, you are.",
      "Heard you ran. Again.", "Someone's always got somewhere else to be when the fighting starts.", "Don't worry, {name}. Running's a skill too.",
    ],
    rumour: [
      "{player} ran from {from}. Again.", "{player} has fled {count} fights. Some hero.", "They say {player} turns tail at the first sign of trouble.",
      "Never stand behind {player} in a fight - they'll be gone.", "{player}'s back is the side folk see most.", "{player} ran from {from}, squealing.",
    ],
    challenger: [
      "{challenger} has heard you're a coward, and wants to see for themself.", "Word of your running reached {challenger}. They're coming.",
      "{challenger} is looking for you. Something about cowards and bounties.", "{challenger} steps out of the crowd: \"So you're the runner.\"",
      "A challenge! {challenger} wants to test the town's coward.", "{challenger} has come to collect on the coward's bounty.",
    ],
  },
  on: { "combat.fled": onFlee, "movement.fled": onFlee, "combat.boss_attempt": onFlee },
  offer(run) {
    const n = run.l.flees.filter((f) => run.now - f.ts < run.num("windowMin", 30) * 60_000).length;
    return n >= run.num("flees", 3) ? { pool: "jeer", vars: { count: n }, base: 0.45, reason: `${n} flights`, emote: "smirk" } : null;
  },
  note(run) {
    const n = run.l.flees.filter((f) => run.now - f.ts < 30 * 60_000).length;
    return n >= 2 ? `They have fled ${n} fights recently; some call them a coward.` : null;
  },
};

// ------------------------------------------------------------------ 15 companion_grief

const CLOSE = new Set(["ally", "friend", "family", "mentor", "lover", "employer"]);

export const companionGrief: RecipeDef = {
  id: "companion_grief",
  cooldownSec: 120,
  relevant: ["status:grieving"],
  pools: {
    grief: [
      "{companion}... gone? I can't believe it.", "I'm so sorry, {name}. {companion} deserved better.", "{companion} was the best of us.",
      "Who did this? Who killed {companion}?", "I'll light a candle for {companion} tonight.", "First {companion}, now who? This place...",
    ],
    revenge: [
      "{killer} killed {companion}. Make them pay, {name}.", "Bring me word that {killer} is finished, and I'll rest easier.",
      "{companion} would want justice. {killer} is out there.", "Go after {killer}. For {companion}.",
      "I can't fight, but you can. Avenge {companion}.", "{killer} must answer for {companion}.",
    ],
    condolence: [
      "How are you holding up, {name}?", "I'm sorry about {companion}.", "{companion} talked about you, you know. Fondly.",
      "Take your time. Grief's a heavy pack.", "If you need anything, ask.", "We all miss {companion}.",
    ],
    rumour: [
      "{companion} is dead{by}.", "Terrible news: {companion} fell{by}.", "{player} lost {companion}{by}.",
      "They're mourning {companion}{by}.", "{companion} won't be coming back{by}.", "Black day: {companion} died{by}.",
    ],
  },
  on: {
    "companion.died"(run, ev) {
      const companion = str(ev.data.companion);
      const killer = str(ev.data.killer);
      if (!companion) return;
      const m = run.m;
      const friends = m.relationships.filter((r) => CLOSE.has(r.kind) && (r.a === companion || r.b === companion)).map((r) => (r.a === companion ? r.b : r.a));
      const vars = { companion: run.name(companion), killer: killer ? run.name(killer) : "whoever did it", by: killer ? ` at the hands of ${run.name(killer)}` : "" };
      const mourners = run.speakers({ prefer: friends, max: 3, salt: companion, anywhere: friends.length > 0 }).filter((id) => id !== companion);
      // grief lines are collected into the one grief effect (payload.lines), spoken in turn by the game
      const lines: { npc: string; text: string }[] = [];
      for (const npc of mourners.slice(0, 2)) {
        if (!run.ready(npc)) continue;
        const said = run.say(npc, "grief", { vars, emote: "bow_head", reason: `${vars.companion} died`, silent: true });
        if (said) lines.push({ npc, text: said.text });
      }
      run.rumour(`grief:${companion}`, "rumour", { vars, sentiment: -0.2, heat: 0.7 });
      const giver = run.persona("giver") ?? friends.find((f) => personaById(m, f)) ?? mourners[0];
      let quest = null;
      if (killer && run.params.revengeQuest !== false) {
        const isBoss = m.bosses.some((b) => b.id === killer);
        const offer = capFirst(fillLine(run.def.pools.revenge[Math.floor(run.now / 1000) % run.def.pools.revenge.length] ?? "", { ...vars, name: "friend" }));
        quest = run.quest({
          key: `revenge:${companion}:${killer}`, giver, title: `Avenge ${vars.companion}`.slice(0, 80),
          summary: `${vars.companion} was killed by ${vars.killer}. Settle the score.`,
          offer, weight: 1.6, origin: { kind: "moment", ref: run.id },
          objectives: [{ type: isBoss ? "defeat_boss" : "kill", target: killer, count: 1, description: `Defeat ${vars.killer}` }],
        });
        const rev = giver ? run.say(giver, "revenge", { vars, emote: "clench_fist", reason: `revenge on ${vars.killer}`, silent: true }) : null;
        if (rev && giver) lines.push({ npc: giver, text: rev.text });
      }
      run.effect("world", "grief", { companion, killer: killer || null, lines, mourners: mourners.slice(0, 3), ...(quest ? { quest } : {}) }, { reason: `${vars.companion} died${vars.by}` });
    },
  },
  offer(run) {
    const g = run.l.companions.find((c) => run.now - c.ts < 30 * 60_000);
    return g ? { pool: "condolence", vars: { companion: run.name(g.companion) }, base: 0.65, reason: `mourning ${run.name(g.companion)}`, emote: "bow_head" } : null;
  },
  note(run) {
    const g = run.l.companions.slice(-1)[0];
    return g && run.now - g.ts < 2 * 3_600_000 ? `Their companion ${run.name(g.companion)} died recently${g.killer ? `, killed by ${run.name(g.killer)}` : ""}. Be gentle.` : null;
  },
};
