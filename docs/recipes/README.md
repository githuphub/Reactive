# Recipes

Each recipe is short and complete. It gives a manifest snippet, the game code (Web and/or Godot), and what to look
for in the dashboard. You can try every one of them without playing: the dashboard's **Simulate** panel fires
matching signal sequences.

| Recipe | Uses |
|---|---|
| [An NPC that comments on your armour](npc-comments-on-armour.md) | `gear.equipped` · `npc.bark` · bark triggers |
| [A boss that punishes dodging](boss-punishes-dodging.md) | Observer `dodger` · `director.boss_move` · `boss.move_added` |
| [Thieves target rich players](thieves-target-rich.md) | `rich` trait · reaction rules · `npc.action steal` |
| [Voice conversation](voice-conversation.md) | Mic → STT → `npc.reply` streaming → TTS · memory |
| [Forge gear from a prompt](forge-gear-from-prompt.md) | `forge.item` · Blueprint v1 · VFX · Hyper3D |
| [Personal achievements](personal-achievements.md) | DSL conditions · `achievement.unlocked` |
| [Bake packs for consoles / offline](bake-packs-offline.md) | Review queue · `GET /admin/bake` · `loadPack` |
