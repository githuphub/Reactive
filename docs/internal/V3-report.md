# V3 report: Livecraft × Liveforge integration, Brain View, Demo panel

**Status:** built on Livecraft `main` (no other lanes running). `npm run typecheck` and `npm run build` pass. Per the
user rules I wrote and ran no tests, did no browser smoke, never called or started the Liveforge server, made no live
API calls and read no key files. Nothing here has been seen running yet.

## Commits

Livecraft `main`:
1. `e616eb3` chore: link Liveforge packages (`scripts/link-liveforge.mjs`, pre dev/build/typecheck), dedupe three
2. `2becf3e` feat(liveforge): offline-safe service, signals, villager agent tools, builder placement with ghost preview, Brain View
3. `0c61d28` feat(liveforge): chat + voice + goals, barks, directives, village mind posture, adaptive raids, quests, grief/amends chain with statue
4. `8a2cbf8` feat(forge): forge anything → voxel items; held-item mesh hook
5. `79ed00a` feat(demo): plugin wiring, Demo panel, captions, status badge, pause-menu entry
6. (this commit) docs: README, demo script, V3 report; small fixes (forge save reload, Bram stays put in scenario 1)

Liveforge `main`: `0c62935` examples: livecraft manifest currency is coins (lore, glossary, Mara's personality and
secret; emeralds → coins).

## How to try it

```bash
# Liveforge (../Liveforge)
PORT=8790 LIVEFORGE_MANIFESTS=examples/livecraft.liveforge.yaml npm run dev
# Livecraft
npm run dev        # http://localhost:5180/?demo
```

- Without a server (or with `?lf=off`) everything runs on local rules. The badge shows *Offline · local rules*.
- Console: `lf` (the service: `lf.client` is the SDK client) and `lfHub`.
- Keys: **T** chat, **hold V** voice, **F** forge, **B** Brain View. The pause menu has a **Demo panel · Brain View**
  entry.
- The video script and the record → replay workflow are in `docs/demo-script.md`.

## What's built

### Service (`src/liveforge/service.ts`, `config.ts`)
- Config, in priority order: the `?lf=` URL param, then `VITE_LIVEFORGE_URL`, then the default
  `http://localhost:8790`.
  - Key `pk_dev_livecraft`.
  - World `lc-<seed>`, or the world saved by *Reset memory*.
  - Player id: a stable random id kept in localStorage.
  - `?lfname`, `?lfdash`, `?cassette`, `?demo`.
- `LiveforgeService` wraps one SDK client and never throws into gameplay.
  - Status: `off` / `connecting` / `online` / `offline`, retried every 15 s.
  - Persona voices come from `/v1/config`.
  - While offline, asks use a short timeout so the local answer comes fast.
  - `think()` adds local Brain entries.
  - An `online` event fires each time the server comes back; tools are re-registered then.
- **Cassette label.** The SDK key can't read `/admin/cassettes`, so the label works like this:
  - `?cassette=` / `VITE_LIVEFORGE_CASSETTE` force it.
  - Otherwise it is detected from server Brain badges (any `replay` → REPLAY, `sonnet`/`haiku` → LIVE), and from
    `/health` `llm` (false → RULES).
  - OFFLINE when the server is unreachable.
- **Offline fallbacks** (`rules.ts`, `client.setFallback`):
  - `npc.reply` and `npc.bark`: persona-flavoured rules.
  - `faction.raid_plan`: a local port of the counter-table, fed by a local habit tally.
  - `builder.plan`: the SDK's template planner, with Livecraft block ids.
  - Agent goals: the SDK's local template runner.

### Signals (`signals.ts`)
- **Blocks.**
  - `block.broken` / `block.placed` carry `owner` (manifest id, from `village.ownerAt`), `village` and `tool`.
  - Breaking an owned building block also sends `world.property_damaged {object: buildingId, owner, value, zone}`.
- **Combat.** `combat.killed` (raid captain = elite), `combat.hit`, `combat.hurt`, `combat.died` and
  `combat.shot_bow` (throttled).
