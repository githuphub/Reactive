# Manifest reference (`liveforge.yaml`)

The manifest is the designer's contract with Reactive. Every AI path reads it, and every output is clamped to it.

- **Minimal manifest:** `liveforge: 1` plus `game` and `lore.bible`. Every other section has defaults.
- **Validation:** with clear errors (`file:line:col path: message`), via any of:
  - `npx liveforge-validate liveforge.yaml`
  - the dashboard's **Manifest** panel
  - `POST /admin/manifest/validate`
  - the Godot dock
- **Editor support:** add `# yaml-language-server: $schema=<path>/packages/manifest/schema/liveforge.schema.json`
  to the top of the file for completion and inline errors in VS Code.
- **Hot reload:** `POST /admin/manifest/reload` reloads a running server.

Ids (`game.id`, persona, faction, zone, boss, reaction and achievement ids) are lowercase letters, digits, `_`
and `-`, for example `old_tom`.

---

## Top level

| Field | Type | Default | |
|---|---|---|---|
| `liveforge` | `1` | **required** | Manifest format version. |
| `game` | object | **required** | [game](#game) |
| `lore` | object | **required** | [lore](#lore) |
| `elements` | string[] | `[physical, fire, ice, lightning]` | Elements items and boss moves may use. |
| `zones` | list | `[]` | [zones](#zones) |
| `personas` | list | `[]` | [personas](#personas) |
| `factions` | list | `[]` | [factions](#factions) |
| `relationships` | list | `[]` | [relationships](#relationships) |
| `traits` | map name → DSL | `{}` | [designer traits](#traits) |
| `moments` | map name → DSL | `{}` | [designer moments](#moments) |
| `signals` | map type → spec | `{}` | [custom signals](#signals) |
| `allowUndeclaredSignals` | bool | `false` | Accept custom signal types not declared under `signals` (stored, flagged). |
| `actions` | map name → spec | `{}` | [action schema](#actions): the only actions NPCs and directives may perform. |
| `reactions` | list or block | `[]` | [reaction rules](#reactions) + the [Reaction Library](reactions.md) |
| `items` | object | none | [item schema](#items). Without it, the forge uses generic stats. |
| `quests` | object | defaults | [quest schema](#quests) |
| `moves` | object | defaults | [move schema](#moves) |
| `bosses` | list | `[]` | [bosses](#bosses) |
| `progression` | object | defaults | [progression](#progression) |
| `achievements` | list | `[]` | [designer achievements](#achievements) |
| `clamps` | object | defaults | [clamps](#clamps) |
| `safety` | object | defaults | [safety](#safety) |
| `budgets` | object | defaults | [budgets](#budgets) |
| `models` | object | defaults | [models](#models) |
| `modules` | object | all on | [module toggles](#modules) |

## game

| Field | Type | |
|---|---|---|
| `id` | id, **required** | Game id. SDK keys are scoped to it (dev key: `pk_dev_<id>`). |
| `name` | string ≤ 80, **required** | Display name. |
| `description` | string ≤ 1000 | Optional. |

## lore

| Field | Type | Default | |
|---|---|---|---|
| `bible` | string ≤ 20 000, **required** | | World facts every prompt may rely on. Markdown is allowed. Keep it factual: personas and the forge both read it. |
| `tone` | string ≤ 300 | `neutral` | Tone words, e.g. `wry, warm, a little ominous`. |
| `glossary` | map term → definition | `{}` | Also used as STT hints so names are spelled correctly. |

## zones

Proximity groups for rumour spread, persona locations and reaction rules (`stat(zone)`).

| Field | Type | Default | |
|---|---|---|---|
| `id` | id, **required** | | |
| `name` | string, **required** | | |
| `kind` | string | `area` | Free label: `hub`, `arena`, `interior` … |
| `neighbours` | id[] | `[]` | Rumours travel along these. |

## personas

| Field | Type | Default | |
|---|---|---|---|
| `id` | id, **required** | | Used in asks (`npc.reply {npc}`) and directive targets (`npc:<id>`). |
| `name` | string ≤ 64, **required** | | |
| `role` | string ≤ 64, **required** | | "Head porter", "Innkeeper" … |
| `faction` | faction id | | Must be declared under `factions`. |
| `personality` | string ≤ 800, **required** | | One to three sentences, injected into every prompt for this NPC. |
| `voice` | object | `{}` | `pitch` 0.5–2, `rate` 0.5–2, `accent` (e.g. `en-GB`), `style` (`gruff`, `whispering`), `voiceId`. SDK TTS uses these. |
| `knowledge` | string[] | `[]` | Topics this NPC knows. Out-of-scope questions are refused in character. |
| `secrets` | string[] | `[]` | Only revealed with the `reveal` action or a high attitude. |
| `likes` / `dislikes` | string[] | `[]` | Steer attitude changes and barks. |
| `allowedActions` | action names | all declared | Subset of `actions` this NPC may take. |
| `zone` | zone id | | Where the NPC usually is. Used for proximity rumour spread. |
| `barks` | string[] | `[]` | Seed bark pool: the instant answers before the AI refills it. |
| `greeting` | string ≤ 200 | | Instant greeting on approach. |
| `asset` | string | | Your asset id (`forge.npc_look` restyles it). |

## factions

| Field | Type | Default | |
|---|---|---|---|
| `id`, `name` | **required** | | |
| `description` | string ≤ 400 | | |
| `attitude` | −1..1 | `0` | Default attitude toward a new player. |
| `relations` | map faction id → −1..1 | `{}` | Stance toward other factions. Colours gossip and help. |
| `priceRange` | `[min, max]` | `[0.8, 1.5]` | Price multiplier range applied by reputation (revered → min, hated → max). |
| `members` | persona ids | `[]` | Village mind: members (merged with personas whose `faction` is this id). |
| `home` | zone id | | Signals in this zone count as "in the village". |
| `traits` | map name → number / string / bool | `{}` | Village character for the council prompt, e.g. `{proud: 0.8}`. |
| `guards` | persona ids | members whose role says guard / captain / golem | Who takes guard posts. |
| `posts` | strings | `[gate, square, well]` | Guard post ids your game maps to places. `home:<npc>` and `player:<id>` are always allowed. |
| `raid` | `{mobs?, captains?, size?}` | zombie, skeleton, creeper, spider · medium | Night raids planned by `faction.raid_plan`. |

The village-mind fields are read by the `factions` module (`modules.factions: true`). See [factions.md](factions.md).

## relationships

NPC ↔ NPC links that colour gossip, help and rumour spread.

| Field | Type | Default | |
|---|---|---|---|
| `a`, `b` | persona ids, **required** | | |
| `kind` | `rival \| family \| ally \| friend \| lover \| mentor \| enemy \| employer`, **required** | | |
| `strength` | 0–1 | `0.5` | |
| `note` | string ≤ 200 | | Context for prompts ("Pell has reported Kit three times"). |

## traits

`name: <DSL>`. A designer trait scores 1 while its rule is true and then decays like a built-in trait.

```yaml
traits:
  necromancer: count(magic.raise_dead, 10m) > 10
  show_off: count(gear.equipped, 10m) > 6 & trait(rich)
```

Built-in traits: `dodger, turtle, glass_cannon, ranged_camper, berserker, hoarder, big_spender, rich, broke,
pacifist, murderer, thief, explorer, speedrunner, chatterbox, liar, feared, famous, beloved`.

### The rule DSL

The DSL is used by traits, moments, reactions, achievements, unlocks and dynamic objectives.

```
expr  :=  a | b      a & b      !a      a == b   a != b   a > b   a >= b   a < b   a <= b   a + b  a - b  a * b  a / b
atoms :=  numbers · durations (500ms 10s 5m 1h 1d) · "strings" · true/false · trait names · function calls
```

`or` / `and` / `not` work too. A bare number in boolean position is true when it is ≥ 0.5 (the trait threshold).

| Function | |
|---|---|
| `count(type, window)` | Matching events in the window. `type` may end in `.*`. |
| `sum / avg / max(type.field, window)` | Aggregate a numeric data field. |
| `rate(type, window)` | Events per minute. |
| `last(type.field)` | Field of the most recent matching event. |
| `since(type)` | Seconds since the most recent matching event. |
| `distinct(type.field, window)` | Distinct values. |
| `trait(name)` | Trait score 0–1. |
| `stat(name)` | Player-model stat (`gold`, `kills`, `zone` …). |
| `moment(kind, window)` | Moments of that kind. |
| `rep(faction)` | Reputation −1..1. |
| `attitude(npc)` | NPC attitude toward the player −1..1. |
| `has(tag)` | Player has a gear / state tag. |
| `min2(a, b)`, `max2(a, b)` | |

## moments

`name: <DSL>`. When the rule becomes true, a `moment` directive is broadcast, and it may seed rumours and quests.

Built-in moments: `near_death_escape, flawless_phase, comeback, betrayal, absurd_purchase, first_kill_of_type,
broken_promise`.

## signals

Custom signal types. They must be dotted lowercase, e.g. `magic.raise_dead`.

```yaml
signals:
  forge.created:
    description: The player forged something at the Anvil.
    data: { prompt: string, family: string, "creativity?": number }
```

| Field | Type | |
|---|---|---|
| `description` | string ≤ 300 | |
| `data` | map field → `string \| number \| boolean \| string[] \| object` | A trailing `?` on the field name marks it optional. |

Built-in signals do not need declaring. See [protocol.md](protocol.md#built-in-signals).

## actions

The action schema is the **only** set of actions NPCs (replies, barks, `npc.action` directives), the Director and
world rules may perform. Anything else is dropped.

```yaml
actions:
  trade:
    description: Open a shop with a price multiplier.
    args: { priceMultiplier: { type: number, min: 0.5, max: 2, required: true } }
  call_guards: { description: Call the wardens., by: [npc, world] }
```

| Field | Type | Default | |
|---|---|---|---|
| `description` | string ≤ 300 | `""` | Shown to the model. |
| `args` | map name → arg | `{}` | Each arg has `type` (`string \| number \| boolean`), `min`, `max`, `enum`, `required` (default false) and `description`. Numbers are clamped and enums enforced. |
| `by` | `(npc \| director \| world)[]` | `[npc]` | Who may perform it. |

Built-in action names (declare the ones you use): `emote, trade, give, take, quest_offer, reveal, hostile, flee,
call_guards, steal, follow, help, join`.

## reactions

`when <player-model condition> then <directive>`.

```yaml
reactions:
  - id: pickpocket_rich
    when: trait(rich) > 0.6 & stat(zone) == "courtyard"
    then:
      kind: npc.action
      target: npc:kit
      args: { npc: kit, action: { action: steal, args: { gold: 50 } } }
    cooldown: 600
    flavour: true
```

| Field | Type | Default | |
|---|---|---|---|
| `id` | id, **required** | | |
| `when` | DSL, **required** | | Evaluated against the player model. |
| `then.kind` | directive kind or `custom.<name>`, **required** | | See [directive kinds](protocol.md#directives). |
| `then.target` | string, **required** | | `npc:<id>`, `boss:<id>`, `spawner:<id>`, `player`, `world`, `ui`. |
| `then.args` | object | `{}` | Validated per kind. Actions are checked against `actions`. |
| `cooldown` | seconds | `300` | Per player. |
| `flavour` | bool | `false` | Let the LLM flavour it (a named NPC, a bark, a plan). The rules version fires first. |
| `description` | string | | Shown in the dashboard. |
| `once` | bool | `false` | Fire at most once per player. |

### Block form: rules + the Reaction Library

```yaml
reactions:
  rules: [ ...the rules above... ]
  library: [outfit_comments, deed_nicknames, promises_remembered, dodge_bait]   # or: all
  params:
    rich_attention: { pickpocket: kit, gold: 400 }
  engine: { ledgerSize: 16, traitThreshold: 0.5, momentMinutes: 15, ai: true }
```

| Field | Type | Default | |
|---|---|---|---|
| `rules` | list | `[]` | The rules above. |
| `library` | list of recipe ids, or `all` | `[]` | Entries may also be `{recipe_id: params}` or `{recipe: id, ...params}`. Unknown ids are errors. |
| `params` | map recipe → params | `{}` | Merged over inline params. Unknown params are warnings. |
| `engine.ledgerSize` | int 2-60 | `16` | Lines per speaker × player that are never repeated. |
| `engine.traitThreshold` | 0-1 | `0.5` | Trait score that counts as a facet. |
| `engine.momentMinutes` | minutes | `15` | How long a moment stays a facet. |
| `engine.ai` | bool | `true` | Background AI variants (keyed servers only). |

Every recipe and its params: [Reaction Library](reactions.md).

## items

The item schema for the forge. Every forged stat is clamped here.

| Field | Type | Default | |
|---|---|---|---|
| `families` | string[], **required** | | Item families, e.g. `sword, axe, staff, shield_small`. |
| `slots` | string[] | `weapon, offhand, head, chest, hands, legs, feet, trinket` | |
| `rarities` | string[] | `common … legendary` | |
| `stats` | map stat → `{min, max, default?}`, **required** | | |
| `budget` | number or number[] | `2` | Sum of normalised stats allowed, flat or per rarity tier. |
| `tags` | string[] | `[]` | Tags the forge may attach (`Piercing`, `Lifesteal` …). Bosses can counter them. |
| `creativity.max` | 0–1 | `0.7` | How far a prompt may stretch power. |
| `creativity.rawPowerPenalty` | bool | `true` | "Make it super strong" comes out weak. Clever, specific prompts come out strong. |
| `assets` | `{id, kind?, slots?}[]` | `[]` | Your assets that `forge.look` may restyle (Variants). |

## quests

| Field | Type | Default | |
|---|---|---|---|
| `objectiveTypes` | string[] | `kill, fetch, talk, explore, deliver, escort, survive, defeat_boss` | |
| `rewardTypes` | string[] | `gold, item, xp, reputation, title` | |
| `maxObjectives` | 1–8 | `3` | |
| `maxActive` | 1–20 | `3` | Per player. |
| `givers` | persona ids | all | Who may give quests. |
| `rewards.goldMax` / `rewards.xpMax` | numbers | `500` / `1000` | Reward bounds. |

## moves

The boss move schema for the Director.

| Field | Type | Default | |
|---|---|---|---|
| `grammar` | bool | `true` | Allow invented grammar moves (shape, element, pattern, count, telegraph, speed, size, status, damage). |
| `shapes` | subset of `slam, beam, projectile, ring, spikes, meteor, grab, summon` | all | Restrict invented shapes. |
| `damageScale` | number | `1` | Scales every damage cap. The budget is tuned for ~100 HP players. |
| `engine` | list | `[]` | Engine-native moves your game implements: `{id, name, description?, shape?, params: {name: {min, max, default?}}}`. The Director picks these with bounded params. |

## bosses

| Field | Type | Default | |
|---|---|---|---|
| `id`, `name` | **required** | | |
| `persona` | persona id | | Voices the taunts. |
| `description` | string ≤ 600 | `""` | |
| `phases` | 1–9 | `3` | |
| `moves` | engine move ids | `[]` | Starting rotation. |
| `counters` | gear tags / trait names | `[]` | What it is allowed to counter (`Piercing`, `dodger`, `turtle` …). |
| `maxInvented` | 0–6 | `3` | Invented moves kept in rotation at once. |
| `asset` | string | | |

## progression

| Field | Type | |
|---|---|---|
| `unlocks` | `{id, name, kind = "ability", condition?: DSL}[]` | Unlock suggestions within your progression. |
| `levels` | `{max, xpCurve: linear \| quadratic \| exponential}` | Optional. |

## achievements

Designer achievements. The Quests module also invents personal ones per player.

| Field | Type | Default | |
|---|---|---|---|
| `id`, `title` (≤ 64), `description` (≤ 200), `condition` (DSL) | **required** | | |
| `glyph` | string | | Icon glyph name. |
| `rarity` | `common … legendary` | `common` | |

## clamps

Hard bounds on everything adaptive.

| Field | Default | |
|---|---|---|
| `difficulty.mode` | `hidden` | `hidden` (silent adaptation) · `assist` (explicit, player-visible) · `off`. |
| `difficulty.aggressionMin` / `aggressionMax` | `0.2` / `0.9` | The Director never leaves this band. |
| `difficulty.maxStep` | `0.15` | Max aggression change per adjustment. |
| `pacing.maxSpawnPerMin` | `12` | |
| `pacing.maxWaveSize` | `8` | |
| `pacing.breatherSec` | `[8, 30]` | Breather length range. |
| `pacing.lootPerMin` | `2` | |
| `forge.maxParts` | `24` | Blueprint part cap (≤ 64). |
| `forge.maxPerMinPerPlayer` | `6` | Forge rate limit. |
| `forge.meshJobs` | `false` | Allow Hyper3D mesh jobs (also needs `HYPER3D_API_KEY`). |
| `npc.maxReplyChars` | `400` | 40–1200. |
| `npc.priceMultiplier` | `[0.5, 2]` | Trade price bounds. |

## safety

| Field | Default | |
|---|---|---|
| `rating` | `T` | `E` (everyone) / `T` (teen) / `M` (mature): the moderation preset and prompt guidance. |
| `blocked` | `[]` | Extra blocked words and phrases (input and output). |
| `refusedTopics` | `real-world politics, real people, the player's personal data` | Personas refuse these in character. |
| `inWorldOnly` | `true` | Refuse out-of-world topics in character. |

## budgets

| Field | Default | |
|---|---|---|
| `game.tokensPerMin` / `game.usdPerDay` | `200000` / `20` | Over budget → asks keep answering from rules and cache; AI upgrades pause. |
| `player.tokensPerMin` / `player.usdPerDay` | `20000` / `1` | Per player. |

## models

| Field | Default | |
|---|---|---|
| `fast` | `claude-haiku-4-5` | Barks, replies, moves, forge. |
| `rich` | `claude-sonnet-5-5` | Profiles, quests, lore-heavy tasks. |
| `overrides` | `{}` | Per ask kind or task: `{ "npc.reply": rich, "observer.profile": rich }`. |

The env vars `LIVEFORGE_MODEL_FAST` and `LIVEFORGE_MODEL_RICH` override `fast` and `rich`.

## modules

Each of `observer, persona, world, director, forge, quests` is `true`, `false`, or `{enabled, options}`. Plugin
modules use their own ids.

```yaml
modules:
  observer: true
  forge: { enabled: true, options: { barkPoolSize: 12 } }
  quests: false
```

Turning `observer` off leaves traits, moments and profiles empty for every other module; the validator warns
about it.

---

See `examples/counterforge.liveforge.yaml` and `examples/godot-village.liveforge.yaml` for complete manifests.
