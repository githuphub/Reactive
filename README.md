# Liveforge

> **Your game, but it notices.**

Liveforge is an MIT-licensed, self-hostable, engine-agnostic kit that makes games adapt to the player.
NPCs talk (out loud) and remember what you did. The world gossips about it. Bosses learn how you fight and
invent counters. Gear, looks, effects and quests are forged from a prompt or from what just happened. Everything
stays inside the rules the designer wrote.

<!-- GIF placeholders: drop recordings into docs/media/ with these names -->
| | |
|---|---|
| ![NPC conversation by voice](docs/media/voice-conversation.gif) | ![Boss adapts to dodging](docs/media/boss-adapts.gif) |
| *Talk to an NPC by voice. They remember last time.* | *Always dodge left? The boss invents a move for that.* |
| ![Forge from a prompt](docs/media/forge-prompt.gif) | ![Live dashboard](docs/media/dashboard.gif) |
| *"A rusty cleaver that drips green fire"* | *The dashboard shows why every decision was made.* |

## Features

- **Observer.** A player model built from what players do: 19 built-in traits (dodger, hoarder, pacifist,
  murderer, chatterbox …) with evidence, designer traits written in a one-line rule DSL, notable *moments*, and a
  short written profile of each player.
- **Persona & Voice.** NPCs with personality, knowledge, secrets and a voice style.
  - Memory per NPC and player.
  - Context barks ("nice armour" when you equip it).
  - Spoken conversations: mic → STT → streamed reply → TTS.
  - Structured actions (trade, give, flee, call guards, steal …), checked against your action schema.
- **World reactions.** Rumours that spread between NPCs and mutate as they travel. Faction reputation that moves
  prices and guards. NPC relationships. Reaction rules such as `rich & in_town → thieves target you`.
- **Director.** Pacing from a tension curve, adaptive aggression within your bounds, squad tactics, and bosses
  that counter your habits and gear. Every decision carries a short `why`.
- **Forge.**
  - Engine-neutral **Blueprint v1** models, **Variants** of your own assets, and **VFX recipes**.
  - Stats clamped to your item schema and budget.
  - Optional Hyper3D meshes.
  - Bake mode and a review queue to export **packs for offline or console** play.
- **Quests.** Reactive quests born from moments and rumours, personal achievements, and dynamic objectives.
- **Instant first, AI second.** Every ask gets an instant answer from rules or cache. An AI *upgrade* follows
  over WebSocket. With no API key at all, the game still works.
- **Guardrails.** A manifest schema with clear errors, clamps on every output, the lore bible and personas
  injected into prompts, moderation presets (E/T/M), and budgets per game and per player.
- **Live dashboard.** Signal stream, player models, NPC memories, rumour graph, factions, Director timeline,
  3D gallery, review/bake queue, cost meters, manifest validator and "simulate player" presets.

## 50 ways your world reacts (20 shipped)

One manifest line switches on ready-made reactions. Each one combines what the world knows about the player into
a line and an effect that fit *this* moment. That includes traits, gear and colours, blood and mud, time and
weather, rumours, nickname, debts and promises. NPCs never repeat themselves while a line is in their ledger.

```yaml
reactions:
  library: all      # or pick: [outfit_comments, deed_nicknames, promises_remembered, dodge_bait, ...]
```

| | | | |
|---|---|---|---|
| Outfit comments | Bloodied, wet, burnt, muddy | Deed nicknames that spread | Lies caught |
| Promises remembered | Town mood | Rich attention (pickpockets, beggars, tax) | Broke support (charity, loan sharks) |
| Collector interest | Haggle memory | Bosses remember your attempts | Dodge bait |
| Flawless → secret boss phase | Coward rumours + bounty hunters | Companion grief + revenge quest | Time and weather barks |
| Becoming a regular | Absence recap | Property damage (bills, repairs, guards) | Avoided areas |

