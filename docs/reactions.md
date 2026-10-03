# Reaction Library

One manifest line switches on ready-made reactions. Each reaction combines what the world knows about the
player (traits, gear, colours, mud and blood, time and weather, rumours, nickname, attitude, debts, promises) into a
line and an effect that fit *this* moment. The same NPC never says the same line twice while it is in its ledger.

Fifty reactions are planned. The 20 below ship today.

```yaml
reactions:
  library: [outfit_comments, appearance_state, deed_nicknames, lies_caught, promises_remembered, town_mood,
            rich_attention, broke_support, collector_interest, haggle_memory, boss_attempt_memory, dodge_bait,
            flawless_secret_phase, coward_rumour, companion_grief, time_weather_barks, inn_regular, absence_recap,
            property_damage, avoided_area]      # or: library: all
  params:
    rich_attention: { pickpocket: kit, gold: 400 }
    absence_recap: { companion: vale }
```

A plain list under `reactions:` still works and means designer rules. With the block form those rules go under
`reactions.rules`. The library needs the `world` module. It also uses `observer` (traits, moments), `persona`
(voices, memories) and `quests` (quest offers) when those are on.

Other ways to write a library entry:
- an inline map: `- rich_attention: { gold: 400 }`
- a recipe key: `- { recipe: rich_attention, gold: 400 }`
- switch one off: `- rich_attention: false`

---

## How the combination engine works

1. **Context fingerprint.** For each (speaker, player) pair the server collects *facets*:
   - Observer traits above `engine.traitThreshold` (default 0.5).
   - Moments from the last `engine.momentMinutes` (default 15).
   - Worn items, their colours and style tags.
   - Appearance states above `appearance_state.threshold`.
   - Time of day (dawn, dusk, night) and weather.
   - The player's zone.
   - Rumours about the player that *this* NPC knows, and its attitude (warm or cold).
   - Library statuses: nickname, regular, debtor, owes a promise, caught lying, coward, grieving, returning after
     an absence, boss attempt count, town mood.

   Facets are bucketed, so the same situation always hashes to the same **fingerprint**. Every facet change gives
   a new one. The facets also make a readable **context sentence**:
   `Pell sees the newcomer ("Titanbreaker") at dusk, in the rain, in The Courtyard: soaked through; wearing Crimson
   Robe; known as rich; has heard "..."; is fond of them.`
2. **Novelty ledger.** Each speaker × player pair keeps the last `engine.ledgerSize` lines (default 16). This
   includes Persona's own barks.
   - A recipe picks its variant with a permutation seeded by fingerprint × speaker, starting at the number of
     times that combination was already used.
   - It skips every variant that is still in the ledger. Replays of the same event log pick the same lines.
   - Every recipe pool has at least 6 variants. When a combination keeps coming back, a keyed server asks the LLM
     for 4 fresh variants in the speaker's voice in the background. That call gets the context sentence and the
     do-not-repeat list, and is budget-checked.
3. **Variety.**
   - **Combination weighting.** For `npc.bark` every recipe offers a line. The score is the recipe's base priority
     plus 0.15 for each facet it actually uses, plus a little for a rich situation.
   - **Woven asides.** The richer the situation, the more likely the line weaves in a second facet: "...And in
     this rain, too."
   - **Persona tics.** A persona's style words add a speech tic now and then ("Hmph.", "Oh-ho!").
   - **Rumour drift.** Rumours the library starts pick a seeded variant, then drift as they spread (World module).