- **Play style.** `build.pillared` (throttled: once per 3 s unless the pillar grows) and `combat.hid`.
- **Items.**
  - `item.crafted`. Smelting is sent as `item.crafted` too, because the manifest declares no `item.smelted`.
  - `item.forged`.
- **Economy.** `economy.bought` / `economy.sold` (vendor + coins), `economy.haggled` and `economy.gold` (coin balance,
  debounced).
- **Social.** `social.talked_to`, `social.said` and `movement.near_npc`.
- **Movement.**
  - `movement.entered_zone` and `movement.visited` for manifest zones: oakhollow, bram_plot, farm, smithy (shop),
    library (interior), mines, oak_forest.
  - `movement.visited` for biomes.
  - `movement.sprinted` (sprints over 6 s, which also count as kiting).
- **World.**
  - `world.time {hour, day, weather, phase}` on phase and weather changes and every 60 s.
  - `night.survived` at dawn.
- **Appearance.** `appearance.outfit`: tunic, trousers, boots, plus the held item with forged tags and colours.
- **Session.** `session.started` with `last_seen_ts` (from localStorage).
- `HabitTally` keeps 20 minutes of pillaring, bow, hiding, melee, kiting and fire, for offline raid plans.

### Agent tools (`tools.ts`, `build.ts`, `ghost.ts`)
- **Registration.** `lf.agents.register(id, tools)` runs for every named villager under manifest ids (`bram`, `mara`,
  `hilde`, `pip`, `captain_rowan`, `iron_golem`): at `village.ready`, and again on every reconnect.
- **The 14 manifest tools** map onto `VillagerController`.
  - Inputs also accept the rules planner's field names (`item` for `block`, `target` for `post`, `to`, `from`).
  - Post words are mapped: `square` → plaza, `walls` → gate, `home:<npc>` → that house, `player:<id>` → player.
  - Outputs are short JSON; failures throw, so the model sees `ok: false`.
  - The golem's `say` becomes an emote.
- **`build`** (`runBuild`):
  1. `builder.plan` at Bram's plot, sized to the plot (or a named site), with optional width/height/depth.
  2. The instant template is shown at once (a local 📐 entry when the answer came from local rules).
  3. Bram walks to the plot. When online, he "thinks" for up to 15 s from the ask while the AI plan may arrive.
     An upgrade that lands before the first block replaces the plan.
  4. `expandVoxelPlan`, through `lf.client.builder.expand`, with Livecraft `BLOCK_IDS` (no air or liquids), extra
     aliases and fallback `oak_planks`, at the plot origin.
  5. A **ghost preview** (an instanced translucent cube per block that disappears as the real block lands) shows
     while V2's `buildPlan` runs. It runs at 6 blocks/s, with yard fetching, scaffolds and narration.
  6. Progress goes out through `progress()`, which becomes `agent.tool_progress`.
  7. The result is `{ok, name, placed, total, source, materials}`.
- **Repair prompts.** A prompt with "repair/fix/mend/rebuild…" co-builds `village.repairPlan(<most damaged or named
  building>)` instead. So "Bram, help me repair Mara's house" works both with the rules template and with Sonnet.
- **World context.** `lf.agents.setContext('*', …)` is sent every 10 s when it changes, while online. It covers the
  day and time, weather, where the player is relative to the plaza, held item, inventory highlights, nearby
  villagers, hostiles, posture, prices and damaged buildings. Goals also carry the NPC's own situation.

### Talking (`talk.ts`, `voice.ts`, `barks.ts`)
- **Chat.** T opens chat with the villager under the crosshair (else the nearest within 6 blocks). The villager
  menu's *Talk* opens it too.
  - The screen has a face header, a log, suggestion chips, Send and a 🎤 hold button. It does not pause the game.
- **Replies.** `npc.reply` (with history and the world summary as context) streams `onPartial` into the log. The
  speech bubble shows the instant answer, then the upgrade.
  - Actions run: `trade`, `quest_offer` (asks `quest.offer`), `follow`, `give`, `build` (agent goal), `guard`,
    `emote`, `flee`, `hostile`, `call_guards`.
