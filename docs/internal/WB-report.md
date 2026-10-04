# WB report: Journal, rumour board and gossip, achievements and quest chains, villager makeovers, Hyper3D

**Status:** built on branch `WB` (worktree `F:/Development/Livecraft-WB`). `npx tsc --noEmit` and `npm run build`
pass. As the user asked, I wrote and ran no tests, did no browser smoke, made no live API calls and read no key files.
Nothing here has been seen running yet.

The boss lane (WA) was dropped mid-wave. WB therefore has no `bossDefeated` / `bossStarted` declarations or hooks, and
no boss achievements, rumours or journal entries.

## Build environment problem (important)

At about 11:33 today, `F:/Development/Liveforge/packages/protocol`, `sdk-js` and `sdk-three` were emptied in the
working tree. Git shows ~180 tracked files as deleted, and the built `dist/` folders are gone too. WB didn't do this:
I ran no commands in Liveforge, and my only link step ran at 11:19. The likely cause is a `rm -rf node_modules` (or
similar) in some worktree whose `node_modules/@liveforge/*` are directory junctions into Liveforge. Deleting through a
junction deletes the target's contents.

- I did not modify the Liveforge repo.
- To typecheck and build, I exported Liveforge `HEAD` (`git archive`) into my scratchpad and built `protocol`,
  `sdk-js` and `sdk-three` there.
- I pointed this worktree's links at that copy with
  `LIVEFORGE_DIR=<scratchpad>/lf node scripts/link-liveforge.mjs`.
- **Fix:** in Liveforge, run `git checkout -- packages` and rebuild (`npm run build`). Then run
  `npm run link:liveforge` here so the links point back at `../Liveforge`. `predev` / `prebuild` do that automatically
  when `LIVEFORGE_DIR` is unset.
- Never `rm -rf node_modules` in a worktree with linked Liveforge packages. Remove the `node_modules/@liveforge`
  junctions first.

## How to try it

- `npm run dev`, then go to `http://localhost:5180/?demo`.
- Press **J** to open the Journal. Number keys 1–5 switch tabs.
- Demo panel buttons (one delimited block in `scenarios.ts`):
  - **📜 Start a rumour**: teleports you to the plaza facing the notice board. Pip "saw you pinch a pie from Mara's
    windowsill". The rumour forms at once, then spreads to three villagers in about 30 s (hops at roughly 4, 13 and
    22 s). Each retelling usually changes the words.
  - **🔗 Quest chain**: starts "Mara's Trust" (three chained quests).
  - **🎩 Makeover**: Bram gets a hard hat and tool belt, Mara a red scarf, Rowan a plumed helmet. The AI restyle
    follows if the server answers.
  - **📖 Journal**: opens the Journal.
  - **🧊 Upgrade to 3D**: requests a Hyper3D mesh for the last forged item.
- Right-click the notice board on the plaza to open the Journal's Rumours tab. Looking at the board shows a hint and
  refreshes the rumours.
- Console: `wb.world` (`rumours`, `achievements`, `chains`, `makeovers`, `mesh`, `stats`), `wb.journal.open('they')`,
  `wb.memories`.

## What's built

