# Liveforge — Design Spec

**Status:** approved with the user on 2026-10-03 (brainstorm sections 1–5). Hackathon: Cambridge × Arcade AI Hackathon, Game Tech track; submission Sun 2026-10-04 13:30 BST.
**License:** MIT (open source).
**One-liner:** Liveforge is a self-hostable, engine-agnostic kit that makes games adapt to the player: NPCs that talk (by voice) and remember, a world that gossips and reacts, bosses and encounters that adapt to how you play, and gear, looks, effects and quests generated from prompts or from what's happening — always inside the designer's rules.
**Demo:** Counterforge (Three.js, + The Veil Act I slim) via the JS SDK, and a small Godot 4 sample scene via the Godot addon.
**Testing rule (user):** no tests until the user says so — typecheck + build only.

## 1. Architecture
```
 Game (Godot / Web / later Unity, Unreal)        Liveforge server (self-hosted: Node or Docker; Workers-compatible core)
 ┌───────────────────────────────┐   HTTPS   ┌──────────────────────────────────────────────────────────┐
 │ SDK                           │──signals─▶│ Ingest → Event log (per game / world / player)            │
 │  • signal("combat.dodged")    │           │            ↓                                              │
 │  • ask("npc.reply", …)        │──asks────▶│ Projections: PlayerModel (traits, moments, profile),      │
 │  • on("directive", …)         │◀──WS──────│   NPC memories, Rumours, Factions, Relationships,         │
 │  • Blueprint / VFX builders   │           │   Director state, Quest state                             │
 │  • TTS / mic → STT            │           │            ↓                                              │
 │  • local fallback cache/packs │           │ Modules (plugins): Observer · Persona&Voice · World ·     │
 └───────────────────────────────┘           │   Director · Forge · Quests — rules fast-path → AI upgrade│
                                             │ Providers: LLM (Claude default; adapter interface) ·      │
                                             │   STT (OpenAI Whisper API, whisper.cpp) · 3D (Hyper3D) ·  │
                                             │   TTS (optional; SDK engine TTS by default)               │
                                             │ Guardrails: manifest schemas, clamps, safety, budgets      │
                                             │ Store (SQLite) · Cache · Bake/review queue · Dashboard    │
                                             └──────────────────────────────────────────────────────────┘
```
- **Event log first:** every signal is an event; all state is a projection (replayable, debuggable, rebuildable; snapshots export/import from the log).
- **Two-stage answers:** every ask returns an instant rules/cache answer `{id, stage:"instant", …}`; an AI result follows as `{id, stage:"upgrade", …}` over WebSocket (or long-poll fallback). SDKs swap it in.
- **Tenancy:** game (manifest + SDK keys) → worlds (save slots / servers) → players. Model/provider keys live only in server env, never in clients.
- **Why server + thin SDKs:** one implementation of all logic for every engine; studios self-host on their infra with their own provider keys; offline/console via bake packs.

## 2. Developer API (same shape in every SDK)
1. **Signals** (fire-and-forget, batched): `signal(type, data)`. Built-in vocabulary: `combat.*` (hit, hurt, dodged, blocked, parried, killed, died, ability_used), `economy.*` (gold, bought, sold, stole), `social.*` (said, talked_to, gave, lied, threatened), `movement.*` (entered_zone, explored, fled), `gear.*` (equipped, unequipped), `quest.*` (accepted, completed, failed), `world.*` (destroyed, helped, time). Custom signals allowed (declared in the manifest).
2. **Asks** (promise/Godot signal; instant + upgrade): `ask(kind, params)` — kinds: `npc.bark`, `npc.reply`, `director.boss_phase`, `director.encounter`, `director.pacing`, `forge.item|armour_set|look|vfx|creature|npc_look|prop|loot`, `quest.offer`, `achievement.check`, `world.reactions`.
3. **Directives** (pushed over WS): `{kind, target, args, why}` — kinds e.g. `npc.action`, `npc.bark`, `rumour.heard`, `spawn.wave`, `pacing.breather`, `boss.move_added`, `quest.offer`, `achievement.unlocked`, `objective.dynamic`, `forge.ready`, `moment`. Only actions declared in the manifest action schema are ever emitted.
4. **Declarative hooks:** drop-in nodes/components (`LiveNPC`, `LiveBoss`, `LiveDirector`, `LiveEquipSlot`, `LiveSpawner`, `LiveQuestBoard`, `LiveVFX`, `LiveBlueprint`) that wire 1–3 automatically.
5. **Manifest** (`liveforge.yaml`, validated with clear errors): game id/name, lore bible + tone, personas, factions, relationships, trait rules, custom signals, action schema, item/quest/move/progression schemas, balance clamps, safety rating, budgets, model tiering, module toggles.

