# Quickstart: Web / Three.js

This guide makes a browser game adapt to the player. It takes about 10 minutes and works with any JS game. The
Three.js helpers are optional.

## 1. Start a server

```bash
npm install && npm run build
npm run dev                       # http://localhost:8787
```

- **Dev mode** (the default outside `NODE_ENV=production`) needs no keys. It accepts `pk_dev_<gameId>` as the SDK
  key and `dev-admin` as the admin key.
- **Which games load:** the server loads the manifests listed in `LIVEFORGE_MANIFESTS`. With the shipped
  `.env.example`, that is `examples/counterforge.liveforge.yaml` and `examples/godot-village.liveforge.yaml`.
- **Without `ANTHROPIC_API_KEY`:** every ask is answered by rules. Add the key to get AI upgrades.

Open <http://localhost:8787/dashboard>. Sign in with `dev-admin`, or click **Explore with demo data**.

## 2. Install the SDK

```bash
npm install @liveforge/sdk            # client: signals, asks, directives
npm install @liveforge/three three    # optional: Three.js builders + LiveNPC / LiveBoss / LiveEquipSlot
```

## 3. Connect

```ts
import { createClient } from "@liveforge/sdk";

export const lf = createClient({
  url: "http://localhost:8787",
  gameKey: "pk_dev_counterforge",   // publishable key: safe in a client. NEVER ship the admin key.
  player: "p1",                     // your player id
  world: "w1",                      // save slot / server / shard
});
lf.onStatus((s) => console.log("liveforge:", s));
```

- **Two kinds of key:** the SDK key is per game and publishable. Model and provider keys stay on your server.
- **Changing player or world:** call `lf.setPlayer(id, world)` when the player or world changes.

## 4. Send signals

Signals are fire-and-forget facts. The SDK batches them every 250 ms or every 50 signals. Use the built-in
vocabulary, which the Observer, rumours, quests and the Director all understand:

```ts
lf.signal("combat.dodged", { source: "forge_titan", attack: "slam", direction: "left" });
lf.signal("combat.hurt", { source: "slag_imp", damage: 12, hp: 0.4 });
lf.signal("economy.gold", { amount: 1250, delta: 300 });
lf.signal("gear.equipped", { item: "gilded_circlet", slot: "head", name: "Gilded Circlet", tags: ["gold"], value: 900 });
lf.signal("movement.entered_zone", { zone: "courtyard" });
lf.signal("social.said", { text: "Tell me about the Titan.", to: "vale" });
```

- **Custom signals:** use a dotted name such as `magic.raise_dead`, declared under `signals:` in the manifest.
- **Built-in vocabulary:** the full list, with fields, is in [protocol.md](protocol.md#built-in-signals).

## 5. Ask: an instant answer now, the AI upgrade later

```ts
const bark = lf.ask("npc.bark", { npc: "pell", trigger: "approach" });

const instant = await bark.instant;          // rules / cache / bake pack - milliseconds
bubble.show(instant.result.text);

bark.onUpgrade((r) => bubble.show(r.result.text));   // AI line (if a key + budget allow), same id
// or: const best = await bark.final;                // upgrade if one arrives, else the instant answer
```

- **Every kind has a rules fast path,** so an ask never blocks on an LLM.
- **`source` tells you where the answer came from:** `"rules" | "cache" | "ai" | "bake"`. `why` explains it.
- **Kinds:** `npc.bark`, `npc.reply`, `director.boss_phase`, `director.boss_move`, `director.encounter`,
  `director.pacing`, `forge.item`, `forge.armour_set`, `forge.look`, `forge.vfx`, `forge.creature`,
  `forge.npc_look`, `forge.prop`, `forge.loot`, `quest.offer`, `achievement.check`, `world.reactions`.

## 6. React to directives

The server pushes directives over WebSocket whenever a module decides something. Each directive carries a `why`.

```ts
lf.on("npc.action", (d) => {
  if (d.args.action.action === "steal") pickpocket(d.args.npc, d.args.action.args.gold);
});
lf.on("rumour.heard", (d) => npcs[d.args.npc].remember(d.args.content));
lf.on("spawn.wave", (d) => spawner.run(d.args.units));
lf.on("boss.move_added", (d) => titan.learn(d.args.move, d.args.engineMove));
lf.on("achievement.unlocked", (d) => toast(d.args.achievement.title));
lf.on("quest.offer", (d) => questBoard.add(d.args.quest));
```

- **Only declared actions:** directives only ever use actions declared in your manifest's action schema.
- **Filter by receiver:** pass `{ target: "npc:pell" }` as the third argument to `on()`.

## 7. Drop-in helpers (`@liveforge/three`)

```ts
import { LiveNPC, LiveBoss, LiveEquipSlot, Mic, speak, buildBlueprint, buildVfx } from "@liveforge/three";

// A talking NPC: proximity barks, conversation with streamed replies, speechSynthesis voice, actions as events.
const pell = new LiveNPC({ client: lf, id: "pell", object: pellMesh, player: playerMesh });
pell.on("say", (line) => bubble(pellMesh, line.text));
pell.on("action", (a) => a.action === "trade" && openShop(a.args.priceMultiplier));
const reply = await pell.talk("Any news from the lodge?");       // text or a recorded Blob

// A boss that learns: engine moves you implement + invented grammar moves.
const titan = new LiveBoss({
  client: lf, id: "forge_titan",
  moves: { slam: (p) => doSlam(p.radius), sweep: (p) => doSweep(p.arc) },
  onGrammarMove: (m) => castGrammarMove(m),                          // shape / pattern / count / telegraph ...
});
titan.dodged("left", "slam");                                        // shorthand for combat.* signals

// Gear from a prompt, hung on a bone, with VFX.
const hand = new LiveEquipSlot({ client: lf, socket: rightHandBone, length: 1.1 });
hand.forge("a rusty cleaver that drips green fire");
// each frame: hand.animate(t); pell.update(dt);
```

The builders follow the Blueprint v1 conventions: metres, +Y up, grip at the origin. You can render any forge
result yourself with `buildBlueprint(item.blueprint)` and `buildVfx(recipe)`.

## 8. Voice

```ts
const mic = new Mic(lf, { mode: "auto", language: "en-GB" });   // browser STT when available, else server STT
await mic.start();
const text = await mic.stop();
await pell.talk(text);                                            // reply streams sentence by sentence
speak("Back again?", { pitch: 1.05, rate: 0.95, accent: "en-GB" });
```

Server STT uses the OpenAI Whisper API or a local whisper.cpp. See [self-hosting](self-hosting.md#providers).

## 9. Offline and failure

- **Remembered answers:** the SDK keeps the last good answer per kind and params, so asks still answer when the
  server is unreachable.
- **Your own fallbacks:** `lf.setFallback("npc.bark", (p) => ({ npc: p.npc, text: "…", actions: [] }))` supplies
  a local answer.
- **Bake packs:** `await lf.loadPack(await (await fetch("/packs/counterforge.json")).json())` loads approved
  content exported from the dashboard. See the [bake packs recipe](recipes/bake-packs-offline.md).
- **Offline only:** `createClient({ ..., offline: true })` never calls the server.

## Next

- [Recipes](recipes/README.md): armour comments, boss that punishes dodging, thieves, voice, forge, achievements.
- [Manifest reference](manifest.md).
- [Dashboard](dashboard.md): the **Simulate** panel fires play-style presets so you can watch your game react
  without playing it.