- **Goals.** The manifest has no `agent_goal` action, so a keyword heuristic decides (`isGoalRequest`: build / bring
  / fetch / follow / guard / repair …; a leading "Bram," is stripped). A request goes to `lf.agents.goal(npc, text,
  {context})`, and reply actions of the same kind are skipped.
- **Voice.**
  - Hold V in game: the SDK `Mic` (browser speech recognition, else recorded audio → server STT). The transcript
    goes to the nearest villager.
  - Villager lines are spoken with browser TTS in the persona voice. Voices are on in `?demo` and can be toggled in
    the Demo panel.
- **Barks.** Coming within 5.5 blocks of a named villager sends `movement.near_npc` and asks `npc.bark` (approach).
  It is throttled to once per 60 s per villager and once per 12 s overall. Reaction Library lines arrive as
  directives.

### Directives (`directives.ts`)
- **Speech and actions.** `npc.bark`, `npc.action`, `rumour.heard`.
- **`custom.reaction`.** The spoken `line` / `lines` play in turn. Effects:
  - `repair_quest`: the owner walks over and glares, and the quest card opens.
  - `nickname`: stored, used for the statue and prompts; toast and caption.
  - `town_mood`: price multiplier.
  - `pickpocket` / `tax`: coins are taken.
  - `price_gouging` / `price_adjust`: toast.
  - `guards`: golem confront, and Rowan guards the player.
  - `behaviour` / `recap` / `concern`: their lines.
  - Any payload `quest` becomes an offer.
- **Village mind.**
  - `custom.faction_posture` → `village.setPosture` + `setPriceMult`, Rowan's announcement bubble and voice, and a
    caption.
  - `custom.guard_posts` → `controller.guard(post)`.
- **Quests.** `quest.offer`, `quest.update`, `achievement.unlocked`.
- **Others.** `custom.statue` (statue_for_the_mender), `forge.ready`, `moment` (toast). `agent.tool_call` /
  `agent.done` are handled by the SDK, scoped to the asking player; a toast shows the run summary.

### Raids (`raid.ts`)
- **Triggers.** The Demo button, or nightfall (phase `night`) on day ≥ 1, once per night.
- **Plan.** `faction.raid_plan {faction: oakhollow, night, size: medium}`. Offline, the local counter-table writes
  🏰 threat model → plan → why entries.
- **Waves.** V1 `spawnWave` with the mapped tactic:
  - climb → `climb_pillar`
  - shield_rush → `rush` + shield
  - tunnel / dig_in → `tunnel`
  - crossfire / spread / keep_distance → `keep_distance`
  - flank / harass / cut_off → `flank`
  - fire_resistant → fireproof
  - run_down → rush ×1.15
- **Spawn kinds.**
  - edge → a ring of 20 around the player
  - underground → near, tunnelling
  - rooftops → random within 16, `rooftops`
  - behind_player → a point 12 blocks behind
- **Timing.** The first wave comes after 5 s, the others on their `delaySec`. An upgraded plan replaces waves that
  have not spawned yet.
- **Captain.** A named mob with 40 hp and a name tag + taunt bubble (V2 `BubbleLayer`), plus a caption. The tag is
  removed when it dies.
- **Defence.** Rowan guards the player's position and shouts; the golem guards beside him. `reportThreat` goes to
  the faction.

### Quests (`quests.ts`)
- **Offers** are deduped by id. The offer card (Accept / Not now, Enter accepts) queues behind other screens. The
  giver says the offer, accept and complete lines.
- **Tracker** (top-left) with game-measured objectives, sequential (an objective only progresses once the earlier
  ones are done):
  - repair: `repairTracker.restoreProgress() / 0.8`
  - fetch: item count
  - kill: count, by mob type
  - talk / deliver: talked to the target
  - survive: a dawn
  - explore: zone
  - forge: count
- **Signals and rewards.** `quest.accepted` / `quest.completed` / `quest.failed` (declined). Item and coin rewards are
  given; achievement toasts show glyphs.
- **Saved** in the slot `lf_quests`.

