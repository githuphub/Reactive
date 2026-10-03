// Recipes 7-10: rich_attention, broke_support, collector_interest, haggle_memory.
import { actionsFor } from "@liveforge/manifest";
import type { PlayerModel } from "@liveforge/protocol";
import type { RecipeDef, RecipeRun } from "../kit.js";
import { outfitPieces } from "../facets.js";
import { LIB_EVENTS } from "../state.js";
import { traitAt } from "../../../observer/view.js";
import { personaById, safeProjection } from "../../util.js";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const r2 = (v: number) => Math.round(v * 100) / 100;

function wealth(run: RecipeRun): { gold: number | null; rich: number; broke: number } {
  const model = safeProjection<PlayerModel>(run.ctx, "observer.player_model", { world: run.world, player: run.player });
  const gold = typeof model?.stats?.gold === "number" ? model.stats.gold : null;
  return { gold, rich: model ? traitAt(model, "rich", run.now, run.m) : 0, broke: model ? traitAt(model, "broke", run.now, run.m) : 0 };
}

/** May this persona perform the action (declared + allowed, or world-emittable)? */
function canAct(run: RecipeRun, npc: string | null, action: string): npc is string {
  if (!npc) return false;
  const decl = run.m.actions[action];
  return !!decl && (actionsFor(run.m, npc).includes(action) || decl.by.includes("world"));
}

/** The n-th option in a seeded rotation, so the same attention never comes twice in a row. */
function rotate<T>(run: RecipeRun, options: T[]): T {
  const n = run.l.fired.filter((f) => f.recipe === run.id).length;
  return options[n % options.length];
}

// ------------------------------------------------------------------ 7 rich_attention

function isRich(run: RecipeRun): { yes: boolean; gold: number } {
  const w = wealth(run);
  const gold = w.gold ?? 0;
  return { yes: (w.gold !== null && gold >= run.num("gold", 500)) || w.rich >= run.num("trait", 0.6), gold };
}

function richCheck(run: RecipeRun): void {
  const { yes, gold } = isRich(run);
  if (!yes || !run.readyAny() || !run.roll(`rich:${Math.floor(run.now / 60_000)}`)) return;
  const kind = rotate(run, ["pickpocket", "beggar", "price_gouge", "tax"] as const);
  const reason = `${Math.round(gold)} gold on show`;
  if (kind === "pickpocket") {
    const thief = run.persona("pickpocket") ?? run.m.personas.find((p) => actionsFor(run.m, p.id).includes("steal"))?.id ?? null;
    const amount = Math.max(1, Math.min(Math.round(gold * 0.25), run.num("stealGold", 50)));
    const also = canAct(run, thief, "steal") ? [{ kind: "npc.action", target: `npc:${thief}`, args: { npc: thief, action: { action: "steal", args: { gold: amount } } }, why: "" }] : [];
    if (thief) run.say(thief, "pickpocket", { vars: { gold: amount }, emote: "sly", reason, effect: { effect: "pickpocket", payload: { thief, gold: amount } }, also });
    else run.say("world", "pickpocket_world", { vars: { gold: amount }, reason, effect: { effect: "pickpocket", payload: { thief: null, gold: amount } } });
  } else if (kind === "beggar") {
    const beggar = run.persona("beggar");
    const ask = Math.max(1, Math.min(20, Math.round(gold * 0.02)));
    run.say(beggar ?? "world", "beggar", { vars: { ask }, emote: "plead", reason, effect: { effect: "beggar", payload: { beggar, ask } } });
  } else if (kind === "price_gouge") {
    const merchant = run.persona("merchant") ?? run.speakers({ max: 4, salt: "gouge" }).find((id) => actionsFor(run.m, id).includes("trade")) ?? null;
    const mult = r2(Math.min(run.m.clamps.npc.priceMultiplier[1], 1.25 + (gold / 5000) * 0.25));
    const also = canAct(run, merchant, "trade") ? [{ kind: "npc.action", target: `npc:${merchant}`, args: { npc: merchant, action: { action: "trade", args: { priceMultiplier: mult } } }, why: "" }] : [];
    run.say(merchant ?? "world", "gouge", { vars: { mult: Math.round((mult - 1) * 100) }, emote: "grin", reason, effect: { effect: "price_gouge", payload: { merchant, multiplier: mult } }, also });
  } else {
    const collector = run.persona("taxCollector");
    const amount = Math.max(1, Math.round((gold * run.num("taxPct", 10)) / 100));
    run.say(collector ?? "world", "tax", { vars: { tax: amount }, emote: "ledger", reason, effect: { effect: "tax", payload: { collector, amount } } });
  }
}