The other 30 are planned. Every reaction carries a `why` (the recipe plus the facets it was chosen for), and the
dashboard's **Reactions** panel shows fingerprints and the novelty ledger per NPC. The JS SDK's `autoEmit()` and
the Godot addon send the clock, weather, appearance, sessions and visited places for you.
→ [docs/reactions.md](docs/reactions.md)

## Architecture

```
  Your game (Web / Three.js, Godot 4, Unity*, Unreal*)          Liveforge server (Node 22 or Docker, self-hosted)
 ┌─────────────────────────────────────┐   HTTPS    ┌────────────────────────────────────────────────────────────┐
 │ SDK  @liveforge/sdk · Godot addon   │──signals──▶│ Ingest ─▶ Event log (SQLite; per game / world / player)    │
 │  signal("combat.dodged", {...})     │──asks─────▶│              │                                             │
 │  ask("npc.reply", {...})            │            │              ▼                                             │
 │  on("boss.move_added", fn)          │◀──WS──────│ Projections: player model · NPC memories · rumours ·       │
 │                                     │ directives │   factions · Director · quests · forge gallery              │
 │ Drop-ins: LiveNPC · LiveBoss ·      │  upgrades  │              │                                             │
 │  LiveEquipSlot · LiveSpawner · VFX  │            │ Modules: Observer · Persona&Voice · World · Director ·     │
 │ TTS / mic · offline bake packs      │            │   Forge · Quests   (rules fast path ─▶ AI upgrade)         │
 └─────────────────────────────────────┘            │ Providers: Claude · Whisper API / whisper.cpp · Hyper3D    │
                                                    │ Guardrails: manifest clamps · moderation · budgets · cache │
   Dashboard (/dashboard) ◀── admin API + WS ───────│ Review / bake queue · snapshots                            │
                                                    └────────────────────────────────────────────────────────────┘
                                                      * Unity / Unreal: REST + WebSocket protocol, see docs/protocol.md
```

- **One implementation, every engine.** All the logic lives on the server, and the SDKs are thin.
- **Event log first.** Every signal is an event, and all state is a projection of the log. That means state
  can be replayed, rebuilt and snapshotted.
- **Your keys, your infra.** Model and provider keys live only in server env, never in clients.

## Quickstart

### 1. Run the server

```bash
git clone <this-repo-url> liveforge && cd liveforge
npm install
npm run build
npm run dev          # http://localhost:8787 · dashboard at http://localhost:8787/dashboard
```

- **Dev mode keys:** the SDK key is `pk_dev_<gameId>` and the admin key is `dev-admin`.
- **AI upgrades:** add `ANTHROPIC_API_KEY` to `.env`. Copy `.env.example` to get started.
- **Docker:** `docker compose up` works too. See [self-hosting](docs/self-hosting.md).

### 2a. Web / Three.js

```ts
import { createClient } from "@liveforge/sdk";

const lf = createClient({ url: "http://localhost:8787", gameKey: "pk_dev_counterforge", player: "p1", world: "w1" });

lf.signal("combat.dodged", { source: "forge_titan", direction: "left" });   // fire-and-forget, batched

const bark = lf.ask("npc.bark", { npc: "pell", trigger: "approach" });
showBubble((await bark.instant).result.text);                               // rules / cache: ~ms
bark.onUpgrade((r) => showBubble(r.result.text));                           // AI version, a moment later

lf.on("boss.move_added", (d) => titan.learn(d.args.move));                  // directives carry d.why
```

See the full [Web quickstart](docs/quickstart-web.md), which covers `LiveNPC`, `LiveBoss`, `LiveEquipSlot`,
voice and VFX.

### 2b. Godot 4

1. Copy `godot/addons/liveforge` into your project.
2. Enable the plugin.
3. Set `liveforge/server/game_key` in Project Settings.

