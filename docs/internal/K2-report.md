# K2 report: World reactions + Quests

Branch `K2`. Code lives in `packages/server/src/modules/world/*` and `packages/server/src/modules/quests/*`. `npm run typecheck` and `npm run build` pass. Per the user rule, no tests were written or run and the server was not started.

## What's built

### World (`modules/world`)
- **Rumours.** The `world.rumours` projection holds the canonical `RumourState`. A `meta` map adds per-rumour `{sentiment, key}`.
  - **Sources:**
    - `lf.observer.moment` (salience ≥ 0.35), using a template for each built-in moment.
    - Notable signals: boss, elite and NPC kills, boss deaths, big purchases, seen thefts, threats, gifts, lies, destruction and help.
    - `lf.persona.memory` entries of kind harm, gift, witnessed or trade, with salience ≥ 0.7.
  - **Witnesses** are the NPCs in the player's zone, plus any NPCs the event names, plus `data.witnesses[]`.
  - A dedupe cooldown applies per player and rumour key.
- **Spread tick (5 s).** The chance of passing a rumour on depends on several factors:
  - Zone proximity: the same zone, a neighbouring zone, or far away.
  - Faction: the same faction, or the relation between the two factions.
  - Relationships: warm ties speed it up and rivals slow it. Gossip about a rival spreads twice as fast.
  - Gossip-prone personas, for example Pell, multiply the chance by 1.6.
  - Heat.

  Each hop records `lf.world.rumour_spread` and emits a `rumour.heard` directive. A retelling can drift through rules mutation: inflated numbers, a stronger verb, an added flourish or a hedge. Drift lowers truthfulness.
- **LLM retelling.** This is a budget-checked upgrade: fast tier, at most one per world every 45 s, moderated. It is recorded as `lf.world.rumour_mutated`.
- **Decay tick (30 s).** Heat has a half-life, and cold rumours are dropped.
- **Factions.** The `world.factions` projection holds reputation per faction per player, the relationship graph (seeded from the manifest) and a `changes` log.
  - **Reputation rules:**
    - Built-in rules: steal, threaten, gift, help, lie, kill an NPC or a faction member, destroy property, trade.
    - Designer rules via `modules.world.options.reputation`.
  - **Other reputation inputs:** `lf.persona.attitude` and `lf.quests.completed` rewards.
  - **Ripple:** a change ripples at half strength to allied and enemy factions.
  - **Standing:** when a player crosses a standing threshold (hostile, wary, neutral, friendly or honoured), a `world.reaction` "standing" directive is emitted.
  - **Attitude:** the persona memory attitude blended with faction reputation, plus a heat-weighted sentiment from the rumours that NPC knows about the player.
  - **Price:** a multiplier from the faction `priceRange`, clamped to `clamps.npc.priceMultiplier`.
  - Allies who share gossip slowly strengthen their bond (`lf.world.relationship`).
- **Reaction rules** (manifest `reactions`):
  - The `when` DSL is evaluated on signals (throttled to once per 750 ms per player) and on a 5 s tick.
  - `then` templates support `{{player}}`, `{{name}}`, `{{zone}}`, `{{gold}}`, `{{trait.X}}`, `{{stat.X}}` and `{{rep.F}}`.
  - Cooldowns are kept per player. `once: true` fires once per player. `cooldown: 0` fires on every false → true edge.
  - Each firing records `lf.world.reaction`.
  - `flavour: true` adds a cached, budget-checked fast-tier LLM call. For a persona target it emits an `npc.bark` in that persona's voice. For any other target it emits a `world.reaction` "flavour" that names an NPC and gives a bark and a plan.
- **Ask `world.reactions`** (instant, final). It returns:
  - the hottest rumours known by NPCs in the zone (or by the NPCs in `params.npcs`), with rumours about this player first;
  - the active directive drafts: reactions fired within their window, conditions true now, and standing reactions;
  - each NPC's attitude toward the player.