### Grief / amends (`amends.ts`)
- **Grief.** 3 breaks of Mara's house within 60 s start the chain.
  - **Online:** the server drives it. A local quest offer follows after 12 s only if none arrived.
  - **Offline:** the same beats on rules. ✨ property_damage → Mara runs over and glares → Pip spreads the rumour →
    posture wary, prices ×1.25, Rowan announces → the repair quest is offered.
- **Make amends** gives the exact missing blocks as items and accepts the repair quest.
- **Bram, help me repair it** gives an agent goal (the build tool co-builds the repair).
- **Repair ≥ 80 %:**
  1. `world.helped` + `social.gave` (trust).
  2. Offline: posture calm, prices ×1, the *Mender* achievement, the nickname "the Mender".
  3. The statue: `builder.plan` "a statue of <nickname or name> in their outfit colours" with real block ids
     `[green_wool, blue_wool, birch_planks, spruce_planks]`, placed on the plaza by `village.spawnStatue` with a ghost
     preview while Bram narrates.
  4. Online, the server's `custom.statue` triggers the statue. A local fallback runs after 15 s, because Bram's
     co-built blocks are not player `block.placed` signals and may never satisfy the server rule.

### Forge (`forge/*`)
- **Entry.** F, or the Demo button (pre-filled). The screen has a prompt, an optional base tool (auto / pickaxe …
  bow), Forge, a 🎤 hold button and a result card.
- **Ask.** `forge.item {prompt, family?, context}`. The instant answer is used at once; the AI upgrade replaces the
  item in the same hotbar slot. Offline, `localForge` maps prompt words.
- **Mapping.**
  - Shape from family / prompt.
  - Effect: from the tags, else the element, else prompt words.
  - Palette: `blueprint.palette[0..2]` plus the glow from the particles / trail colour.
  - Stats: speed, damage, durability, mining → tier.
  - An AI `pixels` grid (16 strings of palette indices) is used when the result has one; the protocol has no such
    field today, so it is read loosely.
- **Icon.** Rules pixel art: a silhouette per tool shape, an outline, a highlight, glow pixels and lightning sparks.
- **Model and item.** The held model is an extruded voxel mesh. The item is a registered tool (texture, item with
  tool stats and tags) with a V1 recipe; the patterns use tier material + effect catalyst + sticks, and the card
  shows the 3×3 grid.
- **Effects** (`effects.ts`):
  - `chain_lightning`: up to 6 connected same blocks, with jagged arcs and particles.
  - `vein_mine`: up to 12.
  - `fire_trail`: flames while moving; nearby hostiles burn.
  - `knockback_burst`: hostiles within 4 are blasted and take 2 damage.
  - `heal_aura`: +1 every 2 s while held.
  - `frost_slow`: the target moves at 40 % speed for 4 s.
- **Records.** Brain ⚒ entries (forge has no server Brain hook), `item.forged`, the quests forge counter, and a
  caption.
- **Saved** in the slot `lf_forge`. Saved items are re-registered on load, then the inventory is reloaded, because
  V0 drops unknown stacks.

### Brain View (`src/ui/brain/*`)
- **Panel.** Bottom-left, 420×300, semi-transparent. Hidden unless `?demo` or B. It sits in an overlay above the
  screen stack, so it stays clickable while paused.
- **Grouping.** By `ref` (run / ask), else source + actor in 15 s buckets. The header shows the actor's pixel face (a
  villager's real look colours, or glyphs for the village mind, director, forge and builder) and the goal text.
- **Rows.** 💭 thought (italic), 🔧 `tool(input)`, ✅/❌/⏳ result, 📐 plan (ops, block count, top materials), 🏰
  faction decision / 🗺️ raid plan / 🧠 threat model, 🎯 director, ✨ reactions, ⚡/⚒ forge, 🏁 run end. Each has a
  model badge (SONNET purple, HAIKU teal, RULES grey, CACHE blue, REPLAY amber) and ms.
- **Behaviour.** Auto-scroll (📌 locks it), pin a group on top, click a row to expand its JSON, clear, collapse,
  hide. The header shows status · cassette.
- **Ghost preview** (`liveforge/ghost.ts`): see the build tool above.

