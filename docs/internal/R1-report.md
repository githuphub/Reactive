# R1 report: Reaction Library

**Branch:** `R1` (worktree `F:/Development/Liveforge-R1`, based on `main` at `1b576e0`).

`npm run typecheck` and `npm run build` pass. Both example manifests validate with `liveforge-validate`.

**Not run:**
- No tests were written or run (user rule).
- The server was never started.
- There were no live API calls, and no key files were read.
- The Godot code is hand-checked only.

## What was built

### Protocol (`packages/protocol`)
- **New built-in signals** (fixed names from the brief):
  - appearance: `appearance.state`, `appearance.outfit`
  - world: `world.time` (gained `weather?`), `world.property_damaged`
  - social: `social.promise`, `social.promise_kept`, `social.promise_broken`, `social.claim`
  - economy: `economy.haggled`
  - combat: `combat.boss_attempt`, `combat.phase_flawless`, `combat.fled`
  - other: `companion.died`, `session.started`, `movement.visited`
  - New namespaces: `appearance`, `companion`, `session`.
  - New field types `boolean|null` (claim truth) and `number|string` (promise due). The SDK maps both.
- **`reactions.ts`:**
  - `REACTION_RECIPES`: the catalogue of 20 recipes, with signals, directives, effects and params.
  - `COMMON_RECIPE_PARAMS`, `WEATHERS`, `dayPhaseOf`.
  - `ReactionInfo` and `ReactionDirectiveArgs`.
  - The `ReactionLedger` state, registered as the canonical projection `world.reaction_ledger` (player scope).
- **Directives:**
  - `custom.reaction` is now a typed directive kind: `{recipe, target, payload, line?, reaction?}`.
  - `npc.bark` gained an optional `reaction`.
- JSON Schemas regenerated. `index.json` now also lists `reactionRecipes`.

### Manifest (`packages/manifest`)
- `reactions` accepts the old list (rules) or `{rules, library, params, engine}`.
- The parsed form is always `{rules, library: [{recipe, params}], engine}`.
- Library entries can be:
  - ids
  - `{id: params}`
  - `{recipe, ...}`
  - `all`
- The validator rejects unknown recipe ids (with a "did you mean" hint) and warns about unknown params. It
  type-checks number and boolean params, checks `when` DSL, and warns about undeclared personas.
- Call sites updated: world module, validator, dashboard manifest panel.

### Server core (`packages/server/src/core/combination/`)
Pure, deterministic code:
- facets → stable fingerprint plus a readable context sentence
- novelty-checked seeded variant picking (a variant in the ledger counts as used even with a tic or aside added)
- template filling and combination weighting
- woven facet asides (at least 6 per facet kind)
- persona voice tics
- the do-not-repeat prompt block

### World module (`modules/world/reactions-lib/`)
- `state.ts`: the ledger projection. It folds the new signals, `gear.*` and `lf.reactions.*`. It holds the novelty
  ledger, cooldowns, use counts and the fired log.
- `facets.ts`: builds the situation for a speaker and player:
  - traits, moments, outfit, colour and style
  - appearance, time and weather, zone
  - rumours that NPC knows, attitude
  - nickname and library statuses
- `kit.ts`: `RecipeRun`.
  - Speakers, cooldowns, a seeded `chance`, and the `when` gate.
  - `say` (combination engine → `npc.bark`, or `boss.adapt`, or `custom.reaction` with the line in the payload).
  - `effect`, `rumour`, `attitude` / `reputation` (through persona and world events), `quest` (a manifest-clamped
    Quest recorded in `quests.log` plus a `quest.offer` directive).
  - Background AI variants: budget-checked, at most one call per world every 20 s, moderated, placeholders
    preserved.
- `recipes/{npc,social,economy,boss,world}.ts`: the 20 recipes, each with at least 6 variants per line pool.
- `engine.ts`:
  - the registry, signal handler and 5 s tick
  - Persona hooks: `libraryBark`, `libraryContext`, `libraryReplyInstant`, `recordLlmClaim`, `noteLine`
  - Director hooks: `libraryHabits`, `libraryBossPhase`
  - `libraryState` for the admin route `GET /admin/m/world/reactions-lib`

### Integration
- **Persona:**
  - `npc.bark` instant serves the best-scoring recipe line first (after a prefetched greeting).
  - Bark and reply upgrades get the context sentence, recipe notes and do-not-repeat lines.
  - Persona's own lines enter the novelty ledger.
  - `npc.reply` instant detects promises and checkable claims (rules) and answers in character.
  - The reply upgrade schema gains a `claim` field, but only when `lies_caught` or `promises_remembered` is on.