export const richAttention: RecipeDef = {
  id: "rich_attention",
  cooldownSec: 300,
  relevant: ["trait:rich"],
  pools: {
    pickpocket: [
      "Pardon me, {name} - dropped something? No? My mistake.", "Ooh, sorry, clumsy me. Lovely purse, that.", "Crowded today, isn't it? Mind your pockets.",
      "Bumped you, did I? Terribly sorry, {name}.", "What a lovely heavy purse. Was, anyway.", "Busy, busy! Don't mind me.",
    ],
    pickpocket_world: [
      "Someone brushed past {name} in the crowd. The purse feels {gold} gold lighter.", "A cutpurse slips away with {gold} of {name}'s gold.",
      "Quick fingers, a tug at the belt: {gold} gold gone.", "{name}'s purse is lighter by {gold}. Nobody saw a thing.",
      "A grubby hand, a flash of a smile, and {gold} gold vanishes.", "The crowd closes in; when it parts, {gold} gold is missing.",
    ],
    beggar: [
      "Spare a coin, {name}? Just {ask}, for bread.", "You've so much, and I've so little. {ask} gold?", "Bless you, kind stranger. A coin or two?",
      "Just {ask} gold, {name}. You'd never miss it.", "Please. My children haven't eaten.", "A rich one! Spare a little for an old soul?",
    ],
    gouge: [
      "For you? Prices are up {mult} percent. Special customer.", "Ah, a wealthy patron! Everything's a little dearer today.", "Quality costs, {name}. And you can afford quality.",
      "New prices, just in. You won't mind, I'm sure.", "Rich folk pay rich prices. That's the law of the market.", "Funny how prices rise when a full purse walks in.",
    ],
    tax: [
      "Tax day, {name}. {tax} gold, by the academy's reckoning.", "The ledger says you owe {tax} gold. Pay up.", "Wealth like yours attracts the tax man. {tax} gold, please.",
      "Duty and levy, {name}. {tax} gold.", "Don't look at me like that. {tax} gold, it's the rules.", "Your fortune's been noticed. {tax} gold to the treasury.",
    ],
    noticed: [
      "Heavy purse, {name}.", "Somebody's doing well for themselves.", "Coin's jingling, {name}. Folk notice.",
      "Careful flashing that gold about.", "Rich as a duke, you are.", "Mind the cutpurses, {name}. They can smell gold.",
    ],
  },
  on: { "economy.gold": richCheck, "economy.bought": richCheck, "movement.entered_zone": richCheck, "movement.visited": richCheck },
  tick: richCheck,
  offer(run) {
    return isRich(run).yes ? { pool: "noticed", base: 0.4, reason: "rich", emote: "eye" } : null;
  },
  note(run) {
    const r = isRich(run);
    return r.yes ? `They are carrying a lot of gold (${Math.round(r.gold)}).` : null;
  },
};

// ------------------------------------------------------------------ 8 broke_support

function isBroke(run: RecipeRun): boolean {
  const w = wealth(run);
  return (w.gold !== null && w.gold <= run.num("gold", 20)) || w.broke >= 0.6;
}

const openDebt = (run: RecipeRun) => run.l.promises.find((p) => p.status === "open" && !!p.debt);

