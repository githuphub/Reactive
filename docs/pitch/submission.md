# Reactive: hackathon submission text

**Track:** Game Tech · Cambridge × Arcade AI Hackathon
**Repo:** https://github.com/githuphub/Reactive
**Play it:** https://<your-service>.onrender.com (the first load after idle takes about 30 s on the free tier)

---

## Tagline

**Reactive: games that react to you.** An open, engine-agnostic reaction engine that gives any game memory, voice, adaptive worlds and forge-anything.

## Inspiration

Games are written once and played a million times. You hear the same NPC line on every visit. Bosses run fixed patterns you look up on a wiki. Worlds forget you the moment you leave. For studios, every one of those reactions is hand-written, and players burn through that content faster than teams can make it.

I wanted games where what you do actually matters, and where the world answers back differently every time. That needs randomness that is modified by *you*: reactive gameplay.

## What it does

Reactive is a server plus thin engine SDKs that you plug into a game. The game reports what the player does, and Reactive changes the world back.

- **NPCs that remember and talk.**
  - Characters keep memories of you and your deeds.
  - You can talk to them by text or by voice (push-to-talk), and their replies stream in sentence by sentence.
- **A world that gossips.** Rumours about what you did spread from NPC to NPC and mutate as they travel. Reputation, prices and attitudes shift with them.
- **Agentic NPCs.** Ask a villager to "build me a cosy house with a tower". An AI agent plans it and calls the game's own tools (walk, gather, place) to build it block by block.
- **An adaptive Director.**
  - Raids, encounters and bosses read your habits, such as pillaring, bow spam or always dodging left.
  - They counter those habits and explain why.
- **Forge anything.**
  - Describe a thing and the AI decides what it is (creature, food, tool, wearable, decoration, vehicle…).
  - It designs a 3D voxel model and stats for it.
  - Buildings come out as blueprints you can place.
- **Generated quests and achievements** that grow out of what just happened.
- **A Brain View and a live dashboard** that show every decision, its reason, and which model (or rule) made it.

**The demo is Livecraft,** a Minecraft-style voxel world built for this hackathon on top of Reactive. It has biomes, caves, survival and crafting, mobs, and a village (Oakhollow) whose villagers run on Reactive.

## How it works

1. **Signals in.** The engine SDK sends events such as `block.broken`, `combat.dodged` or `social.said`.
2. **The Reactive server** appends them to an event log, folds them into projections (player model, memories, rumours, factions), and runs modules:
   - Observer, Persona and Voice;
   - World reactions with a Reaction Library of combinable recipes;
   - Director, Forge, Quests;
   - Agents (tool use), Builder (a Voxel DSL), Factions.
3. **Directives out.** Decisions flow back over WebSocket, each with a short "why": an NPC action, a spawn wave, an agent tool call, a quest offer.
4. **It never blocks a frame.**
   - Every request answers instantly from deterministic rules within milliseconds.
   - The AI upgrade streams in afterwards.
   - The game works offline, and falls back gracefully when a budget runs out.
5. **Built-in guardrails.** A single manifest per game declares:
   - the actions the AI may take, and clamps on stats and spawns;
   - budgets per player and per game;
   - moderation and the safety rating.

   The model can only do what the designer allows.
6. **Right model per job.**
   - Claude Haiku 4.5 handles instant reactions, barks and classification.
   - Claude Sonnet 5.5 handles agents, building plans and forging.
   - Answers are cached.
   - **Record and replay** cassettes make AI sessions deterministic for QA and demos.
7. **Voice.** Push-to-talk speech-to-text runs either in the browser or through server-side Whisper, and replies stream back sentence by sentence. Per-character voices are optional.

## Engines

| Status | Engine |
|---|---|
| **Live** | Web / Three.js (Livecraft, Counterforge) |
| **Addon** | Godot 4 (autoload + nodes, with a sample village) |
| **Next** | Unity, Unreal |
| **Any engine today** | The open HTTP + WebSocket JSON protocol with published JSON Schemas |

## How we built it

- **Languages and stack:** TypeScript end to end, npm workspaces, with Hono + better-sqlite3 + WebSockets on the server.
- **Game:** Vite + three.js.
- **AI and voice:** the Anthropic API for Claude (structured outputs, tool use, streaming), plus OpenAI Whisper for speech-to-text.
- **Godot:** GDScript for the addon.
- **Livecraft's engine:**
  - the voxel engine is written from scratch, with procedurally painted textures (no external assets);
  - Web Workers handle terrain generation and meshing, with ambient occlusion and flood-fill lighting.

## Challenges

- **AI must never stall the game loop.** The two-stage "instant rules, then AI upgrade" design came out of that.
- **Letting an LLM act in a world safely.** Every action is allow-listed and clamped by the manifest, and every decision carries its reason.
- **Making the AI build reliably.** A compact Voxel DSL (boxes, roofs, cylinders, windows…) turned out far more reliable than asking for raw block lists.

## What we're proud of

- **Real agentic NPCs:** villagers that plan and build through the game's own tools.
- **A world that remembers you** and gossips about it.
- **Fully engine-agnostic:** the same kit drives a voxel sandbox, an action boss game and a Godot village.

## What's next

- Unity and Unreal SDKs.
- More of the 50 Reaction Library recipes (20 ship today).
- Hyper3D mesh upgrades for forged items.
- A hosted Reactive Cloud for studios.

## Built with

TypeScript · three.js · Vite · Node.js · Hono · SQLite · WebSockets · Claude Haiku 4.5 · Claude Sonnet 5.5 · OpenAI Whisper · Godot 4 · Render

**License:** MIT, self-hostable.
