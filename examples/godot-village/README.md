# Thornbury: the Reactive Godot 4 sample

A small village scene for the Reactive Godot addon. It contains:

- **Three LiveNPCs.** Bess the innkeeper, Aldric the bridge guard and Wick the thief come from `examples/godot-village.liveforge.yaml`. They bark when you walk up, answer typed or spoken questions with streamed replies, and speak through `DisplayServer.tts_speak` in their persona voice. Their structured actions (trade, steal, quest offers and so on) appear in the chat.
- **A LiveEquipSlot in your right hand.** Type a description, press **Forge**, and the forged item's blueprint (LiveBlueprint) and VFX (LiveVFX) are attached. When the AI upgrade arrives, it replaces the instant item.
- **A LiveBoss training dummy.** It runs its engine moves (`dummy_spin`, `dummy_lunge`, `dummy_slam`) every few seconds. Your dodges (Q and E) are reported as `combat.dodged`. Every fourth dodge, and again at half health, it asks the Director for a new phase plan. Invented moves and taunts show up in the chat, and the reasons (`why`) appear in the directive log.
- **On-screen chat** on the left, and the **live directive log** on the right.
- **A campfire** made from a hand-written VFX recipe.

You need Godot 4.3 or newer (4.2 should also work) and Node 22 or newer for the server.

## Run it

1. **Start a Reactive server** with this game's manifest. Run these from the repo root:

   ```bash
   npm install
   npm run build
   LIVEFORGE_MANIFESTS=examples/godot-village.liveforge.yaml npm run dev
   ```

   On Windows PowerShell, set the variable first with `$env:LIVEFORGE_MANIFESTS="examples/godot-village.liveforge.yaml"`, then run `npm run dev`.

   The server listens on `http://localhost:8787`. In dev mode it accepts the publishable key `pk_dev_godot-village`, which is already in `project.godot`. Without any provider keys, everything still runs on the instant rules answers.

2. **Put the addon into the project.** The sample expects it at `res://addons/liveforge`. Run one of these from the repo root:

   ```bash
   # macOS / Linux (symlink)
   mkdir -p examples/godot-village/addons && ln -s ../../../godot/addons/liveforge examples/godot-village/addons/liveforge
   ```

   ```bat
   :: Windows (junction, no admin rights needed)
   mkdir examples\godot-village\addons
   mklink /J examples\godot-village\addons\liveforge godot\addons\liveforge
   ```

   You can also copy `godot/addons/liveforge` to `examples/godot-village/addons/liveforge`. Git ignores the `addons/` folder in this sample.

3. **Open `examples/godot-village/project.godot` in Godot.** Let the first import finish. The plugin is already enabled. If Godot reports missing classes, reload the project once (Project > Reload Current Project) so it picks up the addon's global classes. Then press **F5**.

## Controls

| Key | What it does |
|---|---|
| Click | Capture the mouse. While it is captured, click to hit the dummy when you are close. |
| Esc | Free the mouse |
| W A S D, Space | Move and jump |
| Enter | Type in the prompt. Enter (or **Say**) talks to the nearest villager. |
| **Forge** button | Forge the item described in the prompt into your hand |
| Hold V | Push-to-talk to the nearest villager. The microphone audio goes to `/v1/stt`. |
| Q / E | Dodge left or right. The dummy adapts to your favourite side. |
| G | Find 150 gold. Get rich, and Wick may try to steal from you. |
| T | Ask the nearest villager for a greeting bark |
| Y | Accept the first offered quest |

## Editor dock

The **Reactive** dock appears on the right of the editor. With it you can:

- Test the connection. It shows the game, its personas and its bosses.
- Save the URL, key, world and player to Project Settings.
- Validate a manifest on the server. Type its absolute path and the admin key. In dev mode the admin key is `dev-admin`. The dock keeps the key in memory only.
- Fire any built-in test signal.
- Watch directives live.

## Notes

- **Voices.** TTS uses the operating system's voices, so `audio/general/text_to_speech` is enabled in `project.godot`. Push-to-talk needs `audio/driver/enable_input`, which is also enabled.
- **When the server is unreachable**, NPCs answer from `Liveforge.set_fallback(...)`. `main.gd` registers simple fallbacks, and the addon also uses its last-good-answer cache and any bake packs you load with `Liveforge.load_pack("res://packs/village.json")`.
- **Where the logic lives.** Everything the sample does goes through the public addon API, in `main.gd` (about 300 lines) and `player.gd`.
