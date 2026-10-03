// Recipes 16-20: time_weather_barks, inn_regular, absence_recap, property_damage, avoided_area.
import type { StoredEvent } from "@liveforge/protocol";
import type { RecipeDef, RecipeRun } from "../kit.js";
import { rumourState } from "../../rumours.js";
import { personaById } from "../../util.js";
import { pRecord } from "../config.js";

const str = (v: unknown) => (typeof v === "string" ? v : "");

// ------------------------------------------------------------------ 16 time_weather_barks

const BEHAVIOUR: Record<string, string[]> = {
  night: ["lamps_lit", "shops_closed", "guards_patrol"], dawn: ["shops_opening", "bells"], dusk: ["lamps_lit", "shops_closing"], day: ["market_open"],
  rain: ["take_shelter", "stalls_covered"], storm: ["take_shelter", "doors_shut", "stalls_covered"], snow: ["fires_lit", "slow_walk"],
  fog: ["stay_close", "lanterns"], heat: ["seek_shade", "water"], clear: ["outdoors"],
};

export const timeWeatherBarks: RecipeDef = {
  id: "time_weather_barks",
  cooldownSec: 180,
  relevant: ["time", "weather"],
  pools: {
    night: ["Late to be wandering, {name}.", "Mind the dark corners.", "Lamps are lit. Honest folk are abed.", "The night has ears, they say.", "Quiet hour, this. I like it.", "You'll catch your death out at this hour."],
    dawn: ["Up with the birds, {name}?", "Sun's barely over the wall.", "Early start? Me too, sadly.", "First light. Best time of day.", "Yawn... is it morning already?", "Dawn again. Where does the night go?"],
    dusk: ["Getting dark. Best get indoors soon.", "Lamplighter'll be round any minute.", "Day's nearly done, {name}.", "Sun's going down on us.", "Evening already? I've done nothing.", "Dusk. The shadows get long."],
    day: ["Fine day for it, {name}.", "Market's busy today.", "Bright and early, eh? Well, bright anyway.", "Lovely day. Make the most of it.", "Sun's high. Busy, busy.", "Good day to you, {name}."],
    rain: ["Raining again. Course it is.", "Get under cover, {name}, you're soaked.", "This rain'll wash the streets clean at least.", "Rain, rain, rain. My roof leaks.", "Mind the puddles, they're deep today.", "Wet enough for you, {name}?"],
    storm: ["Storm's coming in hard. Find a roof.", "Hear that thunder? Gods are angry.", "Lightning! Get away from the tall things.", "Batten everything down, it's a wild one.", "Wind'll have your hat off, {name}.", "Nobody's out in this but fools and you."],
    snow: ["Snow! Watch your footing.", "Cold enough to freeze your ears off.", "Wrap up warm, {name}.", "Snow's settling. It'll be ice by morning.", "Fires are lit. Come and thaw.", "Look at it come down. Beautiful, if you're indoors."],
    fog: ["Can't see your hand in front of your face.", "Fog's thick as porridge.", "Stay close, {name}. Easy to get lost.", "Something's out there in the murk.", "Fog like this hides all sorts.", "Lanterns won't help much in this soup."],
    heat: ["Hot enough to bake bread on the stones.", "Find some shade, {name}, you're red as a beet.", "This heat'll do for us all.", "Drink something before you drop.", "Sun's merciless today.", "Too hot to argue. Too hot to anything."],
    clear: ["Rain's stopped. About time.", "Sky's clearing up nicely.", "There's the sun again!", "Finally, a clear sky.", "Weather's turned fair, {name}.", "Clear skies. Good omen, that."],
  },
  on: {
    "world.time"(run) {
      const t = run.l.time;
      if (!t) return;
      const k = `tw:${run.world}:${run.player}`;
      const prev = run.ctx.kv.get<{ phase: string; weather: string }>(k);
      run.ctx.kv.set(k, { phase: t.phase, weather: t.weather });
      if (prev && prev.phase === t.phase && prev.weather === t.weather) return;
      const weatherChanged = !prev || prev.weather !== t.weather;
      const topic = weatherChanged && (t.weather !== "clear" || prev) ? t.weather : t.phase;
      const payload = { phase: t.phase, weather: t.weather, hour: t.hour, day: t.day, behaviour: [...new Set([...(BEHAVIOUR[t.phase] ?? []), ...(BEHAVIOUR[t.weather] ?? [])])] };
      const npc = run.speakers({ max: 1, salt: topic })[0];
      if (npc && run.ready(npc) && run.def.pools[topic]) run.say(npc, topic, { reason: `${t.phase}, ${t.weather}`, effect: { effect: "behaviour", target: "world", payload } });
      else run.effect("world", "behaviour", payload, { reason: `${t.phase}, ${t.weather}` });
    },
  },
  offer(run) {
    const t = run.l.time;
    if (!t) return null;
    if (t.weather !== "clear" && run.def.pools[t.weather]) return { pool: t.weather, base: 0.35, reason: t.weather };
    if (t.phase !== "day" && run.def.pools[t.phase]) return { pool: t.phase, base: 0.3, reason: t.phase };
    return null;
  },
  note(run) {
    const t = run.l.time;
    return t ? `It is ${t.phase} (hour ${Math.round(t.hour)}), weather: ${t.weather}.` : null;
  },
};