### Quests (`modules/quests`)
- **Projection `quests.log`.** It holds the canonical `QuestLog`, plus `offeredAt`, `personal` (generated achievements not yet unlocked), `objectives` (dynamic) and `unlocks`. It folds `lf.quests.*` events and the SDK `quest.accepted` signal.
- **`quest.offer`, instant (rules).** Templates draw on:
  - recent moments: hunt, rematch, finish the boss, hold the line, make amends, show it off;
  - hot rumours about the player ("Set the Record Straight");
  - world state: the giver's rival, or mending fences with a faction where reputation ≤ -0.3;
  - traits: explore, prove it, a new acquaintance, forge a family, spread the wealth.

  Only templates whose objective types appear in `quests.objectiveTypes` are used. Each template key can have only one open quest. The rules also handle:
  - **Giver:** chosen from `quests.givers`, preferring givers in the player's zone.
  - **Active limit:** the `maxActive` cap is respected.
  - **Rewards:** kept within `rewardTypes`, `goldMax` and `xpMax`.

  The quest is recorded as `lf.quests.offered`.
- **`quest.offer`, upgrade (rich tier).** The LLM rewrites the quest and writes the giver's dialogue (offer, accept, complete). The result is clamped back into the schema:
  - objective types must be allowed;
  - targets must come from the valid sets (npcs, zones, seen enemies and bosses, item families and seen items), otherwise the instant target is used;
  - counts stay within 1–20;
  - reward types and caps are enforced, and a reputation reward must name a faction;
  - all text is moderated.

  The quest id stays the same so the client can swap it in. `cacheKey: false`.
- **Proactive offers.** A moment with salience ≥ 0.7 makes a giver push a `quest.offer` directive (rules only, cooldown 300 s).
- **Progress.** Signals are matched against objectives: kill, defeat_boss, talk, explore, deliver, fetch, plus custom types such as `forge` matched to `forge.created`. An objective with a DSL `condition` is evaluated with its window clipped to the accept time.
  - Progress is pushed as `quest.update`.
  - On completion the module emits a `quest.update` "completed" and a giver bark, and records `lf.quests.completed` (World turns its rewards into reputation).
  - Quests expire, and stale offers are withdrawn.
- **Achievements.**
  - Designer achievements from the manifest.
  - Personal achievements from style: 18 trait templates plus designer traits. The goal is set about 1.5× above what the player already does. Each has a glyph, a colour, a `clampVfx` spark burst, a DSL condition and a rarity.
  - An optional fast-tier LLM call re-words the title and description; the condition never changes.
  - Achievements are evaluated on signals (throttled to once per 1 s), on a 5 s tick and on the ask. An unlock records `lf.quests.achievement` and emits `achievement.unlocked`.
  - The `achievement.check` ask returns new unlocks plus unlocks from the last 10 minutes that are not listed in `params.recent`.
- **Progression.**
  - Manifest `progression.unlocks` conditions are evaluated continuously. An unlock records `lf.quests.unlock` and emits a `custom.progression.unlocked` directive.
  - Suggestions are ranked by progress toward the condition (`a >= N` gives a/N; `&` takes the min and `|` the max) plus how well the unlock fits the player's style.
  - When a locked unlock reaches 75–99%, a one-time `custom.progression.suggest` nudge is sent.
- **Dynamic objectives.** They are triggered by `lf.director.decision` (boss_phase, encounter, or pacing spawn/escalate), by the moments comeback and near_death_escape, or by the game through a route.
  - Templates are chosen to stretch the player's habit; for example a dodger is asked to block or parry.
  - There are two modes. A `reach` objective completes as soon as its condition is true. A `keep` objective fails as soon as its condition breaks and completes at expiry.
  - Conditions use windows clipped to the start time.
  - The module emits `objective.dynamic`, and the result arrives as `quest.update` with `questId` set to the objective id.
  - Only one objective can be active at a time, with a 45 s cooldown.

