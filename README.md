# Liveforge

**Liveforge is a self-hostable, engine-agnostic kit that makes games adapt to the player.** It gives you:

- NPCs that talk (by voice) and remember.
- A world that gossips and reacts.
- Bosses and encounters that adapt to how you play.
- Gear, looks, effects and quests generated from prompts or from what's happening, always inside the designer's rules.

MIT licensed. Status: hackathon build (October 2026).

## How it works

- **Game:** the game sends **signals** (`combat.dodged`, `economy.bought` …) and makes **asks** (`npc.reply`, `director.boss_move`, `forge.item` …).
- **Asks:** every ask returns an instant answer from rules or cache. An AI **upgrade** follows over WebSocket.
- **Directives:** the server pushes directives (`npc.action`, `spawn.wave`, `boss.move_added`, `quest.offer` …).
- **Manifest:** everything is bounded by your `liveforge.yaml`. It holds lore, personas, factions, the action schema, item, quest and move schemas, clamps, safety, budgets and model tiering.

## Repo

| Path | |
|---|---|
| `packages/protocol` | `liveforge-protocol v1`: types, zod validators, JSON Schemas (`schema/v1`), Blueprint v1, VFX, move grammar, DSL |
| `packages/manifest` | `liveforge.yaml` schema, validator, `liveforge-validate` CLI |
| `packages/server` | Node 22 + Hono + SQLite + ws: event log, projections, two-stage asks, modules, providers |
| `packages/sdk-js`, `packages/sdk-three` | `@liveforge/sdk`, `@liveforge/three` |
| `packages/dashboard` | Dashboard |
| `godot/addons/liveforge` | Godot 4 addon |
| `examples/` | Example manifests (Counterforge, Godot village) |
| `docs/CONTRACTS.md` | How modules, SDKs and the dashboard plug in |

## Quickstart

```bash
npm install
npm run build
cp .env.example .env          # optional: add ANTHROPIC_API_KEY for AI upgrades
npm run dev                   # http://localhost:8787  (dev keys: pk_dev_<gameId>, admin: dev-admin)
```

```ts
import { createClient } from "@liveforge/sdk";
const lf = createClient({ url: "http://localhost:8787", key: "pk_dev_counterforge", world: "w1", player: "p1" });
await lf.connect();
lf.signal("combat.dodged", { direction: "left" });
const a = lf.ask("npc.bark", { npc: "pell", trigger: "approach" });
console.log((await a.instant).result.text, (await a.upgrade)?.result.text);
lf.on("npc.action", (d) => console.log(d.args.action, d.why));
```

Validate a manifest: `npx liveforge-validate examples/counterforge.liveforge.yaml`.

## License

MIT © 2026 the Liveforge authors
