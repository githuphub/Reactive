# Liveforge for Godot 4

Copy `addons/liveforge` into your project and enable the plugin (Project Settings → Plugins).
The `Liveforge` autoload talks to a Liveforge server (`npm run dev` in the repo root).
Status: skeleton. K4 implements the autoload, nodes (LiveNPC, LiveBoss, LiveDirector, LiveEquipSlot, LiveSpawner,
LiveQuestBoard, LiveVFX, LiveBlueprint) and the editor dock. Protocol: `packages/protocol/schema/v1/`.
