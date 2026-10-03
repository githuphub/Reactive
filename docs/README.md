# Liveforge docs

> Your game, but it notices.

Liveforge watches how people play and answers in kind. Shopkeepers remember you short-changed them, and the town
gossips about the dragon you fled from. The boss learns that you always dodge left. The forge makes the sword you
described, inside the rules you set. It runs on your own server, works with any engine, and is MIT licensed.

## Start here

- [Web / Three.js quickstart](quickstart-web.md)
- [Godot 4 quickstart](quickstart-godot.md)
- [Self-hosting](self-hosting.md): Node, Docker, env vars, providers, costs and budgets

## Reference

- [Manifest (`liveforge.yaml`)](manifest.md): every field, plus the rule DSL
- [Protocol](protocol.md): REST + WebSocket, built-in signals, ask and directive kinds, admin API, Unity/Unreal
  examples
- [Dashboard](dashboard.md): every panel, and a demo-video walkthrough
- [Village mind (factions)](factions.md): posture, prices, guard posts and adaptive night raids per village
- [Record / replay cassettes](record-replay.md): deterministic, cost-free demos with no API key
- [Reaction Library](reactions.md): 20 one-line reactions (`reactions.library`), the combination engine, signals
  and `custom.reaction` payloads

## Recipes

- [An NPC that comments on your armour](recipes/npc-comments-on-armour.md)
- [A boss that punishes dodging](recipes/boss-punishes-dodging.md)
- [Thieves target rich players](recipes/thieves-target-rich.md)
- [Voice conversation](recipes/voice-conversation.md)
- [Forge gear from a prompt](recipes/forge-gear-from-prompt.md)
- [Personal achievements](recipes/personal-achievements.md)
- [Bake packs for consoles / offline](recipes/bake-packs-offline.md)

## Internals

- [Contracts (how everything plugs in)](CONTRACTS.md)
- [Design spec](specs/2026-10-03-liveforge-design.md)
- [Contributing](../CONTRIBUTING.md)