// ------------------------------------------------------------------ 17 inn_regular

function ownerOf(run: RecipeRun, place: string): string | null {
  const owners = pRecord(run.params, "owners");
  if (owners[place] && personaById(run.m, owners[place])) return owners[place];
  return run.m.personas.find((p) => p.zone === place)?.id ?? null;
}

export const innRegular: RecipeDef = {
  id: "inn_regular",
  cooldownSec: 300,
  relevant: ["status"],
  pools: {
    almost: [
      "Back again, {name}? Careful, you'll become a regular.", "Twice in a short while. Getting fond of the place?", "I'm starting to remember your face.",
      "You again! Must like it here.", "Keep coming back and I'll learn your order.", "Second visit. Third's the charm, they say.",
    ],
    welcome: [
      "That makes you a regular, {name}. The usual's on the house tonight.", "Regulars get the good seat. Sit.", "I've started pouring yours when I see you at the door.",
      "Welcome home, {name}. You're one of ours now.", "A regular! {discount} percent off, from now on.", "I've carved your name on the bench. Well, nearly.",
    ],
    familiar: [
      "The usual, {name}?", "There's my regular!", "Your seat's free. Funny, that.",
      "Ah, {name}. Same as always?", "Knew you'd be in about now.", "Don't even need to ask. Here you go.",
    ],
  },
  on: {
    "movement.visited"(run, ev) {
      const place = str(ev.data.place);
      const v = run.l.visits[place];
      const kinds = run.list("kinds", ["inn", "shop", "tavern"]).map((k) => k.toLowerCase());
      if (!place || !v || !kinds.includes(v.kind)) return;
      const need = Math.max(2, run.num("visits", 3));
      const owner = ownerOf(run, place) ?? run.speakers({ max: 1, salt: place })[0] ?? null;
      const speaker = owner ?? "world";
      const discount = run.num("discount", 0.1);
      const flag = `reg:${run.world}:${run.player}:${place}`;
      const regular = !!run.ctx.kv.get<boolean>(flag);
      const vars = { place: run.name(place), discount: Math.round(discount * 100) };
      const payload = { place, owner, visits: v.sessions, discount, perks: ["the_usual", "discount", "reserved_seat"] };
      if (!regular && v.sessions >= need) {
        run.ctx.kv.set(flag, true);
        run.say(speaker, "welcome", { vars, emote: "raise_mug", reason: `${v.sessions} visits to ${vars.place}`, effect: { effect: "regular", payload: { ...payload, first: true } } });
      } else if (regular && run.ready(speaker)) {
        run.say(speaker, "familiar", { vars, emote: "nod", reason: `regular at ${vars.place}`, effect: { effect: "regular", payload: { ...payload, first: false } } });
      } else if (!regular && v.sessions === need - 1 && run.ready(speaker, 120)) {
        run.say(speaker, "almost", { vars, emote: "wave", reason: `${v.sessions} visits to ${vars.place}` });
      }
    },
  },
  offer(run, npc) {
    for (const [place, v] of Object.entries(run.l.visits)) {
      if (v.kind !== "zone" && run.ctx.kv.get<boolean>(`reg:${run.world}:${run.player}:${place}`) && ownerOf(run, place) === npc) {
        return { pool: "familiar", vars: { place: run.name(place), discount: Math.round(run.num("discount", 0.1) * 100) }, base: 0.55, reason: `regular at ${run.name(place)}`, emote: "nod" };
      }
    }
    return null;
  },
  note(run, npc) {
    const places = Object.entries(run.l.visits).filter(([place, v]) => v.kind !== "zone" && ownerOf(run, place) === npc && v.sessions >= 2);
    return places.length ? `They are a regular at your place (${places.map(([p, v]) => `${run.name(p)}: ${v.sessions} visits`).join(", ")}).` : null;
  },
};