4. **AI upgrades.** `npc.bark` and `npc.reply` upgrades get the context sentence, a note from each recipe ("They
   promised you X, due in 5 min", "They owe you 125 gold", "They lied to you earlier"), the nickname and the
   lines not to repeat.
5. **Cooldowns.** Each recipe has a cooldown per speaker × player (`cooldownSec`). Passive bark contributions use
   their own shorter cooldown.

Every reaction carries a `why`, for example `outfit_comments: Crimson Robe (crimson) · gear:robe_1,
weather:rain, trait:rich, nickname:Titanbreaker`. Spoken `npc.bark` directives also carry `args.reaction`
`{recipe, fingerprint, facets, sentence, variant}`.

## Where reactions show up

| Where | What |
|---|---|
| `npc.bark` (ask) | The best-scoring recipe line for that NPC, before Persona's own buckets. `why` names the recipe. |
| `npc.reply` (ask) | Promises and checkable claims in what the player says are noticed (rules + the AI upgrade), acknowledged or called out. |
| `npc.bark` (directive) | Recipe lines with no game effect. `args.reaction` holds the facets. |
| `custom.reaction` (directive) | Game effects (see payloads below). The line travels in `payload.line`, spoken by `payload.npc`, so no separate `npc.bark` is sent for it. |
| `boss.adapt` / `boss.move_added` | Boss taunts and moves (dodge bait, secret phase). |
| `quest.offer`, `rumour.heard`, `npc.action` | Revenge, repair and explore quests. Rumours. `steal`, `trade` and `call_guards` when your action schema allows them. |
| Director timeline | Boss recipes record `lf.director.decision` (kind `reaction`) with `data.recipe` and `data.facets`. |
| Dashboard → Reactions | Recipes, fired reactions with facets, per-NPC fingerprint, context sentence and novelty ledger. |

Admin route: `GET /admin/m/world/reactions-lib?world=&player=`. Projection: `world.reaction_ledger`, player scope.

## Signals

All are built in (`BUILTIN_SIGNALS`). Send only what your game has.

| Signal | Data |
|---|---|
| `appearance.state` | `{wet?, bloodied?, burnt?, muddy?}`, each 0-1. Send changes. |
| `appearance.outfit` | `{slots: {head?, body?, back?, weapon? ...: {id, name, tags[], colors[]}}, style_tags?[]}`. `gear.equipped` with `tags` also counts. |
| `world.time` | `{hour 0-24, day?, weather?: clear\|rain\|storm\|snow\|fog\|heat, phase?}`. `phase` is derived from `hour` when omitted. |
| `world.property_damaged` | `{object, owner?: npc id, value?, zone?}` (`world.destroyed` with an `owner` also counts) |
| `social.promise` | `{to, text, due?, ref?}`. `due` is ms epoch, seconds from now, or a readable in-game time ("day 2 · 19:00"). |
| `social.promise_kept` / `social.promise_broken` | `{to, ref?}`. Without `ref`, the latest open promise to `to`. |
| `social.claim` | `{to, text, truth: true\|false\|null}`. `null` = unknown: the server checks the claim against rumours and gold. |
| `economy.haggled` | `{npc, delta_pct, outcome: won\|lost, item?}` |
| `combat.boss_attempt` | `{boss, result: died\|won\|fled, attempt?, phase?, dodge_dirs?: {left, right, back, fwd}}` |
| `combat.phase_flawless` | `{boss, phase}` |
| `combat.fled` | `{from?, enemy_count?, zone?}` (`movement.fled` also counts) |
| `companion.died` | `{companion, killer?}` |
| `session.started` | `{last_seen_ts?}`. Without it the server uses the player's last event. |
| `movement.visited` | `{place, kind?: inn\|shop\|tavern\|area..., zone?}` |

The SDKs send several of these for you:
- **JS:** `autoEmit(lf, {...})` sends `session.started` (with last-seen), runs a `world.time` clock with weather,
  tracks appearance (with decay) and outfit, and has `visited(place, kind)`.
- **Godot:** the `Liveforge` autoload has `session_started()` (on start), `set_world_time()`, `set_weather()`,
  `set_appearance()`, `add_appearance()` (with `appearance_decay`), `set_outfit()`, `visited()` and `left_place()`.
  There are also two nodes, `LiveWorldClock` and `LivePlace`.

```ts
import { autoEmit } from "@liveforge/sdk";
const auto = autoEmit(lf, { clock: { dayLengthMin: 20 }, appearance: { decay: { muddy: 0.02, wet: 0.05 } } });
auto.setWeather("rain");
auto.addAppearance("bloodied", 0.4);
auto.outfit({ body: { id: "robe_1", name: "Crimson Robe", tags: ["regal"], colors: ["crimson"] } });
auto.visited("inn", "inn");
```

## `custom.reaction` payloads

The args are `{recipe, target, payload, line?, reaction?}`, and `payload.effect` names the effect.

When an NPC says the line, the payload also has:
- `line`: the line
- `npc`: the speaker
- `voice`: the persona voice
- `emote`

Field names are fixed. Games can rely on them:

| Field | Meaning |
|---|---|
| `amount` | Gold. |
| `item` | A display name. |
| `object` | The prop id from the signal. |
| `boss` | Boss id. |
| `direction` | `left`, `right`, `back` or `fwd`. |
| `quest` | A full `Quest`. The same quest also arrives as a `quest.offer` directive, so dedupe by `quest.id`. |
| `nickname` | The nickname. |
| `mood` | -1..1. |
| `price_mult` | A price multiplier. Games apply it to the speaking `npc` for `seconds` when given. |
| `lines` | `[{npc, text}]`, spoken in turn. |

## The 20 recipes

Common params for every recipe:

| Param | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` switches the recipe off. |
| `cooldownSec` | per recipe | Seconds before the same speaker reacts with this recipe again. |
| `chance` | `1` | Seeded probability that the recipe fires. |
| `when` | | Extra DSL gate, for example `stat(zone) == "courtyard"`. |
| `speakers` | NPCs in the player's zone | Persona ids allowed to speak. Personas that voice a boss never speak town lines. |
| `ai` | `true` | Background AI variants. |

### 1. `outfit_comments`
NPCs comment on what you wear: item names, colours and style tags. Up to `maxSpeakers` NPCs speak, and each picks
a different variant for its own fingerprint.
- **Signals:** `appearance.outfit`, `gear.equipped`.
- **Params:** `maxSpeakers` (2), `cooldownSec` (90).
- **Emits:** `npc.bark` with `args.reaction`. There is no custom effect.
- **Line pools:** item, colour, style, weapon. Recent outfits are also offered to `npc.bark` for 10 minutes.

### 2. `appearance_state`
Bloodied, soaked, scorched or muddy. The dominant state above `threshold` gets a comment. When you are bloodied,
the `healer` offers help.
- **Signals:** `appearance.state`.
- **Params:** `threshold` (0.5), `healer` (persona), `cooldownSec` (60, per state per speaker).
- **Emits:** `npc.bark`. The healer sends `custom.reaction`:
  `{effect: "concern", line, npc, state, level, offer: "bandage"}`.

### 3. `deed_nicknames`
A deed coins a nickname. One NPC announces it, the nickname spreads as a rumour, and from then on NPCs use it in
barks (`{nick}` in every recipe, plus the `nickname` facet).

Deeds that coin a nickname:
- killing or beating a boss
- a flawless phase
- 4+ deaths at one boss
- 3 flights in 30 minutes
- a seen theft
- 2 broken props
- a generous gift
- near-death escapes and comebacks

**Params:** `minGapSec` (300) before a new deed can replace the nickname.

**Emits:**

```json
{ "effect": "nickname", "line": "...", "npc": "pell", "nickname": "Titanbreaker", "deed": "slayer:forge_titan", "because": "bringing down the Forge Titan" }
```

Also a rumour. Without a speaker the same payload goes to `target: player` with no line.

### 4. `lies_caught`
A `social.claim` with `truth: false` is a lie. So is a claim with `truth: null` that the NPC's rumours or the
player's gold contradict. Claims made in `npc.reply` are detected too: by rules, and by the AI upgrade's `claim`
field.

What happens:
- trust (attitude) drops by `trustDrop` (0.2)
- faction reputation drops by `reputationDrop` (0.05)
- a memory of the lie is stored
- a rumour starts
- the NPC calls you out

`social.lied` also gets a callout. **Emits:**

```json
{ "effect": "lie_caught", "line": "...", "npc": "marrow", "claim": "I never touched the books", "contradictedBy": "the rumour \"...\"" }
```

For claims made in conversation the reply itself carries the callout, so the effect has no `line`.

### 5. `promises_remembered`
"I promise ..." in `npc.reply`, or `social.promise`. Each step has its own effect and line:

| When | Effect | Notes |
|---|---|---|
| The promise is made | `promise_made` | The NPC acknowledges it. |
| Near the due time | `promise_reminder` | Fires `remindBeforeSec` (120) before it is due. |
| `social.promise_kept` | `promise_kept` | Attitude +`attitudeKept` (0.2). |
| `social.promise_broken` | `promise_broken` | Attitude −`attitudeBroken` (0.3), a rumour starts, and the Observer records a `broken_promise` moment. |

Timing rules:
- A promise with a numeric `due` runs out 60 s after the due time and counts as broken (`auto: true`).
- A readable `due` string ("day 2 · 19:00") is left to the game, which sends kept or broken.
- A promise with no `due` gets one reminder after `defaultDueSec` (900) and never runs out.

**Payload:** `{effect, line?, npc, ref, text, due?, dueInSec?, auto?}`.

### 6. `town_mood`
A streak of `streak` (3) kind acts turns the town warm. Kind acts are gifts, help, kept promises and completed
quests. A streak of rude acts turns it cold. Rude acts are threats, theft, lies, false claims, property damage and
broken promises.

When the mood turns:
- reputation with every faction moves by `reputationShift` (0.05)
- prices move by `priceShift` (0.1)
- one NPC announces it, and a second one barks

**Emits:**

```json
{ "effect": "town_mood", "line": "...", "npc": "pell", "mood": 0.5, "moodLabel": "warm", "price_mult": 0.9, "streak": 3 }
```

`mood` is -0.5 when the town turns cold.

### 7. `rich_attention`
Triggered when gold ≥ `gold` (500) or `trait(rich)` ≥ `trait` (0.6). It rotates through four effects, so the same
attention never comes twice in a row. The default `cooldownSec` is 300.

| Effect | Payload | Notes |
|---|---|---|
| Pickpocket | `{effect: "pickpocket", thief, amount, gold, line, npc}` | Also `npc.action steal {gold}` when your action schema lets the `pickpocket` persona steal. |
| Beggar | `{effect: "beggar", beggar, amount}` | |
| Price gouging | `{effect: "price_gouging", merchant, price_mult, seconds: 300}` | Also `npc.action trade {priceMultiplier}` when allowed. |
| Tax | `{effect: "tax", collector, amount}` | `amount` = `taxPct` % of gold. |

**Params:** `pickpocket`, `beggar`, `merchant` and `taxCollector` (personas), `stealGold` (50), `taxPct` (10).
Missing personas become nameless walk-ons: the speaker is `world`, and the line goes in `payload.line`.

### 8. `broke_support`
Triggered when gold ≤ `gold` (20) or `trait(broke)` ≥ 0.6. Charity and a loan offer alternate.

| Effect | Payload |
|---|---|
| Charity | `{effect: "charity", giver, amount}` |
| Loan offer | `{effect: "loan_offer", ref, lender, amount, owed, interest (fraction), interestPct, dueSec, accept: {signal: "social.promise", data: {to, text, ref, due, owed}}}` |

To accept a loan, send the `accept` signal: `social.promise` with `ref` starting `loan_` and `owed`. The debt then
follows up:

| Effect | When | Payload |
|---|---|---|
| `debt_due` | 2 minutes before the due time | `{amount, dueInSec}` |
| `collect_debt` | After the due time | `{lender, amount}`. The promise counts as broken and attitude drops by 0.4. |
| `debt_paid` | On `social.promise_kept` | `{amount}` |

**Params:** `loanShark`, `loanAmount` (100), `interestPct` (25), `dueSec` (900), `charityGold` (10).

### 9. `collector_interest`
An item whose tags include one of `tags` (legendary, rare, epic, unique, artifact) draws a collector:

```json
{ "effect": "collector_offer", "item": "Ember Fang", "itemId": "item_3", "amount": 800, "tag": "legendary" }
```

`amount` is `offerGold` × 2 for legendary and × 1.5 for epic. If the item is still worn `theftAfterSec` (300)
later, a thief tries for it:

```json
{ "effect": "theft", "thief": "kit", "item": "Ember Fang", "itemId": "item_3" }
```

**Params:** `collector`, `thief`.

### 10. `haggle_memory`
Merchants remember every `economy.haggled`:
- Players who win haggles find prices padded: `price_mult` = 1 + `step` × (won − lost), clamped 0.8-1.4.
- Good sports who keep losing get a discount.
- First and repeat haggles use different lines, and the merchant greets known hagglers.

**Payload:** `{effect: "price_adjust", npc, price_mult, seconds: 3600, haggles, won, lost, line}`.

### 11. `boss_attempt_memory`
On every `combat.boss_attempt` the boss speaks through `boss.adapt.taunt`, plus a `custom.reaction`. It picks its
line by memory:

| Line | When |
|---|---|
| `first` | The first attempt. |
| `gloat` | Later attempts. |
| `respect` | After `respectAfter` (5) attempts. |
| `hint` | After `hintAfter` (3) deaths, on every second death. |
| `defeated` | The player won. |
| `fled` | The player fled. |

The `hint` line uses `params.hints`, else the boss persona's secrets, else generic advice. `director.boss_phase`
taunts use the same memory.

**Payload:** `{effect: "boss_line", boss, attempt, deaths, mood: <line kind>, hint?, line}`.

### 12. `dodge_bait`
Dodge counts per boss come from `dodge_dirs` and from `combat.dodged {source: boss, direction}`. Once there are at
least `minDodges` (6) and one direction has at least `minShare` (0.45) of them, the boss acts:

| Dominant dodge | Response |
|---|---|
| left or right | A fan or spikes biased that way (`composeMove`), and `boss.adapt.weights`. |
| back | A long-reach grab. |
| fwd | A closing ring. |

The Director's habit read also uses these dodge counts.

**Emits:** `boss.move_added`, and:

```json
{ "effect": "dodge_bait", "boss": "forge_titan", "direction": "left", "share": 0.72, "bias": "left", "move": { "name": "...", "shape": "spikes" } }
```

### 13. `flawless_secret_phase`
`combat.phase_flawless` unlocks a secret desperate phase. The boss gets a "Last ..." move: faster, bigger and with
more projectiles. It is added to the boss with aggression at the clamp maximum, and to every later
`director.boss_phase` plan.

**Payload:** `{effect: "secret_phase", boss, name, afterPhase, secretPhase, move, engineMove?, line}`.
**Params:** `once` (true).

### 14. `coward_rumour`
`flees` (3) flights within `windowMin` (30) set off three things:
- a coward rumour
- a jeer: `{effect: "coward", flees, challenger: false}`
- a challenger from the town: `{effect: "challenger", name, unit, count: 1, zone?, boss?, line}`

**Params:** `challenger` ("a bounty hunter"), `challengerUnit` ("bounty_hunter").

### 15. `companion_grief`
`companion.died` makes the companion's friends (relationships ally, friend, family, mentor ...) and nearby NPCs
grieve, and starts a rumour. When the killer is known, `giver` offers a revenge quest (`defeat_boss` or `kill`):

```json
{ "effect": "grief", "companion": "vale", "killer": "forge_titan", "lines": [{ "npc": "marrow", "text": "..." }], "mourners": ["marrow"], "quest": { "...": "Quest" } }
```

**Params:** `giver`, `revengeQuest` (true).

### 16. `time_weather_barks`
A change of phase (dawn, day, dusk, night) or weather gets one NPC line and a behaviour hint for the whole world:

```json
{ "effect": "behaviour", "phase": "dusk", "weather": "rain", "hour": 18.5, "day": 2, "behaviour": ["lamps_lit", "take_shelter", "stalls_covered"], "line": "..." }
```

Time and weather are also facets in every other recipe.

### 17. `inn_regular`
Places of a kind in `kinds` (inn, shop, tavern) count separate visits. A visit counts when it is in a new session,
or 10 or more minutes after the last one. The visit before you become a regular gets an "almost a regular" line.
After `visits` (3):

```json
{ "effect": "regular", "place": "inn", "owner": "pell", "visits": 3, "discount": 0.1, "perk": "discount", "perks": ["the_usual", "discount", "reserved_seat"], "price_mult": 0.9, "first": true }
```

Later visits get familiar lines and the same effect with `first: false`.

**Params:** `owners` (`{place: persona}`; default: the persona whose zone is that place), `discount` (0.1).

### 18. `absence_recap`
`session.started` after `minHours` (6) away sends one effect. The companion recaps what changed: new hot rumours,
open promises, the town mood, the nickname. A second NPC says you've been gone. A "nobody's seen them" rumour
starts.

```json
{ "effect": "recap", "lines": [{ "npc": "vale", "text": "..." }, { "npc": "pell", "text": "..." }], "recap": ["..."], "hours": 30, "days": 1.3, "companion": "vale" }
```

**Params:** `companion`, `minHours`.

### 19. `property_damage`
`world.property_damaged` (or `world.destroyed` with an `owner`) leads to one of three outcomes. In every case the
owner remembers the harm (attitude −0.15) and their faction's reputation drops by 0.03.

| Outcome | When | Payload |
|---|---|---|
| Compensation | Small damage | `{effect: "compensation", owner, object, amount, line, npc}` |
| Repair quest | `value` ≥ `repairOver` (50) | `{effect: "repair_quest", owner, object, amount, quest?, line, npc}`. The quest is to fetch materials and bring them to the owner. |
| Guards | `guardsAfter` (3) objects broken in 30 minutes | `{effect: "guards", owner, object, count, amount, reason, line, npc}`. Also `npc.action call_guards` when allowed. |

**Params:** `repairQuest` (true).

### 20. `avoided_area`
After `afterMin` (20) minutes of play, a zone you never visited (or fled from) does three things:
- grows a rumour
- has `giver` ask you to look, with an explore quest
- gets a "you finally went" line when you do go

```json
{ "effect": "quest_pull", "area": "undercroft", "reason": "never visited", "quest": { "...": "Quest" }, "line": "...", "npc": "pell" }
```

**Params:** `zones` (default: every manifest zone), `giver`.

---

## The 30 still to come

These are planned and not built yet:

| Area | Planned recipes |
|---|---|
| NPCs | Gift memory, favourite-weapon banter, scars and tattoos, smell (fire, sewer, perfume), what you're carrying, reputation-based greetings. |
| Social | Rivalry between NPCs over the player, jealousy, matchmaking gossip, mentor pride. |
| Economy | Supply and demand after big purchases, black-market access for thieves, debt collectors, stolen-goods recognition. |
| Combat | Nemesis enemies who survived you, crowd cheers for flashy kills, training requests, sparring challenges, weapon-envy challengers. |
| World | Festivals and holidays, seasons, crime waves after theft streaks, shrines that remember offerings, door locks for murderers, children who imitate the player, bards' songs about your deeds, wanted posters, and NPC schedules that react to fear. |
