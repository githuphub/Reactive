# Liveforge for Godot 4

Copy `addons/liveforge` into your project's `addons/` folder, then enable the plugin in Project Settings > Plugins. The plugin registers three things:

- **The `Liveforge` autoload.** Configure it in Project Settings > Liveforge: server URL, publishable game key, world and player. Its main functions:
  - `send_signal(type, data)`
  - `ask(kind, params)` returns a `LiveforgeAsk` with the signals `answered`, `upgraded`, `partial` and `done`.
  - The `directive(kind, data)` signal.
  - `set_fallback`, `load_pack`, `stt`, `export_snapshot` and `import_snapshot`.
- **Global node classes:** `LiveNPC`, `LiveBoss`, `LiveDirector`, `LiveEquipSlot`, `LiveSpawner`, `LiveQuestBoard`, `LiveVFX` and `LiveBlueprint`.
- **The Liveforge editor dock.** Use it to test the connection, validate a manifest on the server, fire test signals and watch directives.

It needs Godot 4.2 or newer. For a complete scene, see `examples/godot-village` in the repo. Protocol schemas are in `packages/protocol/schema/v1/`.