- **Director:**
  - The habit read adds dodge directions from boss attempts.
  - `boss_phase` uses attempt-aware taunts and adds the flawless secret move.
  - Boss recipes record `lf.director.decision` with the recipe and facets.
- **Observer:**
  - A false claim counts as a lie, and `combat.fled` counts as fleeing.
  - `combat.phase_flawless` gives `flawless_phase`, and `social.promise_broken` gives `broken_promise`.
- **Quests:** revenge, repair and explore quests go through the normal quest log and directive path.

### SDKs
- **JS:** `autoEmit(lf, opts)` returns an `AutoEmitter`:
  - `session.started` with a last-seen time kept in storage
  - a `world.time` clock (yours or simulated) with `setWeather` / `setTime`
  - appearance with decay and a change threshold
  - outfit sent only on change
  - `visited` / `left`
- **Godot:**
  - The autoload sends `session_started()` on start (setting `liveforge/auto/session_started`) and gained
    `set_world_time`, `set_weather`, `set_appearance` / `add_appearance` (with `appearance_decay`), `set_outfit`,
    `visited` and `left_place`.
  - New nodes: `LiveWorldClock` and `LivePlace`.
  - `LiveforgeUtil` gained the new signals, `REACTION_RECIPES` and `day_phase`.
  - The village sample now has a clock with a sun, appearance decay, and an inn `LivePlace`.

### Example manifests
- Counterforge enables all 20 recipes with params: Kit (pickpocket, loan shark, thief), Pell (healer, merchant,
  owner of inn and market, giver), Vale (companion recap), Marrow (revenge giver), and `slag_imp` as the challenger
  unit.
- The Godot village enables 17.

### Dashboard
- A new **Reactions** panel (World group):
  - recipes and params
  - fired reactions with speaker, line, effect, fingerprint, facet chips and `why`
  - per NPC: fingerprint, facet chips, context sentence and novelty ledger
- The why feed and the Director timeline show a recipe badge and facets for library directives and decisions.
- Demo mode shows "not available" for this panel. There is no synthetic data.

### Docs
- `docs/reactions.md`: the engine, signals, the auto-emitters, every recipe with its params, and the exact
  `custom.reaction` payload for each.
- README section "50 ways your world reacts (20 shipped)".
- References updated in `manifest.md`, `protocol.md`, `dashboard.md` and the docs index.

## Coordination with R2
- `custom.reaction` payloads follow the Counterforge handler:
  - `payload.effect` is always set, and the line travels in `payload.line` + `payload.npc`, so a line with an
    effect sends no separate `npc.bark`.
  - Keys: `amount`, `item` (a display name), `object`, `boss`, `direction`, `quest` (a full Quest), `nickname`,
    `mood` (-1..1), `price_mult`, `lines[{npc, text}]`.
- Effects renamed to the names R2 handles: `price_gouging`, `theft`, `collect_debt`, `recap`, `quest_pull`.
- `social.promise.due` may be a readable string. The game then owns that timing; the server never auto-breaks it.

## Concerns
- **Never run.** The likeliest runtime surprises:
  - Event volume: every fired reaction records `lf.reactions.fired` plus directives.
  - Re-entrant signal dispatch depth (the core caps it at 8).
  - The cost of `buildSituation`: it reads rumours and attitude, and is called a few times per firing.
- **Bark preference.** The library line wins over Persona's own buckets whenever any recipe has an offer and its
  per-NPC bark cooldown (at least 45 s) allows it. This may crowd out Persona's moment and rumour barks. Tune it
  with recipe `cooldownSec`, or by adding a score threshold in `libraryBark`.
- **Timing rules.**
  - Promises without a due time only get a reminder and never auto-break.
  - Numeric dues auto-break 60 s late.
  - Loans need `social.promise {ref: "loan_..."}` (with `owed`) to be tracked as debts. R2's own loan flow uses
    its own promise, which the server treats as a normal promise.
- **Shared-file edits.** These touch other lanes' areas (all additive): protocol, the manifest schema (`reactions`
  output shape changed to `{rules, library, engine}`), the persona barks/reply, director boss/habits, observer
  moments/traits, the world index/routes, the SDK `types.ts`, the Godot autoload and util, and dashboard
  main/overview/director/types/admin.
- **The `reactions` shape change.** Third-party code that read `manifest.reactions` as an array must now use
  `manifest.reactions.rules`.
- **Not covered:**
  - The Persona npc.reply claim heuristics are regex based (English only).
  - The LLM claim classification adds a schema field, which changes the reply prompt-cache key once.