### Demo panel (`src/ui/demo/*`, `liveforge/scenarios.ts`)
- **Where.** `?demo` shows it top-right; the pause menu has a "Demo panel · Brain View" entry, injected into V0's
  pause screen DOM.
- **The four scenarios** and their utilities: see `docs/demo-script.md`.
  - 🏠 Build me a house: noon, Bram at his plot, you face him, he waves, and the chat opens pre-filled.
  - 🌙 Night raid: 6 pillared + 10 bow signals (and the local tally), bow, arrows, sword, cobble, survival, clears
    natural hostiles, dusk, then the raid.
  - 🔨 Grief / 🤝 Make amends / 🧱 Bram, help me repair it.
  - ⚡ Forge anything.
- **Utilities:**
  - Day/Night, Rain, Creative, Give kit (V1 `giveItem`)
  - Reset memory: a new Liveforge world id for the seed (saved), posture calm, Brain cleared
  - Dashboard: `window.open` on the right half
  - Brain View, Captions, Voices
  - Cassette label
- **Status badge** (always visible, top-right) and the **caption strip** (bottom).

### Docs
- `README.md`: run instructions, URL params and controls.
- `docs/demo-script.md`: the 3-minute shot list, what the judges see, and the record → replay workflow.

## Shared-file edits (outside my folders)

- `package.json`: scripts `link:liveforge`, `predev`, `prebuild`, `pretypecheck`.
- `vite.config.ts`: `fs.allow` for the linked Liveforge folder, `resolve.dedupe: ['three']`, `optimizeDeps` (copied
  from Counterforge).
- `tsconfig.json`: `include` is now `["src"]`. `vite.config.ts` uses `node:` modules and Livecraft has no
  `@types/node`; Vite compiles its config itself.
- `src/player/held-item.ts` (V0): an additive `heldMeshFactories` hook that is tried before the default cube/sprite.
  The forge uses it for the extruded models.
- New: `scripts/link-liveforge.mjs`, `README.md`.
- Liveforge `examples/livecraft.liveforge.yaml`: emeralds → coins (4 lines), commit `0c62935` on Liveforge `main`.

No V1 or V2 source file was edited. Hooks used: `village.onTalk`, the controller API, `village.*` (posture, prices,
repair, statue, bubbles), V1 `spawnWave` / `spawnMob` / `getSpawnDirector` / `giveItem` / `takeItem` /
`registerRecipe` / particles / health, game events, `game.save.register`, and UI screens.

## Gaps and concerns

- **Never run.** Riskiest:
  - Pointer lock and focus between the Demo panel, the pause menu and the chat.
  - Placement of the overlay above screens.
  - The ghost InstancedMesh.
  - The extruded mesh orientation and placement in the hand.
  - Raid spawn spots (`behind_player`, `underground`).
  - Captain bubble anchoring.
  - Whether `npc.reply` streaming and the agent loop behave against the live server.
- **Cassette label** is inferred (there is no public mode endpoint). RECORD can only be shown with `?cassette=record`.
- **Agents are scoped to the asking player.** Other clients see only Brain entries and block changes.
- **Statue colours** are fixed outfit colours mapped to the closest Livecraft blocks. Livecraft has 6 wool colours;
  the teal tunic becomes green wool. The statue site is padded to 5×9×5 and may overhang the 4×4 statue spot by a
  block.
- **Forge:**
  - The online instant is the server's rules item. AI pixel grids are used only if the result carries a `pixels`
    array, which the protocol does not define.
  - Each AI upgrade registers a new item id (ids must stay unique), and they are all saved.
- **Quests:** DSL `condition`s are not evaluated in the game. Objectives are measured locally (see above), plus
  server `quest.update`.
- **Online grief chain:** it relies on the server's reaction and rule timing. A local quest offer and statue
  fallback cover misses, but the online and offline beats can overlap (two posture announcements are possible if the
  server answers late).
- **`agents.setContext`** is only sent while online. Offline local runs don't need it.
- **Raid by nightfall** fires from day ≥ 1 (the second night), once per night, and only when no raid is running.
- **`item.smelted`** is sent as `item.crafted` (only declared signal types pass).