## API added (public surface)
- World exports (`modules/world/index.ts`): `knownRumours(ctx, world, npc, {player, limit})` (for K1 barks and replies), `rumourState`, `createRumour`, `seedRumour`, `attitudeOf`, `priceFor`, `reputationOf`, `standingFor`, `standingReport`, `changeReputation`, `activeReactions` and `evaluateReactions`.
- Quests exports: `questLog`, `startObjective`, `suggestProgression`, `checkAchievements` and `designerAchievements`.
- Routes:
  - `GET /v1/m/world/rumours?world&npc&player&limit`
  - `GET /v1/m/world/standing?world&player&npcs=a,b` returns reputation and standing, attitudes, prices and relationships.
  - `GET /v1/m/world/reactions?world&player`
  - `GET /admin/m/world/state?world`
  - `POST /admin/m/world/rumour|relationship|reputation`
  - `GET /v1/m/quests/log?world&player`
  - `GET /v1/m/quests/progression?world&player`
  - `POST /v1/m/quests/objective {world, player, trigger?, text?, condition?, mode?, expiresInSec?, reward?}`
- Internal events:
  - World: `lf.world.rumour {rumour, sentiment, key}`, `lf.world.rumour_spread`, `lf.world.rumour_mutated`, `lf.world.rumour_decay`, `lf.world.reputation {faction, delta|set, reason}`, `lf.world.relationship`, `lf.world.reaction` and `lf.world.reaction_flavour`.
  - Quests: `lf.quests.offered`, `lf.quests.withdrawn`, `lf.quests.progress`, `lf.quests.completed`, `lf.quests.failed`, `lf.quests.achievement`, `lf.quests.personal`, `lf.quests.objective` and `lf.quests.unlock`.
- Module options for both modules are documented at the top of each `index.ts`. All are optional.

## Shared-file edits (additive)
- `packages/manifest/src/schema.ts`: `ReactionSchema.once: z.boolean().default(false)`. The regenerated `packages/manifest/schema/liveforge.schema.json` adds 4 lines.
- `examples/counterforge.liveforge.yaml`: two reactions, `feared_wardens_keep_distance` and `famous_challenger` (uses `once` + `flavour`). The validator says ok.

## DSL
World and Quests use K1's canonical env (`modules/observer/dsl-env.ts`, which re-exports `packages/server/src/dsl/`). They reach it only through the thin adapter `modules/world/dsl.ts`. That adapter adds `evalWith` / `evalCondition`, which return the compile error so it can be logged once, and `conditionProgress`, which gives the 0-1 progress used for progression suggestions.

I made two additive changes to the shared env (`packages/server/src/dsl/env.ts`). Neither changes how the Observer behaves unless the new option or member is used:
- **`DslEnvOptions.notBefore`:** window functions, `last` / `since` and `moment()` ignore events before this time. Dynamic objectives and quest conditions use it.
- **`LiveDslEnv.zone()`:** returns the player-model stat `zone`, else the last `movement.entered_zone`.

Trait scores are read through `env.call("trait", …)`, so they are decayed exactly as the Observer decays them.

## How to try
1. `LIVEFORGE_MANIFESTS=examples/counterforge.liveforge.yaml npm run dev`.
2. Send signals:
   - `movement.entered_zone {zone: courtyard}`
   - `economy.stole {from: pell, seen: true}`, which creates a rumour, a reputation drop for porters and a ripple to faculty.
   - `combat.killed {target: forge_titan, boss: true}`
3. Watch `rumour.heard` directives spread every few seconds (`GET /admin/m/world/state?world=…`).
4. Run `POST /v1/ask/world.reactions` and `POST /v1/ask/quest.offer {giver: pell}`, then send `quest.accepted {quest: <id>}` and `social.talked_to {npc: …}`.
5. Run `POST /v1/m/quests/objective {world, player, trigger: "boss"}`, then send `combat.dodged` signals.

## Gaps / notes
- **`progression.suggest` is not a protocol ask kind.** It is exposed as a route plus `custom.progression.*` directives. If K0 wants a first-class ask or directive kind, the logic is already in `suggestProgression`.
- **Proactive quest offers are rules only (no LLM upgrade)**, so the directive is not sent twice.
- **Rumour wording is one shared version per rumour.** NPCs do not keep separate versions; `history[]` keeps the drift.
- **Untested at runtime** (no-smoke rule). The most likely problem spots:
  - DSL evaluation cost on busy players: each pass loads up to 5000 events, throttled per player.
  - Tick fan-out with many active players: capped at 100–200.
- **Rumours are written as `lf.world.rumour` with the player scope of the subject**, and world-scope events (`rumour_spread`, `decay`) use `player: null`. The projection is world-scoped, so both fold correctly.