// ------------------------------------------------------------------ 18 absence_recap

const away = (ms: number) => (ms >= 48 * 3_600_000 ? `${Math.round(ms / 86_400_000)} days` : `${Math.max(1, Math.round(ms / 3_600_000))} hours`);

export const absenceRecap: RecipeDef = {
  id: "absence_recap",
  cooldownSec: 600,
  relevant: ["status:returning"],
  pools: {
    recap: [
      "{away}, {name}! While you were gone: {recap}", "There you are. {away} away. Here's what you missed: {recap}", "Welcome back. Quickly, then: {recap}",
      "Ah, finally. {away}. Let me catch you up: {recap}", "You've been gone {away}. Much has happened: {recap}", "Back at last! In short: {recap}",
    ],
    welcome_back: [
      "Well, look who's back!", "Thought we'd lost you, {name}.", "Where've you been hiding? It's been {away}.",
      "Long time, {name}. Long time.", "Back from the dead, are we?", "Didn't think we'd see you again.",
    ],
    rumour: [
      "Nobody's seen {player} in {away}.", "{player} vanished for {away}. Where to, nobody knows.", "Some say {player} left for good.",
      "{player}'s been gone {away}. Folk wonder why.", "Has anyone seen {player}? It's been {away}.", "{player} disappeared {away} ago, they say.",
    ],
  },
  on: {
    "session.started"(run) {
      const ms = run.l.session.absenceMs;
      if (ms < run.num("minHours", 6) * 3_600_000) return;
      const companion = run.persona("companion") ?? run.speakers({ max: 1, salt: "recap", anywhere: true })[0] ?? "world";
      // the recap: what changed while they were away (hot rumours, open promises / debts, town mood, nickname)
      const recap: string[] = [];
      const rs = rumourState(run.ctx, run.world).rumours.filter((r) => r.createdAt > run.l.session.startedAt - ms).sort((a, b) => b.heat - a.heat);
      for (const r of rs.slice(0, 2)) recap.push(r.content.replace(/\.$/, ""));
      const due = run.l.promises.filter((p) => p.status === "open");
      if (due.length) recap.push(`you still owe ${run.name(due[0].to)} a promise`);
      if (run.l.mood.turned !== "neutral") recap.push(`the town's been ${run.l.mood.turned === "warm" ? "fond of" : "sour on"} you`);
      if (run.l.nickname) recap.push(`folk still call you ${run.l.nickname.name}`);
      if (!recap.length) recap.push("the place carried on without you, more or less");
      const text = `${recap.slice(0, 3).join("; ")}.`;
      const vars = { away: away(ms), recap: text };
      run.say(companion, "recap", { vars, emote: "wave", reason: `away ${away(ms)}`, effect: { effect: "absence", target: "player", payload: { hours: Math.round(ms / 3_600_000), recap: recap.slice(0, 3), companion } } });
      for (const npc of run.speakers({ max: 2, salt: "welcome_back" }).filter((x) => x !== companion).slice(0, 1)) run.say(npc, "welcome_back", { vars, reason: `away ${away(ms)}` });
      run.rumour("absence", "rumour", { vars: { away: away(ms) }, sentiment: 0, heat: 0.45 });
    },
  },
  offer(run) {
    const ms = run.l.session.absenceMs;
    if (ms < run.num("minHours", 6) * 3_600_000 || run.now - run.l.session.startedAt > 15 * 60_000) return null;
    return { pool: "welcome_back", vars: { away: away(ms) }, base: 0.6, reason: `back after ${away(ms)}`, emote: "wave" };
  },
  note(run) {
    const ms = run.l.session.absenceMs;
    return ms >= 3_600_000 && run.now - run.l.session.startedAt < 30 * 60_000 ? `They just came back after ${away(ms)} away.` : null;
  },
};

// ------------------------------------------------------------------ 19 property_damage