function brokeCheck(run: RecipeRun): void {
  if (!isBroke(run) || openDebt(run) || !run.readyAny() || !run.roll(`broke:${Math.floor(run.now / 60_000)}`)) return;
  const kind = rotate(run, ["charity", "loan"] as const);
  if (kind === "charity") {
    const giver = run.speakers({ max: 1, salt: "charity" })[0] ?? "world";
    const gold = run.num("charityGold", 10);
    run.say(giver, "charity", { vars: { gold }, emote: "offer", reason: "player is broke", effect: { effect: "charity", payload: { giver, gold } } });
  } else {
    const lender = run.persona("loanShark");
    const amount = run.num("loanAmount", 100);
    const owed = Math.round(amount * (1 + run.num("interestPct", 25) / 100));
    const dueSec = run.num("dueSec", 900);
    const ref = `loan_${run.now.toString(36)}`;
    run.say(lender ?? "world", "loan", {
      vars: { amount, owed, mins: Math.round(dueSec / 60) }, emote: "lean_in", reason: "player is broke",
      effect: { effect: "loan_offer", payload: { ref, lender, amount, owed, interestPct: run.num("interestPct", 25), dueSec, accept: { signal: "social.promise", data: { to: lender ?? "lender", text: `repay ${owed} gold`, ref, due: dueSec, owed } } } },
    });
  }
}

export const brokeSupport: RecipeDef = {
  id: "broke_support",
  cooldownSec: 600,
  relevant: ["trait:broke", "status:debtor"],
  pools: {
    charity: [
      "Here, {name}. {gold} gold. Pay it forward someday.", "You look like you could use this. No, take it.", "Times are hard. Take {gold} gold and get something hot to eat.",
      "I was broke once too. Here.", "Don't be proud, {name}. Take the coin.", "A little something to tide you over.",
    ],
    loan: [
      "Short of coin? I can lend you {amount}. You'll owe me {owed}, in {mins} minutes.", "{amount} gold, right now, no questions. {owed} back. Deal?",
      "Everyone needs a friend with money, {name}. {amount} now, {owed} later.", "I like to help. {amount} gold. Pay me {owed} and we stay friends.",
      "Broke? Not for long. {amount} gold at very reasonable interest.", "Sign here, {name}. {amount} now. {owed} when I come knocking.",
    ],
    debt_due: [
      "Tick tock, {name}. {owed} gold, soon.", "Your debt's due. Don't make me ask twice.", "I hope you've got my {owed} gold.",
      "Remember our little arrangement? It's nearly time.", "Counting the minutes till you pay me, {name}.", "{owed} gold. You do remember?",
    ],
    debt_collector: [
      "Time's up. My friends will collect.", "You missed your payment, {name}. That was a mistake.", "Nobody stiffs me. Nobody.",
      "I warned you. Now it's the hard way.", "Late payment means a visit from the lads.", "You owe {owed}. Now you owe interest on the interest.",
    ],
    debt_paid: [
      "Paid in full. Pleasure doing business.", "Every coin. I knew you were good for it.", "Debt cleared. Come back any time, {name}.",
      "On time, too! You're my favourite customer.", "That's that, then. No hard feelings.", "Paid up. Shame, I liked having you owe me.",
    ],
    pity: [
      "Pockets empty again, {name}?", "Rough times, eh?", "Can't buy much with lint, can you?",
      "Poor thing. Keep your chin up.", "Coin's tight for all of us.", "Need work? Ask around, there's always errands.",
    ],
  },
  on: {
    "economy.gold": brokeCheck,
    "social.promise_kept"(run, ev) {
      const p = run.l.promises.find((x) => x.status === "kept" && x.resolvedAt === ev.ts && !!x.debt);
      if (!p) return;
      run.attitude(p.to, 0.15, { text: `They repaid their debt of ${p.debt} gold.`, kind: "trade", salience: 0.6 });
      run.say(personaById(run.m, p.to) ? p.to : "world", "debt_paid", { vars: { owed: p.debt }, emote: "count_coins", reason: "debt repaid", effect: { effect: "debt_due", payload: { ref: p.ref, paid: true } } });
    },
  },
  tick(run) {
    brokeCheck(run);
    const p = openDebt(run);
    if (!p) return;
    const due = p.due ?? p.made + run.num("dueSec", 900) * 1000;
    const lender = personaById(run.m, p.to) ? p.to : "world";
    if (run.now > due + 30_000) {
      run.ctx.record(LIB_EVENTS.promiseStatus, { ref: p.ref, status: "broken" }, { player: run.player });
      run.attitude(p.to, -0.4, { text: `They never paid back ${p.debt} gold.`, kind: "harm", salience: 0.9 });
      run.say(lender, "debt_collector", { vars: { owed: p.debt }, emote: "crack_knuckles", reason: "debt overdue", effect: { effect: "debt_collector", payload: { ref: p.ref, lender: p.to, owed: p.debt } } });
    } else if (!p.reminded && run.now >= due - 120_000) {
      run.ctx.record(LIB_EVENTS.promiseStatus, { ref: p.ref, reminded: true }, { player: run.player });
      run.say(lender, "debt_due", { vars: { owed: p.debt }, emote: "tap_foot", reason: "debt due soon", effect: { effect: "debt_due", payload: { ref: p.ref, owed: p.debt, dueInSec: Math.round((due - run.now) / 1000) } } });
    }
  },
  offer(run, npc) {
    const d = openDebt(run);
    if (d && d.to === npc) return { pool: "debt_due", vars: { owed: d.debt }, base: 0.55, reason: "owes a debt", emote: "tap_foot" };
    return isBroke(run) ? { pool: "pity", base: 0.35, reason: "broke" } : null;
  },
  note(run, npc) {
    const d = openDebt(run);
    if (d && d.to === npc) return `They owe you ${d.debt} gold.`;
    return isBroke(run) ? "They are broke." : null;
  },
};