## 3. Modules (rules fast-path → AI upgrade; manifest-bounded; Haiku unless noted)
### 3.1 Observer (core)
- Built-in traits (sliding windows + decay, score 0–1 + evidence): dodger, turtle, glass_cannon, ranged_camper, berserker, hoarder, big_spender, rich, broke, pacifist, murderer, thief, explorer, speedrunner, chatterbox, liar, feared, famous, beloved.
- Designer traits: rule DSL over signals, e.g. `necromancer: count(magic.raise_dead, 10m) > 10`.
- Moments: near_death_escape, flawless_phase, comeback, betrayal, absurd_purchase, first_kill_of_type, broken_promise (+ designer moments) → broadcast as `moment` directives.
- Profile: LLM narrative (2–3 sentences, Sonnet tier) every N events; context for all modules.
### 3.2 Persona & Voice
- Persona card: name, role, faction, personality, voice style (pitch/rate/accent hint), knowledge scope, secrets, likes/dislikes, allowed actions, relationships.
- Memory per NPC×player: summarised interactions with salience; decay/sharpen.
- Barks: context one-liners (gear, traits, rumours, time, moments); per-NPC bark pools pre-generated and refilled in the background (instant).
- Conversation: text, mic audio → server STT (OpenAI Whisper API or local whisper.cpp), or browser STT; streamed reply (sentence chunks) → SDK TTS (Godot `DisplayServer.tts_speak`, browser speechSynthesis; optional server TTS adapter). Replies carry structured actions validated against the persona's allowed actions + manifest action schema: emote, trade (price ×), give, take, quest_offer, reveal, hostile, flee, call_guards, steal, follow, help, join.
- Safety: input moderation; personas refuse out-of-world topics in character.
### 3.3 World reactions
- Rumours: from moments/memories `{content, truthfulness, heat, origin}`; tick spreads by proximity groups, faction links and time, mutating slightly; NPCs repeat them.
- Factions + reputation drive default attitudes, prices, guard behaviour.
- NPC↔NPC relationships (rival, family, ally) colour gossip and help.
- Reaction rules: `when <player-model condition> then <directive>` (e.g. `rich & in_town → thieves target player`, `feared → guards keep distance, children flee`, `famous → challengers`), optionally LLM-flavoured (named thief NPC with bark and plan).
### 3.4 Director
- Bosses: move grammar `{name, shape, element, pattern, count, telegraph, speed, size, status, damage_budget}` + engine `move_id` mapping (engine-native moves with parameters or grammar primitives); phase plans; counters to gear tags and habits; persona-voiced taunts.
- Monsters & squads: tactic assignment (flank, kite, ambush, shield-wall, focus-healer); counter elite modifiers.
- Pacing: tension curve from intensity signals → spawn / breather / loot directives within manifest budget.
- Difficulty: aggression 0–1 within designer bounds; modes hidden-adaptive / explicit assist / off.
- Every decision carries a short `why`.
### 3.5 Forge
- Requests from prompt or context (`forge.loot` themed on the fight).
- Outputs (manifest-clamped): **Blueprint v1** (engine-neutral parts: shape, size, offset, rotation, material {color, metalness, roughness, emissive}, animation, attachment points, palette, LOD hint — evolved from Counterforge's ItemBlueprint incl. improvised + style paths); **Variant** (developer asset id + material swaps, recolour, decals, scale, part toggles); **VFX recipe** (emitters: shape, rate, colour ramp, size curve, lifetime, velocity; trails; auras; lights); **stats** per item schema + budget + creativity rules.
- Hyper3D upgrade: optional async job; blueprint stand-in, mesh swap when ready.
- Bake mode + review queue: pre-generate catalogues, approve in the dashboard, export a pack file SDKs load offline.
### 3.6 Quests
- Reactive quests from moments, rumours and world state, in the game's quest schema (objective types, targets, rewards, givers); giver dialogue via Persona.
- Personal achievements: title, description, icon (VFX/blueprint glyph), condition in the trait-rule DSL.
- Unlocks & progression suggestions within the progression schema.
- Dynamic objectives inside encounters (condition + reward).

## 4. SDKs, server, dashboard, guardrails
### 4.1 SDKs
- **JS/TS:** `@liveforge/sdk` (client: signals, asks + upgrades, WS directives, batching/retry, fallback cache, snapshots) + `@liveforge/three` (Blueprint & VFX builders, TTS + mic helpers, LiveNPC/LiveBoss/LiveEquipSlot/LiveSpawner helpers).
- **Godot 4 addon** (`addons/liveforge`, GDScript): `Liveforge` autoload (HTTPRequest pool, WebSocketPeer, batching, Godot signals, fallback packs); nodes LiveNPC, LiveBoss, LiveDirector, LiveEquipSlot (BoneAttachment3D), LiveSpawner, LiveQuestBoard, LiveVFX (GPUParticles3D), LiveBlueprint (MeshInstance3D primitives); TTS via `DisplayServer.tts_speak`; push-to-talk via `AudioEffectRecord` → WAV → `/v1/stt`; editor dock (connect, validate manifest, fire test signals, watch directives).
- **Unity / Unreal:** protocol docs + REST/WS examples only (v1).
### 4.2 Server & protocol
TypeScript, Node 22, Hono (core Workers-compatible), SQLite (better-sqlite3), ws. Endpoints: `POST /v1/signals`, `POST /v1/ask/:kind`, `GET /v1/ws`, `POST /v1/stt`, `GET /v1/forge/jobs/:id`, `GET|POST /v1/snapshot`, `/admin/*`. Auth: per-game publishable SDK key (scoped, rate-limited) + admin key. Versioned `liveforge-protocol v1` JSON Schema shared by all SDKs.
### 4.3 Dashboard
Live signal stream; player model (trait bars + evidence, profile, moments); NPC memories; rumour spread graph; factions + relationships; Director timeline with `why`, tension curve, aggression; gallery (3D blueprints, VFX, quests); review/bake queue; cost/latency/cache meters per module; manifest validator; "simulate player" presets.
### 4.4 Guardrails
Manifest schemas + clamps on every output; lore bible + persona injection; input/output moderation with rating presets (E/T/M); refused topics.
### 4.5 Budgets & latency
Per-game/per-player budgets (tokens/min, $/day); dedupe + semantic cache; model tiering (Haiku fast; Sonnet profiles/quests/lore); prefetch (greetings on approach, next-phase counters, bark pools); streaming replies; instant rules/cache answers first.

## 5. Demo & lanes
### 5.1 Demo video
Counterforge + Veil Academy (Act I slim) on the JS SDK: courtyard NPCs greet you by rumour, voice conversation, wealth → pickpocket, voice-forged armour/set commented on by NPCs, boss adapts to dodging with an invented move + taunt (dashboard shows why), personal achievement pop, reactive quest, context loot (+ Hyper3D if keyed), dashboard alongside. Godot sample village: LiveNPC conversation, LiveEquipSlot gear + VFX, LiveBoss dummy adapting.
### 5.2 Lanes
- **K0 Core** (first): repo scaffold (npm workspaces), protocol v1 types + JSON Schema, manifest schema + loader, server skeleton (Hono, SQLite event log, projection framework, WS, auth, provider adapters: Claude, Whisper API, whisper.cpp, Hyper3D), budgets + cache, two-stage answers, module plugin interface, example manifest.
- **K1** Observer + Persona & Voice · **K2** World + Quests · **K3** Director + Forge (port Counterforge director/blueprint/forge code) · **K4** SDKs (JS + Three; Godot addon + dock + sample scene) · **K5** Dashboard + docs · **D1** Counterforge integration (swap built-in Director/forge for Liveforge; Veil Act I slim: courtyard hub, 3–4 Veil-cast LiveNPC personas, Vale via Liveforge, Hollow Professor via LiveBoss, wealth/gear reactions, quest/achievement UI).
- Order: K0 → K1–K5 parallel → D1 once the JS SDK exists; Godot sample last in K4.