function onDamage(run: RecipeRun, ev: StoredEvent): void {
  const owner = str(ev.data.owner);
  const object = str(ev.data.object) || "property";
  const value = Math.max(0, Number(ev.data.value) || 10);
  if (ev.type === "world.destroyed" && !owner) return;
  const persona = owner && personaById(run.m, owner) ? owner : null;
  const speaker = persona ?? run.speakers({ max: 1, salt: object })[0] ?? "world";
  const recent = run.l.damage.filter((d) => run.now - d.ts < 30 * 60_000);
  const vars = { object, owner: owner ? run.name(owner) : "the owner", amount: Math.round(value), count: recent.length };
  if (persona) {
    run.attitude(persona, -0.15, { text: `They broke my ${object}.`, kind: "harm", salience: 0.8 });
    run.reputation(personaById(run.m, persona)?.faction, -0.03, `broke ${run.name(persona)}'s ${object}`);
  }
  if (recent.length >= run.num("guardsAfter", 3)) {
    const decl = run.m.actions.call_guards;
    const also = decl && persona && (decl.by.includes("world") || personaById(run.m, persona)?.allowedActions?.includes("call_guards") !== false)
      ? [{ kind: "npc.action", target: `npc:${persona}`, args: { npc: persona, action: { action: "call_guards", args: {} } }, why: "" }] : [];
    run.say(speaker, "guards", { vars, emote: "shout", reason: `${recent.length} things broken in 30 min`, effect: { effect: "guards", payload: { owner, object, count: recent.length } }, also });
    return;
  }
  if (run.params.repairQuest !== false && value >= run.num("repairOver", 50)) {
    const quest = run.quest({
      key: `repair:${owner || "town"}:${object}`, giver: persona, title: `Mend the ${object}`.slice(0, 80),
      summary: `You broke ${vars.owner}'s ${object}. Put it right.`, offer: `You broke it, you mend it. Bring what's needed to fix the ${object}.`,
      weight: 0.8, origin: { kind: "npc", ref: run.id },
      objectives: [
        { type: "fetch", target: "any", count: 1, description: `Find materials to mend the ${object}` },
        ...(persona ? [{ type: "talk", target: persona, count: 1, description: `Bring them to ${vars.owner}` }] : []),
      ],
    });
    run.say(speaker, "repair", { vars, emote: "point", reason: `${object} worth ${Math.round(value)}`, effect: { effect: "repair_quest", payload: { owner, object, value, quest: quest?.id ?? null } } });
    return;
  }
  const amount = Math.round(value * run.num("compensationMultiplier", 1));
  run.say(speaker, "bill", { vars: { ...vars, amount }, emote: "hand_out", reason: `${object} worth ${Math.round(value)}`, effect: { effect: "compensation", payload: { owner, object, amount } } });
}

export const propertyDamage: RecipeDef = {
  id: "property_damage",
  cooldownSec: 20,
  relevant: [],
  pools: {
    bill: [
      "My {object}! That's {amount} gold you owe me, {name}.", "You'll pay for that {object}. {amount} gold.", "Who's paying for my {object}? You are. {amount}.",
      "That {object} was my livelihood! {amount} gold, now.", "Oi! {amount} gold for the {object}, or I call the wardens.", "Broke it, bought it. {amount} gold.",
    ],
    repair: [
      "You broke my {object}. You'll help me mend it.", "Don't just stand there. That {object} won't fix itself.", "I can't afford a new {object}. Help me repair it.",
      "You owe me a {object}. Get to work.", "Right. You and me, we're fixing that {object}.", "Bring me what I need to fix the {object}, and we're square.",
    ],
    guards: [
      "That's {count} things smashed! Wardens! Wardens!", "Somebody stop them! Guards!", "Enough! I'm calling the wardens on you, {name}.",
      "Vandal! Guards, over here!", "You've wrecked half the place. The wardens will hear of this.", "That's it. Guards!",
    ],
    grudge: [
      "Still waiting on payment for my {object}.", "Come to break something else, {name}?", "Keep your hands where I can see them.",
      "Mind my things this time.", "You and your clumsy hands.", "I haven't forgotten my {object}.",
    ],
  },
  on: { "world.property_damaged": onDamage, "world.destroyed": onDamage },
  offer(run, npc) {
    const d = [...run.l.damage].reverse().find((x) => x.owner === npc && run.now - x.ts < 30 * 60_000);
    return d ? { pool: "grudge", vars: { object: d.object }, base: 0.6, reason: `broke their ${d.object}`, emote: "glare" } : null;
  },
  note(run, npc) {
    const d = run.l.damage.filter((x) => x.owner === npc);
    return d.length ? `They have broken your property ${d.length} time(s) (last: ${d[d.length - 1].object}).` : null;
  },
};