// ------------------------------------------------------------------ 9 collector_interest

function collectable(run: RecipeRun): { id: string; name: string; tag: string } | null {
  const tags = run.list("tags", ["legendary", "rare", "epic", "unique", "artifact"]).map((t) => t.toLowerCase());
  for (const p of outfitPieces(run.l)) {
    const tag = p.tags.find((t) => tags.includes(t.toLowerCase())) ?? (/\blegendary\b/i.test(p.name) ? "legendary" : "");
    if (tag) return { id: p.id, name: p.name, tag: tag.toLowerCase() };
  }
  return null;
}

function collectorCheck(run: RecipeRun): void {
  const item = collectable(run);
  if (!item || run.l.collected[item.id] || !run.readyAny(60)) return;
  const collector = run.persona("collector");
  const gold = Math.round(run.num("offerGold", 400) * (item.tag === "legendary" ? 2 : item.tag === "epic" ? 1.5 : 1));
  run.ctx.record(LIB_EVENTS.collector, { item: item.id, name: item.name, offeredAt: run.now }, { player: run.player });
  run.say(collector ?? "world", "offer", { vars: { item: item.name, gold }, emote: "appraise", reason: `${item.tag} ${item.name}`, effect: { effect: "collector_offer", payload: { collector, item: item.id, itemName: item.name, gold, tag: item.tag } } });
}

export const collectorInterest: RecipeDef = {
  id: "collector_interest",
  cooldownSec: 300,
  relevant: ["gear"],
  pools: {
    offer: [
      "Is that {item}? I'll give you {gold} gold for it. Today only.", "{gold} gold for the {item}, {name}. Name your terms.", "A collector knows quality. {item}... {gold} gold?",
      "I've waited years to see a {item}. {gold} gold, cash.", "Sell me the {item}. {gold} gold, and my eternal gratitude.", "Forgive me staring. That {item}. {gold} gold?",
    ],
    theft: [
      "Someone's been following {name} since the collector's offer...", "A shadow lunges for the {item}!", "\"The {item}, quick!\" - a thief makes a grab for it.",
      "Hands in the dark, reaching for the {item}.", "The {item} draws the wrong sort of attention: a thief strikes.", "A hooded figure bumps {name} and grabs at the {item}.",
    ],
    admire: [
      "That {item} is something special, {name}.", "Folk would kill for a {item} like that.", "Keep that {item} close.",
      "Is that... a real {item}?", "Never thought I'd see a {item} up close.", "Mind who sees that {item}, {name}.",
    ],
  },
  on: { "appearance.outfit": collectorCheck, "gear.equipped": collectorCheck },
  tick(run) {
    const after = run.num("theftAfterSec", 300) * 1000;
    const worn = new Set(outfitPieces(run.l).map((p) => p.id));
    for (const [id, c] of Object.entries(run.l.collected)) {
      if (c.theftAt !== null || run.now - c.offeredAt < after || !worn.has(id)) continue;
      const thief = run.persona("thief");
      run.ctx.record(LIB_EVENTS.collector, { item: id, theftAt: run.now }, { player: run.player });
      run.say(thief ?? "world", "theft", { vars: { item: c.name }, emote: "lunge", reason: `${c.name} still carried after the offer`, effect: { effect: "theft_attempt", payload: { thief, item: id, itemName: c.name } } });
      return;
    }
  },
  offer(run) {
    const item = collectable(run);
    return item ? { pool: "admire", vars: { item: item.name }, base: 0.5, reason: `${item.tag} ${item.name}`, emote: "stare" } : null;
  },
  note(run) {
    const item = collectable(run);
    return item ? `They carry a ${item.tag} item: ${item.name}.` : null;
  },
};