### Plugin and layout
- **`src/journal/`**: the plugin (`plugin.ts`, order 60, after liveforge's 50), `journal.ts`, `memories.ts`,
  `profile.ts` and `styles.ts`.
- **`src/liveforge/world/`**:
  - `index.ts` (`initWorld` / `getWorld`), `events.ts`, `stats.ts`, `styles.ts`, `demo.ts`
  - `rumours/`: `rumours.ts`, `local.ts`, `gossip.ts`, `board.ts`, `index.ts`
  - `achievements/`: `achievements.ts`, `list.ts`, `chains.ts`, `objectives.ts`
  - `makeovers/`: `makeovers.ts`, `accessories.ts`
  - `mesh/`: `mesh.ts`

### Player stats (`world/stats.ts`, slot `wb_stats`)
- **What it counts** (lifetime counters plus 30-minute windows), from Game events:
  - blocks broken, placed, and placed in the village
  - kills by mob type, deaths by cause
  - trades and haggles (and haggles won)
  - griefs and villager hits
  - crafting and forging (forged names)
  - talks, people met, nights survived
  - arrows, pillars, distance walked
  - quests, rumours about you, makeovers
- **Moments:** a journal "moments" list.
- **`recent()`:** about 20 signal-like strings (repeats collapsed, e.g. `"block.placed oak_planks ×12"`), sent as
  `achievement.check {recent}`.

### Rumours and gossip (`world/rumours/*`, slot `wb_rumours`)
- **RumourBook** merges three sources by id:
  - **`world.reactions {zone: 'oakhollow', npcs}`.** Polled every 30 s while online, and about 2.5 s after griefing,
    deaths and dawn. Also polled when you look at or right-click the board. The first poll after (re)connecting only
    syncs. After that, new `knownBy` holders become hops. The returned attitudes are kept for the Journal.
  - **`rumour.heard` directives.** V3's `directives.ts` hands these over through a new `hub.onRumourHeard` hook. The
    teller is parsed from the directive's `why` ("Pip told Mara (and embellished it)"). "X witnessed it" means X
    started the rumour.
  - **The local engine.**
- **Game events:**
  - `rumourCreated`: a new rumour formed.
  - `rumourSpread {from, to, content, previous, mutated, source}`: someone passed a rumour on.
- **Local engine (offline rules)** starts rumours from:
  - griefing (3 breaks; the owner starts it)
  - 20 blocks placed in the village in 3 min
  - dying near the village
  - 6 kills in 2 min
  - a won haggle
  - a finished quest (a kind rumour)

  Every 9 s it moves the hottest local rumour one hop. The teller is the holder nearest you; the listener is the
  non-holder nearest the teller. A rumour stops at 4 holders.
- **Mutation** (65 % chance per hop):
  - escalating verbs: broke a hole in → smashed up → wrecked → flattened half of; pinched a pie → stole three pies →
    made off with a whole cartload of pies
  - doubled numbers, or a tail ("At midnight, no less!")
  - each villager's way of telling it (Pip "In confidence:", Rowan "Report:", Mara "Bless me,"…)

  Truthfulness drops 0.15 per mutation. While online the engine doesn't start rumours (the server forms its own), but
  it still spreads local ones and the Demo rumour.
- **Gossip scene for each hop.** Hops queue and play one at a time with a 1.2 s gap. When there are more than 5, the
  older ones only get their Brain entry.
  1. The teller walks over (run if far, 4.5–7 s cap; skipped while an agent drives them), then both look at each
     other.
  2. The teller says the new wording (V2 speech bubble) while six 💬/❗ particles arc from head to head.
  3. The listener reacts (shake or laugh emote) with a 💭 thought bubble of what they now believe.
  4. A ✏️ "was: …" note appears over the teller when the story changed.
  5. A caption `🗣 Pip → Mara: "…"`.
  6. A Brain entry `rumour: "<text>" Pip → Mara (mutated: "<before>")` (source `rumours`, badge RULES).

  Hops more than 56 blocks from the player get the Brain entry only. A new rumour shows the origin's 💭 bubble and a
  Brain entry.
- **Rumour board.** A canvas texture on both faces of V2's notice board (`village.layout.board`), dimmed at night.
  - Up to four parchment notes (tilted, red pin, wrapped text).
  - Each note shows who knows it, heat triangles and "retold N×".
  - A newly formed or reworded rumour glows yellow for 4 s.

### Journal (`src/journal/*`)
A book: leather cover, parchment pages and coloured ribbon tabs. It pauses the game; J or Esc closes it.

- **Who you are.**
  - `player.model {top: 6}` while online, with traits, evidence, moments, profile text and stats.
  - "✨ Ask the Observer for a fresh profile" sends `refreshProfile: true`; the AI text replaces the instant one and
    gets a model badge.
  - Offline, a local estimate: 11 traits scored from PlayerStats (builder, miner, fighter, griefer, trader, social,
    survivor, reckless, archer, pillarer, tinkerer), each with evidence, plus a generated profile sentence, stats and
    moments.
  - Nicknames are shown here too.
- **What they think of you.**
  - Oakhollow reputation:
    - `GET /v1/m/world/standing` (public SDK-key route) gives reputation and per-NPC attitudes.
    - `lf.factions.state('oakhollow')` gives trust, posture, mood and prices.
    - Offline, the mean of the local attitudes.
  - Nicknames from `custom.reaction` (`effect: nickname`, deed_nicknames) and `hub.nickname`.
  - One card per named villager:
    - pixel face and role
    - attitude meter (server value when online, else local), labelled Hostile, Wary, Neutral, Friendly or Devoted
    - current makeover
    - the last 4 memories
  - Memories are built locally (no public `persona.memories` route) from: conversations (`npcReplied`), trades and
    haggles, griefing (owner plus witnesses within 18 blocks), hits, finished quests, rumours they heard, makeovers,
    `npc.bark` lines, and reaction lines.
  - When a villager's attitude reaches 0.6 they get the "friend" makeover.
- **Rumours.** Notes with known-by faces, heat, truthfulness, retold count, the original wording struck through, and a
  LIVEFORGE or LOCAL badge. Beside them, "How it spread" (who told whom) and "How the story drifted" for the hottest
  rumour.
- **Achievements.** Unlocked achievements (rarity border and glow, "personal" badge) and locked local ones with hints.
- **Quests.** Chains with step chips (done, active, offered, ???), the active quests' objectives with %, and a "🔗 Ask
  Mara" button.

### Achievements (`world/achievements/achievements.ts`, `list.ts`, slot `wb_achievements`)
- **Local list (instant rules).** 28 quirky achievements, checked 0.8 s after any stats change and every 10 s.
  Examples:
  - Feathered Friend: forged a chicken and you both made it through the night
  - Broken Telephone: a rumour about you changed three times
  - Talk of the Town
  - Storm Chaser
  - Sssssurprise!
  - Gravity Check
  - Villain Arc
  - A Proper Saga: finish a quest chain
  - Nicknamed
  - Fashion Icon
- **`achievement.check {recent}`.** Batched: after a notable counter changes, it waits 4 s, and runs at most once per
  25 s. It is online only, and both the instant answer and the AI upgrade can unlock achievements.
- **Toasts.** Every unlock gets exactly one toast: icon, rarity label, and a glow in the rarity colour. Unlocks come
  from the local list, from `achievement.check`, from server `achievement.unlocked` directives, and from V3's local
  Mender. All of them go through a new `quests.onAchievement` hook, so V3's plain toast is skipped. Each unlock also
  gets a Brain entry and an `achievementUnlocked` game event.

### Quest chains and dynamic objectives (`chains.ts`, `objectives.ts`, slots `wb_chains`, `wb_objectives`)
- **When a chain starts.** A completed quest from bram, mara, hilde, pip or captain_rowan becomes a step of that
  villager's chain: "Mara's Trust", "Bram's Apprentice", "Hilde's Forge-Friend", "Pip's Secrets" or "Rowan's Watch".
  Each chain has 3 quests, and the repair quest counts as step 1 of Mara's.
- **The next step:**
  1. 3.5 s after a step completes, the game asks
     `quest.offer {giver, context: {previousQuest, outcome: 'completed', chain: {id, title, step, of, earlier}, player}}`,
     with a local-template fallback.
  2. The local chain template is the instant answer, because the server's rules quest is blind to the chain. A cached
     AI quest replaces it.
  3. While online, the game waits up to 6 s for the AI follow-up, with the caption "💭 Mara is thinking about what
     comes next…".
  4. The quest is offered through V3's offer card, with a Brain plan entry and a `questChainAdvanced` event.
- **Tracker titles** read "Mara's Trust 2/3 · Mind the Garden" (via a new `quests.titleOf` hook).
- **Objective kinds** are registered through a new `quests.registerObjective` hook:

  | Kind | What counts |
  |---|---|
  | `gather` item N | items in the inventory |
  | `place` region N | the player's placements in the region since accepting |
  | `build` region N | anyone's placements in the region since accepting (player, Bram's `buildPlan`, a blueprint build) |
  | `deliver` `item@npc` N | talking to that npc with the items hands them over |
  | `survive` night N | dawns since accepting |

  - Regions: oakhollow, bram_plot, a building id, a village post (8-block radius), a zone, or `x,y,z[,r]`.
  - `kill`, `talk`, `explore`, `forge`, `fetch` and `repair` keep V3's rules.