// ------------------------------------------------------------------ 20 avoided_area

export const avoidedArea: RecipeDef = {
  id: "avoided_area",
  cooldownSec: 900,
  relevant: [],
  pools: {
    pull: [
      "You've never set foot in {area}, have you? Someone should look in there.", "Folk say something's not right in {area}. Go and see?", "{area}... nobody's brave enough. Are you?",
      "I'd pay to know what's going on in {area}.", "You keep avoiding {area}. Afraid of something?", "Strange noises from {area} lately. Fancy a look?",
    ],
    fled_pull: [
      "You ran out of {area} like your boots were on fire. What did you see?", "Whatever chased you out of {area} is still there.", "Going back to {area}? Someone has to.",
      "{area} beat you once. Again?", "They say you fled {area}. Prove them wrong.", "Unfinished business in {area}, {name}.",
    ],
    rumour: [
      "Something lurks in {area}, they say.", "Nobody goes to {area} anymore. Not even {player}.", "Lights in {area} at night. Nobody knows whose.",
      "{area}'s been quiet. Too quiet.", "Folk whisper about {area}. Something's waiting there.", "They say {player} won't go near {area}.",
    ],
    finally: [
      "You finally went to {area}! What's it like?", "Back from {area} in one piece, I see.", "So? What's in {area}?",
      "Brave soul, going into {area}.", "{area} at last. Took you long enough.", "Heard you went to {area}. Well?",
    ],
  },
  tick(run) {
    if (!run.l.firstTs || run.now - run.l.firstTs < run.num("afterMin", 20) * 60_000) return;
    if (!run.readyAny()) return;
    const zones = run.list("zones", run.m.zones.map((z) => z.id)).filter(Boolean);
    const fled = new Set(run.l.flees.map((f) => f.from));
    const avoided = zones.filter((z) => z !== run.l.zone && (!run.l.visits[z] || fled.has(z)));
    if (!avoided.length) return;
    const n = run.l.fired.filter((f) => f.recipe === run.id).length;
    const area = avoided[n % avoided.length];
    const reason = run.l.visits[area] ? "fled from it" : "never visited";
    const vars = { area: run.name(area) };
    run.ctx.kv.set(`avoid:${run.world}:${run.player}:${area}`, true);
    run.rumour(`avoided:${area}`, "rumour", { vars, sentiment: 0, heat: 0.5, truthfulness: 0.6 });
    const giver = run.persona("giver") ?? run.speakers({ max: 1, salt: area })[0] ?? null;
    const quest = run.quest({
      key: `avoided:${area}`, giver, title: `What waits in ${vars.area}`.slice(0, 80), summary: `${vars.area} has gone unvisited too long. Go and see.`,
      offer: `Go and look around ${vars.area}. Tell me what you find.`, weight: 1, origin: { kind: "world", ref: run.id },
      objectives: [{ type: "explore", target: area, count: 1, description: `Explore ${vars.area}` }, ...(giver ? [{ type: "talk", target: giver, count: 1, description: `Report back to ${run.name(giver)}` }] : [])],
    });
    run.say(giver ?? "world", reason === "fled from it" ? "fled_pull" : "pull", { vars, emote: "point", reason: `${vars.area}: ${reason}`, effect: { effect: "avoided_area", target: "world", payload: { area, reason, quest: quest?.id ?? null } } });
  },
  on: {
    "movement.entered_zone": (run, ev) => finallyWent(run, str(ev.data.zone)),
    "movement.visited": (run, ev) => finallyWent(run, str(ev.data.place)),
  },
};

function finallyWent(run: RecipeRun, area: string): void {
  const k = `avoid:${run.world}:${run.player}:${area}`;
  if (!area || !run.ctx.kv.get<boolean>(k)) return;
  run.ctx.kv.delete(k);
  const npc = run.speakers({ max: 1, salt: `finally:${area}`, anywhere: true })[0];
  if (npc) run.say(npc, "finally", { vars: { area: run.name(area) }, emote: "impressed", reason: `went to ${run.name(area)} at last`, cooldownKey: `${run.id}|finally` });
}