// ------------------------------------------------------------------ 10 haggle_memory

function haggleMult(run: RecipeRun, npc: string): number {
  const h = run.l.haggles[npc];
  if (!h) return 1;
  const step = run.num("step", 0.05);
  return r2(Math.max(0.8, Math.min(1.4, 1 + step * (h.won - h.lost))));
}

export const haggleMemory: RecipeDef = {
  id: "haggle_memory",
  cooldownSec: 20,
  relevant: [],
  pools: {
    first_won: [
      "Fine, fine. You drive a hard bargain, {name}.", "You'll ruin me. But a deal's a deal.", "Hmph. I'll remember this, haggler.",
      "Robbery! But fair robbery.", "Well bargained. Don't expect it twice.", "You've done this before, haven't you?",
    ],
    first_lost: [
      "Ha! My price stands. Better luck next time.", "Nice try, {name}. Full price.", "I didn't get where I am by giving discounts.",
      "Nope. But I admire the effort.", "Full price, and smile while you pay it.", "You'll have to get up earlier than that.",
    ],
    repeat_won: [
      "You again! I've padded my prices for you, {name}.", "That's {count} times you've fleeced me. Prices are up for you.", "The haggler returns. I've learnt my lesson.",
      "I knew you'd do that. That's why I started high.", "Every time! You're bleeding me dry, {name}.", "Go on then, haggle. It's priced in now.",
    ],
    repeat_lost: [
      "Still trying, eh? I like you. Small discount, just for you.", "You never win, but you never quit. Here, a little off.", "{count} tries and not one win. Have this one on me.",
      "You're a terrible haggler, {name}. I'll go easy.", "All right, all right. A sporting discount.", "You make me laugh. That's worth a coin off.",
    ],
    greet_haggler: [
      "Ready to haggle again, {name}?", "Ah, my favourite bargainer.", "Prices are firm today, {name}. Mostly.",
      "Back to argue over pennies?", "Don't even start, {name}. ...Fine, start.", "Here comes trouble. Hold on to your margins!",
    ],
  },
  on: {
    "economy.haggled"(run, ev) {
      const npc = str(ev.data.npc);
      const h = run.l.haggles[npc];
      if (!npc || !h || !personaById(run.m, npc)) return;
      const won = str(ev.data.outcome) === "won";
      const pool = `${h.count > 1 ? "repeat" : "first"}_${won ? "won" : "lost"}`;
      const mult = haggleMult(run, npc);
      run.attitude(npc, won ? -0.03 : 0.02, { text: `They haggled ${won ? "me down" : "and lost"} (${Math.round(Number(ev.data.delta_pct) || 0)}%).`, kind: "trade", salience: 0.45 });
      run.say(npc, pool, { vars: { count: h.count }, emote: won ? "grumble" : "laugh", reason: `haggle #${h.count} (${h.won} won, ${h.lost} lost)`, effect: { effect: "price_adjust", payload: { npc, multiplier: mult, haggles: h.count, won: h.won, lost: h.lost } } });
    },
  },
  offer(run, npc) {
    const h = run.l.haggles[npc];
    return h ? { pool: "greet_haggler", vars: { count: h.count }, base: 0.5, reason: `${h.count} haggles`, emote: "grin" } : null;
  },
  note(run, npc) {
    const h = run.l.haggles[npc];
    return h ? `They have haggled with you ${h.count} times (they won ${h.won}, lost ${h.lost}); your prices for them are x${haggleMult(run, npc)}.` : null;
  },
};

