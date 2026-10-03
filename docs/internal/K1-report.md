# K1 report: Observer + Persona & Voice

Branch `K1`. Merged with main up to `a1e14e6` (K0 complete). `npm run typecheck` and `npm run build` pass. No tests were written or run, per the user rule.

## What's built

### Shared DSL utility (`packages/server/src/dsl/`, re-exported from `modules/observer/dsl-env.ts`)
- `makeDslEnv(ctx, world, player, opts?)` is the canonical `DslEnv`. It implements every `DSL_FUNCTIONS` entry:
  - **Event-log windows:** `count`, `sum`, `avg`, `max`, `rate`, `distinct`, `last` and `since`. Window events load lazily, once per env.
  - **Player model:** `trait`, `stat` and `moment`.
  - **K2 projections (when present):** `rep` reads `world.factions`, and `attitude` reads `persona.memories`. When those projections are missing, both fall back to manifest faction defaults.
  - **Other:** `has` (gear tags and names), `min2` and `max2`.
  - Bare identifiers resolve to a trait score, else a stat. Unknown names evaluate to 0, and the env never throws.
- `compileRule(src)` parses once and caches by source. It returns `{run, error, refs, readsState}`. `evalRule` and `evalValue` are safe evaluators. `ruleWatches(rule, type)` lets you skip rules an event cannot affect.
- K2 usage: `import { makeDslEnv, evalRule } from "../observer/dsl-env.js"`. Build one env per evaluation pass.

### Protocol additions (additive; please relay to K0/K4)
- **DSL event filters:** `count(combat.killed{target_type=goblin, elite=true}, 10m)`. Supported operators are `= == != > >= < <=`, and values may be quoted. The filter is glued to the identifier name in the lexer. New exports: `parseDslRef`, `matchDslFilter`, `checkDslFilter` and the `DslRef` / `DslFilterCond` types. `dslSignalRefs` strips filters.
- **Built-in signals:** `movement.near_npc {npc, distance?}` and `social.approach {npc}`. Both trigger greeting prefetch.
- **Ask kind `player.model`:** params `{refreshProfile?, top?}`. The result is `PlayerModel` (without `acc`) plus `top[]`.
- **`MemoryEntry.ref?`:** lets the upgrade turn replace the instant turn.
- **`PlayerModel.acc?`:** Observer-private accumulators (decayed counters, zones seen, quest start times).
- The JSON Schemas were regenerated, including `ask.player.model.*.json`.

### Core edits (small; note for K0)
- **`core/runtime.ts`** (approved by the controller): moderated `npc.reply` text no longer returns 422 when a module answers `npc.reply`.
  - The module receives the masked text plus `params.context.moderated`, and refuses in character.
  - No upgrade is scheduled for that ask.
  - Without a handler, the request is still rejected with 422.
- **`core/fallbacks.ts`:** new `player.model` case that returns an empty model.
- **`modules/index.ts`:** `ASK_OWNERS["player.model"] = "observer"`.
- **`examples/counterforge.liveforge.yaml`:** new designer trait `hollow_hunter: count(combat.killed{target_type=hollow}, 10m) >= 5`, which shows the filter syntax.

### Observer (`modules/observer/*`)
- **`observer.player_model` projection** (deterministic; time is `event.ts`):
  - Per-event decayed counters drive the 19 built-in traits, each with a score from 0 to 1 and up to 5 evidence lines. Evidence attaches only to traits that the event pushed up.
  - `rich` and `broke` are state traits. Every other built-in is a behaviour trait and fades at read time with its own half-life.
  - Stats tracked: gold, hp, zone, kills, `kills:<type>`, deaths, gear by slot and tags, quests, hour and phase.
  - The projection also folds `lf.observer.moment`, `lf.observer.profile` and `lf.observer.trait` events.
- **Moments:**
  - Built-in detectors: `near_death_escape` (hp ≤ 15% and still alive 8 s later, or fled), `comeback`, `flawless_phase` (any `*.phase_cleared`), `betrayal` (harming a friendly persona), `absurd_purchase`, `first_kill_of_type` and `broken_promise`.
  - Manifest designer moments fire on the rising edge of their rule.
  - Each moment is recorded as `lf.observer.moment` and emitted as a `moment` directive to the player.
  - There is a per-kind cooldown, set by `momentCooldownSec`.
- **Designer traits:** each rule is evaluated when the event types it reads arrive, and every 10 s by the `observer-sweep` tick. When true, the trait is recorded at score 1. It then decays with `designerHalfLifeMin`.
- **Profile:** refreshed every `profileEvery` (40) player events, and on demand via `player.model {refreshProfile:true}`, which returns the new profile as the upgrade. Uses the LLM (rich tier, task `observer.profile`) and falls back to a rules template built from the top traits and the latest moment.
- **Ask `player.model`:** the instant answer is the decayed view, final unless a refresh was requested.
- **Admin route:** `GET /admin/m/observer/traits` returns the library, designer rules with compile errors, and the options.
- **Options** (`modules.observer.options`): `richGold`, `brokeGold`, `rangedDistance`, `speedQuestSec`, `profileEvery`, `designerHalfLifeMin`, `absurdMin`, `momentCooldownSec`.

