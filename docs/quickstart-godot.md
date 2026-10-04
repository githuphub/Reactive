# Quickstart: Godot 4

The Godot addon gives you a `Liveforge` autoload plus drop-in nodes. Your Godot game gets NPCs that talk and
remember, bosses that adapt and generated gear and VFX. All of it is plain GDScript, with no GDExtension.

## 1. Start a server

```bash
npm install && npm run build
npm run dev          # http://localhost:8787 (dev keys: pk_dev_<gameId>, admin: dev-admin)
```

The example manifest `examples/godot-village.liveforge.yaml` sets up the village:

- **NPCs:** an innkeeper (Bess), a guard, a merchant and a thief.
- **Boss:** a training-dummy boss.
- **Loading it:** the server loads it by default through `.env.example`, or add it to `LIVEFORGE_MANIFESTS`.

## 2. Install the addon

1. Copy `godot/addons/liveforge` into your project's `addons/` folder.
2. **Project → Project Settings → Plugins:** enable **Reactive**. This registers the `Liveforge` autoload and
   the editor dock.
3. **Project Settings → General → Reactive:**

| Setting | Value |
|---|---|
| `liveforge/server/url` | `http://localhost:8787` |
| `liveforge/server/game_key` | `pk_dev_godot-village` (dev) or your publishable key |
| `liveforge/session/world` | e.g. `village` (save slot / server) |
| `liveforge/session/player` | your player id (or call `Liveforge.set_player()` at runtime) |
| `liveforge/realtime/enabled` | `true`: WebSocket directives and live upgrades |
| `liveforge/signals/flush_interval_ms`, `flush_size` | batching (250 ms / 50) |
| `liveforge/cache/persist` | keep last-good answers on disk for offline play |

You can also configure everything from code:
`Liveforge.configure({"url": ..., "game_key": ..., "world": ..., "player": ...})`.

> Never put the admin key in a game build. The game key is publishable; model keys live only on your server.

## 3. Signals

```gdscript
Liveforge.send_signal("combat.dodged", {"source": "training_dummy", "attack": "swing", "direction": "left"})
Liveforge.send_signal("economy.gold", {"amount": 1250, "delta": 300})
Liveforge.send_signal("gear.equipped", {"item": "iron_helm", "slot": "head", "tags": ["iron"], "value": 120})
Liveforge.send_signal("movement.entered_zone", {"zone": "market"})
```

Signals are batched and sent in the background. The field names follow the
[built-in vocabulary](protocol.md#built-in-signals).

## 4. Asks: instant, then upgrade

```gdscript
var a := Liveforge.ask("npc.reply", {"npc": "bess", "text": "Any news?", "stream": true})
a.answered.connect(func(r): $Bubble.text = r.text)       # instant: rules / cache / bake pack
a.partial.connect(func(t): $Bubble.text += " " + t)      # streamed sentences of the AI reply
a.upgraded.connect(func(r): $Bubble.text = r.text)       # the AI upgrade
var best: Dictionary = await a.done                       # upgrade if one came, else the instant answer
for act in best.get("actions", []):
    if act.action == "trade":
        open_shop(act.args.priceMultiplier)
```

`a.source` (`rules | cache | ai | bake`) and `a.why` say where the answer came from.

## 5. Directives

```gdscript
func _ready() -> void:
    Liveforge.directive.connect(_on_directive)

func _on_directive(kind: String, d: Dictionary) -> void:
    match kind:
        "npc.bark":
            npcs[d.args.npc].say(d.args.text)
        "npc.action":
            if d.args.action.action == "steal":
                $Thief.pickpocket(d.args.action.args.get("gold", 10))
        "spawn.wave":
            $Spawner.run_wave(d.args.units)
        "boss.move_added":
            $TrainingDummy.learn(d.args.move)
    print(kind, " because ", d.why)
```

## 6. Nodes

| Node | What it does |
|---|---|
| `LiveNPC` (Node3D) | Persona id. Barks on approach, holds conversations by text or push-to-talk (`AudioEffectRecord` → WAV → `/v1/stt`), speaks with `DisplayServer.tts_speak` using the persona's voice style, and emits `said` and `action`. |
| `LiveBoss` | Boss id. Maps engine move ids to your methods, receives invented grammar moves, and reports `dodged`, `hit` and `hurt` for you. |
| `LiveDirector` | Asks `director.pacing` on a timer and applies breathers and spawn waves through your spawners. |
| `LiveEquipSlot` (on a `BoneAttachment3D`) | Equips `ForgedItem`s or blueprints, forges from a prompt, and sends `gear.*` signals. |
| `LiveSpawner` | Runs `spawn.wave` directives with tactics. |
| `LiveQuestBoard` | Lists `quest.offer` directives, and accepts or completes them (`quest.*` signals). |
| `LiveVFX` (Node3D) | Builds a VFX recipe as `GPUParticles3D` emitters, auras and `OmniLight3D`s. Set `recipe` or call `build(recipe)`. |
| `LiveBlueprint` (Node3D) | Builds a Blueprint v1 from `MeshInstance3D` primitives (box, cylinder, sphere, prism, torus, capsule, wedge, crescent …). |

```gdscript
# VFX on a sword tip
var fx := LiveVFX.new()
fx.recipe = item.vfx
$Sword/Tip.add_child(fx)
```

The exact node properties are documented in the addon's own `README.md` and in the inline `##` docs that the
Godot help panel shows.

## 7. Editor dock

The **Reactive** dock (bottom panel) can:

- connect to the server and show its status;
- validate your `liveforge.yaml` (errors come back with line numbers);
- fire test signals;
- watch directives arrive live.

It is the Godot-side twin of the web dashboard.

## 8. Offline and console builds

- **Cache:** `liveforge/cache/persist` keeps the last good answer per ask on disk.
- **Bake packs:** `Liveforge.load_pack(JSON.parse_string(FileAccess.get_file_as_string("res://packs/village.json")))`
  loads approved content exported from the dashboard. See the [bake packs recipe](recipes/bake-packs-offline.md).
- **Your own fallbacks:** `Liveforge.set_fallback("npc.bark", func(params): return {"npc": params.npc, "text": "Evening."})`.
- **No network at all:** `Liveforge.configure({"offline": true})` answers only from cache, packs and fallbacks.

## 9. Unity / Unreal

There is no native SDK yet. The REST + WebSocket protocol is small; see [protocol.md](protocol.md) for C# and C++
sketches.
