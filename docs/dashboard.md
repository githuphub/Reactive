# Dashboard

The dashboard shows what Reactive is learning and deciding, live. It runs on the server at
`http://<server>/dashboard`, or standalone with `npm run dev -w @liveforge/dashboard`, which proxies to
`LIVEFORGE_URL` (default `http://localhost:8787`).

## Signing in

There are two ways in:

- **Admin key:** enter the server URL (leave it empty for the same origin) and the admin key
  (`LIVEFORGE_ADMIN_KEY`; dev servers accept `dev-admin`). Tick *Remember on this device* to keep the key in
  `localStorage`. Otherwise it lasts for the browser session only.
- **Explore with demo data:** runs a complete in-browser simulation of the Counterforge example manifest. No
  server is needed and nothing leaves the browser. Open `/dashboard/?demo` to go straight there.

The top bar holds:

- the **world** and **player** pickers (every panel follows them);
- the live signals-per-minute rate;
- the connection status: *Live* (WebSocket), *Polling* (fallback while reconnecting), *Offline* or *Demo*;
- the **LLM mode badge** (LIVE / RECORD / REPLAY, with the cassette count). Pick another mode from it to switch at
  runtime; without an API key only REPLAY is offered. See [record-replay.md](record-replay.md).

## Panels

| Panel | Shows | Data |
|---|---|---|
| **Overview** | KPI tiles (signals/min, players, directives, AI upgrades and cache share, instant p95, spend vs budget), the tension curve, the aggression gauge, the **why feed** of recent directives, a live signal ticker, and each player's top traits. | stats, `director.state`, `observer.player_model`, WS |
| **Brain** | One live feed of the kit's reasoning: agent goals, thoughts, tool calls and results, builder plans, village-mind decisions, raid plans (threat model → plan → why) and Director decisions. Each row has a source, the actor, a model badge (sonnet / haiku / rules / cache / replay) and latency; filter by source or text, pause, click for the data. | WS `brain` topic, `GET /v1/brain` |
| **Agents** | NPC agent runs: goal, plan, state and every step (thought, tool + input, result) with model badge and latency. | `agents.runs` (K6), Brain entries |
| **Builds** | `builder.plan` results: an isometric preview of the expanded blocks coloured by block (a slider replays the build order), the Voxel DSL listing and the materials bill. | `lf.builder.planned` events (K6) |
| **Signal stream** | Every event and directive as it arrives. Filter by player, namespace or text; pause and resume; click a row for its JSON. `lf.*` internal events are behind a toggle. | WS `events` topic, `/admin/events` |
| **Simulate** | Preset play styles (rich hoarder, dodger, pacifist chatterbox, murderer, light fingers, explorer) streamed as a fake player in small batches, with a live **trait watch** and the reactions they cause. Also a one-off signal composer. | `POST /admin/simulate` |
| **Player model** | Trait bars with evidence (designer traits marked), the written profile, running stats, the moments timeline, quests, achievements, faction standing and NPC attitudes. | `observer.player_model`, `quests.log`, `persona.memories`, `world.factions` |
| **NPC memories** | Per NPC: what it remembers about each player. Shows attitude (−1..1), the rolling summary, and entries tagged by kind with their salience. | `persona.memories` |
| **Rumours** | A force-directed spread graph: NPCs as nodes ringed by faction, "who told whom" arrows coloured per rumour, and recent hops animated. The list shows heat, truthfulness, mutations and the wording's drift. | `world.rumours` |
| **Factions** | **Village minds** on top: posture, price multiplier, mood, trust per player, guard posts, damage and threats, the last council decision with its *why*, posture history, and raid plans (waves, counters per habit, captain taunt, *why*). Then a player × faction reputation heatmap (diverging −1..1), the NPC relationship graph (width = strength, dashed = hostile) and faction cards from the manifest. | `factions.mind`, `world.factions`, manifest |
| **Director** | The tension curve with decision markers, aggression inside the manifest clamp band, bosses with phases, attunement and invented move cards, and the decision timeline (filter by kind; each entry has a source badge and its `why`). An AI move that replaces a rules move is shown as *upgrade · replaces …*, and the replaced entry is struck through. | `director.state` |
| **Reactions** | The Reaction Library: enabled recipes with params, fired reactions (recipe, effect, speaker, line, fingerprint facets, `why`), and per NPC the live context fingerprint, context sentence and novelty ledger (the lines it will not repeat). Library directives in the why feed and Director timeline show a recipe badge and their facets. | `/admin/m/world/reactions-lib` |
| **Gallery** | Forge output rendered live in Three.js (orbit, auto-rotate): Blueprint v1 models with animated parts and VFX, stats, tags, source and prompt. Also tabs for VFX recipes on their own, reactive quests and achievements. | `forge.gallery`, `quests.log` |
| **Review & bake** | **Bake mode** (generate a catalogue of a kind, optionally with an AI pass) and the review queue with 3D thumbnails. Approve or reject items one at a time or all at once, then **Export bake pack** (BakePack JSON). | `/admin/m/forge/{bake,review,pack}` |
| **Cost & latency** | Budget gauges (tokens/min, $ today, cache hit rate), server counters, and per-module cards: asks, instant vs upgrade latency (p50/p95), cache share, tokens and $. Plus a detail table. | `/admin/stats` |
| **Manifest validator** | A YAML editor with line numbers. Paste, upload or drop a file, or load the server's current manifest. It validates as you type with the same validator the server uses; click an error to jump to its line. Valid manifests get a summary. | `@liveforge/manifest` (in-browser), `/admin/manifest/source` |

## For a demo video

1. Start the server, open the dashboard and sign in.
2. Put **Overview** next to the game window.
3. Run **Simulate → Dodger**, then open **Director** to show the boss inventing a counter, with its *why*.
4. Run **Rich hoarder** and watch the pickpocket reaction appear in the why feed, then the rumour spread.
5. Open **Gallery** while forging gear in the game.

For Livecraft (split-screen next to the game):

1. Start the server in replay mode (`LIVEFORGE_PROVIDER_MODE=replay`): no key, no cost, the badge says REPLAY.
2. **Brain** next to the game: ask Bram for a house and watch goal → thought → `build` → plan → tool calls.
3. **Builds**: drag the slider to replay the build order of Bram's plan.
4. **Factions**: break Mara's house and watch Oakhollow turn wary (prices up, the golem posted at `home:mara`), then
   ask for a raid plan at dusk and read the counters and the captain's taunt.

Demo data (`?demo`) includes a scripted Livecraft loop for the Brain, Agents, Builds and village-mind panels.

## Development

```bash
npm run dev                                # server on :8787
npm run dev -w @liveforge/dashboard        # dashboard on :5173 (proxies /admin and /v1 incl. WebSocket)
npm run build -w @liveforge/dashboard      # typecheck + static build to packages/dashboard/dist
```

| Path | |
|---|---|
| `src/api/admin.ts` | The typed admin client and `LiveSource`. Every route is listed in `ADMIN_ROUTES`. |
| `src/api/demo.ts` | The in-browser `DemoSource`. |
| `src/api/demo-livecraft.ts` | Scripted Livecraft demo data for Brain, Agents, Builds and the village mind. |
| `src/api/brain.ts` | Brain colours and view models: agent runs, builds (tolerant readers), cassette status. |
| `src/panels/*` | One file per panel. |
| `src/viz/*` | Charts, the force graph, the Three.js Blueprint/VFX renderer, and the isometric voxel preview (`iso.ts`, using the protocol's `expandVoxelPlan`). |

The code is vanilla TypeScript with Three.js and no framework.