- **Local templates:** 3 steps for each of the 5 givers, with dialogue and coin or item rewards.

### Makeovers (`world/makeovers/*`, slot `wb_looks`)
- **Triggers:**
  - `villagerAction buildPlan ok` → built_for_player
  - `villageDamaged` → griefed (owner)
  - posture festive → everyone (the previous looks come back when the festival ends)
  - posture hostile, or Rowan guarding at night → guarding
  - a quest completed for the giver → helped
  - local or server attitude ≥ 0.6 → friend

  Throttled to one per 20 s per villager, and the same reason doesn't repeat. The golem is skipped.
- **Instant rules: the looks table.** Accessories are local Blueprint v1 parts in villager units, built with
  `@liveforge/three` `buildBlueprint`:
  - Bram: hard hat with a lamp, plus a tool belt
  - Mara: red scarf, darker trim
  - Rowan: plumed helmet with a wobbling plume, red trim
  - festive: flower crown
  - helped and friend: a teal cape "in your colours"
- **AI upgrade:** `forge.npc_look {npc, prompt (reason + persona), asset: 'villager'}`.
  - A cached instant answer or the upgrade replaces the rules look.
  - `variant.recolour`: primary → robe, secondary or trim → trim; `materialSwaps` `*` or robe → robe.
  - The server's accessory blueprints are clamped, scaled with `length`, and fitted by tag: head (hats hidden),
    back / cape, neck, waist, shoulder, feet.