### Persona & Voice (`modules/persona/*`)
- **Cards:** read from the manifest. Undeclared NPC ids get a generic townsperson card that may only emote.
- **Voice:** `voiceFor` gives pitch, rate, accent, style and voiceId, nudged by mood.
- **Actions:** `sanitizeActions` checks persona `allowedActions` ∩ manifest actions usable by NPCs.
  - Args are coerced, clamped and checked against enums; unknown args are dropped.
  - A missing required arg is filled with a default or the action is dropped.
  - `trade.priceMultiplier` is clamped to `clamps.npc.priceMultiplier`.
  - `reveal` needs attitude ≥ 0.35 and must name a real secret.
  - At most 3 actions per reply.
- **`persona.memories` projection:**
  - Entries carry a salience that decays by kind (harm and gifts last longest) and sharpens when recalled.
  - Attitude is seeded from the NPC's faction. Above 12 entries, the least salient is evicted into a rolling summary.
  - Repeated harms within 10 minutes only nudge attitude.
  - It folds gifts, help, threats, lies, hits, kills, seen thefts, trades, accepted quests, witnessed moments (personas in the same zone), heard rumours, and its own `lf.persona.turn|memory|attitude|summary` events.
  - The `summarise-memories` tick (fast tier) compresses large memories and records `lf.persona.summary`.
- **`npc.bark`:** the instant answer picks the first source that has a line:
  1. A prefetched greeting.
  2. The bark pool for the highest-priority context bucket: moment, rumour (from K2 `world.rumours` when present), attitude, gear, trait, time, then trigger.
  3. Rules templates.

  The instant answer avoids the last 6 lines said to that player. Buckets that fell back to templates are queued, and the `refill-barks` tick (every 30 s, at most 2 LLM calls) fills them. The upgrade is a fresh contextual bark, which is also added to the pool. Pools are seeded from manifest `barks` at init.
- **`npc.reply` instant answer:**
  - Classifies intent (greet, farewell, thanks, threat, insult, trade, ask, unknown) and returns a canned in-character line plus a safe action.
  - Examples: trade with a computed price multiplier; for threats, `call_guards`, then `hostile`, then `flee`, by what the persona allows; for questions, an answer from the glossary when a term matches.
  - Moderated, out-of-world, refused-topic and prompt-injection input gets a final in-character refusal, with no LLM call.
  - Records an `lf.persona.turn`.
- **`npc.reply` upgrade:**
  - Builds a stable system prompt from the persona card, lore bible, tone, glossary, relationships, safety rating and action list, which keeps prompt caching effective. The user message carries attitude, memories, player model, rumours, history, context and the line.
  - Uses structured JSON with `text` first. When `stream:true`, each sentence is moderated and sent with `ctx.chunk`, within the length clamp.
  - Then applies output moderation, length clamp and action sanitising.
  - Records the turn with the same ref (replacing the instant one) and applies only the mood delta.
  - A `quest_offer` action also records `lf.persona.quest_offer {npc, askId, context}` for K2.
- **Prefetch:** `movement.near_npc` and `social.approach` generate a greeting in the background (LLM only, budget-checked, 2-minute cooldown). The next `npc.bark {trigger:"approach"|"greeting"}` serves it with `source:"cache"`.
- **Routes:**
  - `POST /v1/m/persona/stt?npc=<id>&language=en` (multipart `audio` or a raw `audio/*` body) returns a `SttResponse`. Recognition is biased to that NPC's name and knowledge plus the glossary.
  - Core `/v1/stt` still exists. Browser STT just sends text to `npc.reply`.
  - `GET /admin/m/persona/pools` returns the bark pools and the queued refills.

## How to try it
1. `LIVEFORGE_MANIFESTS=examples/counterforge.liveforge.yaml npm run dev`.
2. Post signals, for example `economy.gold {amount: 900}` and `movement.entered_zone {zone: courtyard}`. Then:
   - `POST /v1/ask/player.model` should show `rich` about 0.9 with evidence.
   - The K2 `pickpocket_rich` reaction can read the same values through `makeDslEnv`.
3. `POST /v1/ask/npc.bark {npc:"kit", trigger:"approach"}` returns a trait line ("Heavy purse you've got there.").
4. `POST /v1/ask/npc.reply {npc:"pell", text:"How much for a map?"}` returns a trade action with a priceMultiplier. With a key set, the upgrade follows, streamed when `stream:true`.
5. `combat.hurt {hp:0.05}`, then `movement.fled` produces a `near_death_escape` moment directive.

## Gaps / notes
- `quest_offer` cannot call K2's quest generator directly, because ctx has no cross-module ask API. Two routes are available:
  - K2 can subscribe to `lf.persona.quest_offer`.
  - The game can call `quest.offer {giver}` when it sees the action.
- Witnessed moments only reach personas whose manifest `zone` matches the player's last `movement.entered_zone`. Live NPC positions are not modelled.
- Window functions compare `event.ts`, which is client time for signals. Large client clock skew distorts windows.
- Designer trait scores are binary (1 while the rule holds, then decay). There are no graded designer scores.
- If K4 typed anything exhaustively over `AskKind` or `BUILTIN_SIGNALS`, it needs the new `player.model` kind and the two new signals.
- `npm install` in this worktree needed `--ignore-scripts`: the better-sqlite3 native build fails here. That only affects running the server from this worktree, not typecheck or build.