```gdscript
Liveforge.send_signal("combat.dodged", {"source": "training_dummy", "direction": "left"})
var a := Liveforge.ask("npc.bark", {"npc": "bess", "trigger": "approach"})
var r: Dictionary = await a.answered
$Bubble.text = r.text                       # instant result (rules / cache); a.upgraded brings the AI line
Liveforge.directive.connect(func(kind, d): print(kind, " because ", d.why))
```

See the full [Godot quickstart](docs/quickstart-godot.md).

### 3. Describe your game: `liveforge.yaml`

```yaml
liveforge: 1
game: { id: my_game, name: My Game }
lore:
  bible: A harbour town where the fog remembers every lie told in it.
  tone: wry, salt-stained
personas:
  - id: bess
    name: Bess
    role: Innkeeper
    faction: town
    personality: Warm, nosy, never forgets a debt.
    voice: { pitch: 1.1, rate: 1.0, accent: en-GB }
    allowedActions: [emote, trade, call_guards]
factions:
  - { id: town, name: Townsfolk, attitude: 0.2 }
actions:
  emote: { args: { name: { type: string, required: true } } }
  trade: { args: { priceMultiplier: { type: number, min: 0.5, max: 2, required: true } } }
  call_guards: { by: [npc, world] }
traits:
  necromancer: count(magic.raise_dead, 10m) > 10
signals:
  magic.raise_dead: { description: The player raised a corpse., data: { corpse: string } }
budgets:
  game: { tokensPerMin: 200000, usdPerDay: 20 }
```

Validate it with `npx liveforge-validate liveforge.yaml`, or paste it into the dashboard. Every field is
described in the [manifest reference](docs/manifest.md).

## Docs

| | |
|---|---|
| [Web quickstart](docs/quickstart-web.md) | JS SDK + Three.js helpers |
| [Godot quickstart](docs/quickstart-godot.md) | Godot 4 addon, nodes and editor dock |
| [Manifest reference](docs/manifest.md) | Every field of `liveforge.yaml` |
| [Protocol](docs/protocol.md) | REST + WebSocket, for Unity, Unreal or your own engine |
| [Self-hosting](docs/self-hosting.md) | Node, Docker, env vars, providers, costs and budgets |
| [Dashboard](docs/dashboard.md) | What every panel shows |
| [Reaction Library](docs/reactions.md) | 20 one-line reactions, the combination engine, signals and payloads |
| [Recipes](docs/recipes/README.md) | NPC that comments on your armour · boss that punishes dodging · thieves target rich players · voice conversation · forge gear from a prompt · personal achievements · bake packs for consoles / offline |
| [Contracts](docs/CONTRACTS.md) | Internals: modules, projections, how everything plugs in |
| [Contributing](CONTRIBUTING.md) | Repo layout, conventions, how to add a module |

## Repo

| Path | |
|---|---|
| `packages/protocol` | `liveforge-protocol/1`: types, zod validators and JSON Schemas (`schema/v1`) for every SDK. Also Blueprint v1, VFX, Variant, the move grammar and the DSL. |
| `packages/manifest` | `liveforge.yaml` schema, validator (with line numbers) and the `liveforge-validate` CLI |
| `packages/server` | Node 22, Hono, SQLite and ws: event log, projections, two-stage asks, modules, providers, admin API |
| `packages/sdk-js` | `@liveforge/sdk`: signals, asks, directives, fallback cache and bake packs |
| `packages/sdk-three` | `@liveforge/three`: Blueprint/VFX/Variant builders, TTS + mic, LiveNPC/LiveBoss/LiveEquipSlot/LiveSpawner |
| `packages/dashboard` | The live dashboard (Vite + TS + Three.js), served at `/dashboard` |
| `godot/addons/liveforge` | Godot 4 addon |
| `examples/` | Example manifests (Counterforge, Godot village) |

## License

MIT © 2026 the Liveforge authors. Built for the Cambridge × Arcade AI Hackathon (Game Tech track), October 2026.