- **Also on each makeover:** a Brain entry (badge RULES, SONNET or CACHE), a caption, a cheer or glare emote, and an
  `npcMakeover` event.

### Hyper3D (`world/mesh/mesh.ts`)
- **When a mesh arrives:** `lf.client.onJob` (state done, url) or a `forge.ready` directive with `url`.
  1. GLTFLoader (from `three/examples/jsm`, no new dependency), with the SDK auth headers and `resolveUrl`.
  2. The model is normalised to 1.4 blocks and placed on the ground 2.5 blocks in front of you, spinning slowly.
  3. "🧊 3D model ready" toast, caption and Brain entry.
- **Without a provider:** nothing happens automatically.
- **"🧊 Upgrade to 3D":** re-forges the last forged thing (taken from the forge's ⚒ Brain entry) with
  `forge.item {prompt, mesh: true}`. It reports when no job starts; the Livecraft manifest has `meshJobs: false`.

## Shared-file edits (all small and additive)

| File | Edit |
|---|---|
| `src/village/npc/model.ts` | `NpcModel.attach(part, obj) → detach`, `recolor({robe, trim, hair, skin})` (repaints look-dependent part textures) and `setPartVisible(part, visible)`. The villager part list moved into `villagerParts()`; behaviour is unchanged. `setPartyHat` respects force-hidden hats. |
| `src/engine/box-model.ts` | `partTexture` is now exported (one word). |
| `src/liveforge/quests.ts` | `onAccept(fn)`, `registerObjective(type, evaluator)` (consulted before the built-in switch; returning null falls back), `titleOf` (tracker title), `onAchievement` (WB toast; skips the plain one), `activeList()`, `refresh()`. |
| `src/liveforge/hub.ts` | Optional `onRumourHeard?(d) → handled`. |
| `src/liveforge/directives.ts` | One line: `rumour.heard` asks `hub.onRumourHeard` first. |
| `src/liveforge/talk.ts` | `finish()` emits `npcReplied {npc, said, text, mood}` (declared in `world/events.ts`). |
| `src/liveforge/scenarios.ts` | One import and one delimited block, `...worldDemoButtons(game)`. |

## Kit gaps (game-side fallbacks written)

- **No public `persona.memories` route** (only `/v1/m/persona/stt`). Memories are built locally; attitudes come from
  `world.reactions` and `/v1/m/world/standing`.
- **Spread hops are not pushed with the teller.** `rumour.heard` has no `from`, so the teller is parsed from the
  directive's `why`. `lf.world.rumour_spread` is internal (admin event stream only).
- **No SDK call to mesh an existing forged item.** `forge.thing` has no `mesh` param, so "Upgrade to 3D" re-forges
  with `forge.item {mesh: true}`. The Livecraft manifest also has `clamps.forge.meshJobs: false`.
- **`quest.offer` instant rules ignore the `context`.** Chains use local templates as the instant answer and only take
  AI or cached quests from the server.
- **No typed SDK helpers** for world standing, the quests log or rumour routes. I used `fetch(client.resolveUrl(…),
  {headers: client.authHeaders()})`.

## Concerns

- **Never run.** Riskiest parts:
  - accessory offsets and scale on the box villagers (head pivot conventions, cape on +z)
  - the `recolor` repaint
  - the board planes' exact placement on V2's notice board and their z-fighting margin (0.012)
  - gossip walk timing versus the 9 s local spread interval
  - the 💬 particle screen projection
  - the Journal layout at small window sizes
- **Accessory lighting.** Accessories use `MeshStandardMaterial` from the builder, so they don't follow the box
  models' local-light brightness at night.
- **Possible double lines online.** A server rumour hop already makes a `rumour.heard` directive. V3's plain "Have you
  heard?" line is replaced by the gossip scene, but the Reaction Library may still voice similar lines.
- **The Demo rumour sends a real `economy.stole` signal** (Mara, a pie, seen by Pip). The server's reputation rules
  will lower Oakhollow reputation by 0.2.
- **Liveforge working-tree damage:** see the top of this report. Until it is restored, `predev` / `prebuild` will
  re-link to the emptied `../Liveforge` and fail. Set `LIVEFORGE_DIR` to a good copy, or restore Liveforge.
