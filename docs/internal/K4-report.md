# K4 report: SDKs (JS + Three, Godot 4 addon + dock + sample)

Branch `K4` in the worktree `F:/Development/Liveforge-K4`. It merges `main` at `23b556b` (K0 + K1–K3), and `npm run typecheck` and `npm run build` pass. No tests were written or run (user rule), and no Godot binary was used: the GDScript is hand-checked only.

Every edit stays inside the K4 folders: `packages/sdk-js`, `packages/sdk-three`, `godot/addons/liveforge` and `examples/godot-village/`. No shared files were edited. On the merge, the K0 skeletons in those folders were replaced by the K4 versions, as the K0 report asks. Compatibility aliases keep code written against the stub signatures working.

## @liveforge/sdk (`packages/sdk-js`)

### Creating a client

`createClient({ url, gameKey, player, world? })`. `key` is accepted as an alias of `gameKey`. Main options:

| Option | Meaning | Default |
|---|---|---|
| `flushIntervalMs` / `flushMs` | Signal flush interval | 250 |
| `flushSize` / `flushMax` | Signals per batch before an early flush | 50 |
| `realtime` / `websocket` | Open the WebSocket | true |
| `offline` | Answer asks locally only | off |
| `requestTimeoutMs` | Instant-answer timeout | 8 s |
| `upgradeTimeoutMs` | How long to wait for an upgrade | 45 s |

Other options: `cache` (options, or `false`), a custom `fetch` or `WebSocket`, `debug` and `onError`. Bad config throws a `LiveforgeError` with code `invalid_input` and a message that says how to fix it.

### Signals

`signal(type, data)`:
- Built-in types are typed from `BUILTIN_SIGNALS`, so required fields are enforced. Custom types take a free bag.
- Signal types are checked locally before sending.
- Signals are sent in batches of up to 500. Network errors and 5xx responses are re-queued with backoff, and the queue is capped at 2000.
- Per-index rejections from the server are reported through `onError`.
- On `pagehide` and when the page is hidden, queued signals are flushed with a keepalive fetch, falling back to `sendBeacon` with `?key=` (the server accepts `?key=`).
- `flush()` resolves with the last `SignalBatchResult`.

### Asks

`ask(kind, params, opts)` returns an `AskHandle`:

| Member | What it gives you |
|---|---|
| `instant` | The rules, cache or bake answer |
| `upgrade` | The AI answer, or `null`. Never rejects. |
| `final` | The best answer so far |
| `onPartial` | Streamed chunks. Late subscribers get earlier chunks replayed. Alias: `onChunk(text, seq)`. |
| `onUpgrade` | Fires after `instant`, per the contract |
| `latest`, `settled`, `cancel()` | Current state |

Ask ids are generated on the client, so a WS chunk or upgrade that arrives before the HTTP instant answer is buffered and still matched.

When the WS is down, an ask long-polls `GET /v1/upgrades/:id?wait=25` (200 = upgrade, 204 = keep waiting, 404 = no upgrade). Polling also starts if the socket drops while asks are waiting.

When the server is unreachable (retryable errors or `budget_exceeded`), the instant answer comes from, in order:
1. The last-good-answer cache. It lives in memory plus `localStorage`, holds 300 entries using least-recently-used eviction, keeps entries for 7 days, and an AI answer is never overwritten by a rules answer.
2. A bake pack (`loadPack(obj | url)`).
3. `setFallback(kind, fn)`.
4. `opts.fallback`.

Client errors such as `bad_request` or `moderated` are never masked by a fallback. `askFinal()` is a shortcut that waits for the best result.

### Directives

`on(kind | "npc.*" | "*", fn, { target })` and `once` are typed for the known directive kinds. Directives are deduplicated by id. `dispatch()` injects a directive locally.

The WebSocket:
- auto-subscribes through the query string and also sends `subscribe`;
- pings every 25 s and reconnects when a socket is half-open (nothing received for 75 s);
- reconnects with exponential backoff and jitter.

Status goes through `idle`, `connecting`, `open`, `reconnecting` and `unavailable`, and is reported by `onStatus`. `onJob` reports Hyper3D job updates.

### Other calls

`connect()` (fetches the config, so it doubles as a startup check), `config()`, `persona(id)`, `stt(blob | bytes)`, `forgeJob(id)`, `exportSnapshot()`, `importSnapshot()`, `setPlayer(player, world?)`, `resolveUrl()`, `authHeaders()` and `close()`. The package re-exports every protocol type.

## @liveforge/three (`packages/sdk-three`)

### `buildBlueprint(bp, opts)`

Returns a `BlueprintObject`, which is a `THREE.Group`. It is a port of Counterforge's builder, generalised to Blueprint v1:
- all 11 shapes, following `SHAPE_NOTES`;
- named and inline materials with role-based defaults, opacity and `flatShading`;
- mirrored parts;
- attachment points as `attach:<name>` objects, with parts parented to them; a `tip` point always exists;
- the LOD hint: segment counts, dropping `dropRolesFar` roles at distance, and a box impostor (`updateLod(distance | camera)`);
- Counterforge quick particles, `bp.vfx` recipes, and an optional live swing trail.

Animation is either `animate(t)`, or `update(dt)` plus `autoAnimate`. Other options: `length` normalisation, `dim` (the Counterforge "cracked" look) and `dispose()`.

The protocol's `clampBlueprint` drops `vfx[]` and the LOD `dropRolesFar` and `impostorDistance` fields. The builder adds them back after clamping (each recipe clamped with `clampVfx`).

### `buildVfx(recipe, opts)`

Returns a `VfxObject`:
- **Emitters.** Each is one `THREE.Points` draw call with a small shader: procedural sprites (soft, ring, shard, spark star, flame, glyph, snow), colour ramp, size curve and spin. Particles can live in world or local space. All six emitter shapes are supported, along with bursts, gravity and drag.
- **Trails** are camera-facing ribbons.
- **Auras** are sphere, ring, column and ground decal.
- **Point lights** can flicker.
- **Playback.** Effects self-tick from the render loop by default. A finite `duration` fades out, and `onFinished` and `disposeOnFinish` handle the end. Controls: `play`, `stop`, `burst`, `quality`, `seed`.

### `applyVariant(object, variant)`

Applies material swaps (by material or mesh name, or `*`), recolours (an exact colour within a tolerance, or a palette role from the blueprint palette or the most-used asset colours), part toggles (node name, part id or role), scale (clamped to 0.5–2), decals, bolted-on blueprints and VFX. It returns a handle whose `revert()` undoes everything.

### Speech

- `speak(text, opts | voiceStyle)` uses `speechSynthesis`. It maps the voice id, then the accent to a language tag, applies pitch and rate, and nudges them for style words. `stopSpeaking`, `pickVoice` and `accentToLang` are exported too.
- `Mic` / `createMic(client)` is push-to-talk. It uses browser `SpeechRecognition` where available, else `MediaRecorder` → `client.stt()`.

### Helper classes

- **`LiveNPC`:**
  - proximity barks with a cooldown;
  - `talk(text | Blob)`: streamed partials are spoken as they arrive; a pending instant answer is shown but not spoken, and is spoken only if no upgrade comes;
  - history, `social.talked_to`;
  - `say`, `action`, `rumour`, `mood` and `end` events;
  - directive routing for `npc:<id>`.
- **`LiveBoss`:** maps engine move ids to your handlers and grammar-only moves to `onGrammarMove`; `requestPhase()`; handles `boss.move_added` and `boss.adapt`; weighted `performNext()`; combat signal helpers.
- **`LiveEquipSlot`:**
  - `equip(item | blueprint)` aligns the grip and applies the item's `vfx` and `variant`;
  - `forge(prompt)` equips the instant item, then swaps in the upgrade;
  - an optional `loadMesh` swaps in the Hyper3D GLB on `forge.ready`;
  - sends `gear.*` signals.
- **`LiveSpawner`:** handles `spawn.wave` addressing (spawner id, zone, or `catchAll`), defers waves during a `pacing.breather`, scatters units and caps the units per wave.

K0 skeleton names are still available: `BuiltBlueprint` / `BuiltVfx` (with `.object`, `.update(dt)` and `.done`), a `{three}` option that is accepted and ignored, and `createMic`.

## Godot 4 addon (`godot/addons/liveforge`)

### Plugin

`plugin.cfg` and `plugin.gd` register:
- the `Liveforge` autoload, in `_enable_plugin`;
- the Project Settings under `liveforge/*` (URL, game key, world, player, flush, realtime, pool size, timeouts, cache, debug);
- the dock.

The nodes are global classes (`class_name`), so they appear in the Create Node dialog without `add_custom_type`. Using `add_custom_type` as well would list them twice.

### The `Liveforge` autoload (`liveforge.gd`)

**Requests and signals**
- An `HTTPRequest` pool with a queue. Long-polls and uploads use dedicated requests.
- `send_signal(type, data)`, batched. `signal` is a GDScript keyword, so the name differs; `emit_signal_event` is an alias.

**Asks**
- `ask(kind, params, opts)` returns a `LiveforgeAsk`, which has:
  - the signals `answered`, `upgraded`, `partial`, `done` and `failed`;
  - an `instant` property, plus `result`, `stage`, `source` and `why`.
- Emissions are deferred, so `await Liveforge.ask(...).answered` works.

**Directives and realtime**
- WebSocketPeer with backoff reconnect, ping and stale detection.
- The `directive(kind, data)` signal.
- Long-poll upgrades while the socket is down.

**Offline**
- `LiveforgeCache` (memory plus `user://liveforge_cache.json`), bake packs (`load_pack`) and `set_fallback`.

**Other calls**
- `stt(wav)`, `forge_job`, `export_snapshot` / `import_snapshot`, `fetch_config` / `persona`, `configure()`, `set_player()`, `dispatch_local()`.
- `LiveforgeUtil.wav_bytes()` turns an `AudioEffectRecord` recording into a WAV.
- The K0 skeleton signals `directive_received`, `ask_answered` and `ask_upgraded` are emitted too.

### Nodes

- **`LiveNPC`:**
  - an Area3D proximity bark, filtered by the player group;
  - `talk()`;
  - push-to-talk (`start_listening` / `stop_listening`) on a muted `LiveforgeMic` bus with `AudioEffectRecord`, sent as WAV to `/v1/stt`;
  - `DisplayServer.tts_speak` with the persona voice (accent → language, pitch, rate, style words);
  - signals `said`, `partial_said`, `action`, `barked`, `heard`, `rumour_heard` and `conversation_ended`.
- **`LiveBoss`:**
  - signals: `move_added`, `move_triggered(user_move, params, spec)` (via `move_map`), `taunt`, `adapted` and `phase_planned`;
  - `request_phase`, `perform` and `perform_next`;
  - optional `call_methods_on`;
  - `report_*` signal helpers.
- **`LiveDirector`:** `request_pacing` and `request_encounter`. Signals: `pacing`, `spawn_wave`, `breather`, `difficulty_changed`, `objective`, `moment`, `loot_dropped` and `tactics`. Optional auto pacing.
- **`LiveEquipSlot`** (a `BoneAttachment3D`): `equip`, `unequip` and `forge` (instant item, then the upgrade swap). It aligns the grip and sends gear signals.
- **`LiveSpawner`:** `unit_scenes` maps unit types to `PackedScene`s; `spawn_requested` fires for unmapped types; breathers defer waves.
- **`LiveQuestBoard`:** keeps offers, active and completed quests, achievements and dynamic objectives. `request_offer`, `accept` / `complete` / `fail` (which send quest signals) and `check_achievements`.
- **`LiveVFX`:**
  - each emitter is a `GPUParticles3D` with a `ParticleProcessMaterial`: emission shape, spread or cone angle, velocity, gravity, damping, lifetime randomness, a gradient colour ramp and a curve scale;
  - billboard additive or alpha quads with procedural sprites;
  - trails are world-space particle ribbons;
  - aura meshes and `OmniLight3D` lights with pulse and flicker;
  - finite durations, plus a `quick_recipe()` helper for Counterforge quick particles.
- **`LiveBlueprint`:**
  - shapes: box, cylinder, cone (`CylinderMesh` with top radius 0), sphere, torus (rotated into XY and squashed), prism (3-sided), capsule, octahedron and icosahedron (low-segment spheres), and generated wedge and crescent meshes;
  - `StandardMaterial3D` with emission and a faint self-glow;
  - mirrored parts, Euler XYZ rotation order to match three.js;
  - `Marker3D` attachment points, all six part animations, length normalisation, quick particles and VFX recipes.

### Editor dock (`editor/dock.gd`)

- URL, key, world and player, with "Save to project".
- "Test connection" calls `GET /v1/config` and shows the game, personas and kind counts.
- "Validate on server" posts the manifest file to `POST /admin/manifest/validate` with the admin key. The key is typed in the dock and held in memory only.
- "Fire signal" offers every built-in type with JSON data.
- "Watch directives" opens its own WebSocket and logs a live tail of directives, upgrades and errors.

## Godot sample (`examples/godot-village`)

`project.godot` enables the plugin and autoload and turns on TTS and audio input. It sets the server to `http://localhost:8787`, the key to `pk_dev_godot-village`, and the world to `village`.

The hand-written `main.tscn` contains:
- the ground and a path, a sky and a sun;
- a capsule player (`player.gd`: WASD, mouse look, jump, dodge impulse) with a `RightHand` `LiveEquipSlot`;
- Bess, Aldric and Wick as `LiveNPC`s with name labels;
- the training dummy with a `LiveBoss` whose `move_map` covers `dummy_spin`, `dummy_lunge` and `dummy_slam`;
- `LiveDirector` and `LiveQuestBoard` nodes;
- the UI: chat, directive log, status, prompt with Say and Forge buttons, and a help text.

`main.gd` wires it together:
- talking to the nearest NPC, typed or by voice;
- the Forge button;
- hitting the dummy, which asks for phase 2 at half health;
- Q and E dodges, which ask for a new phase plan every fourth dodge with `dodgeLeft` habits;
- the dummy attacks every 3.5 s, and a hit lands only if you did not dodge in the last 0.8 s;
- G adds gold, so the `rich` reaction makes Wick steal;
- Y accepts quests;
- a hand-written campfire VFX recipe;
- local fallbacks for barks and replies.

The README gives the run steps: start the server with `LIVEFORGE_MANIFESTS=examples/godot-village.liveforge.yaml`, link or copy the addon to `res://addons/liveforge`, then open the project. The sample's `.gitignore` excludes `addons/`.

## How to try it

**JS:**

```ts
const lf = createClient({ url: "http://localhost:8787", gameKey: "pk_dev_counterforge", player: "p1", world: "default" });
await lf.connect();
lf.signal("combat.dodged", { source: "boss", direction: "left" });
const h = lf.ask("npc.reply", { npc: "<persona>", text: "hello", stream: true });
h.onPartial((p) => console.log(p.text));
console.log((await h.final).result.text);
```

**Three:**

```ts
const sword = buildBlueprint(item.blueprint, { length: 1.1 });
hand.add(sword);
// each frame:
sword.update(dt);
```

**Godot:** follow `examples/godot-village/README.md`.

## Gaps and notes

- **Godot is unverified.** No Godot binary was run (user rule), so the GDScript is hand-checked for Godot 4.2+ (it uses `static var`), not parsed. The most likely snags are editor warnings, such as unsafe property access on the autoload when it is typed as `Node`, and on first import the global class cache. The README says to reload once.
- **No directive fallback without WebSocket.** The protocol has no directive polling endpoint. Upgrades long-poll, but while the socket is down directives are missed until it reconnects. The SDK reconnects forever with backoff.
- **Unload flushing.** A keepalive fetch that carries the custom key header needs a CORS preflight. Browsers that refuse preflighted keepalive requests fall back to `sendBeacon` with `?key=` only when the fetch throws synchronously.
- **Bake pack matching.** The keys K3 uses in bake packs are not specified. Pack lookup tries, in order: the exact cache key; `npc` / `boss` / `giver` ids (key `id`, `id:*` or a tag); prompt, trigger, zone and similar values; then a deterministic pick.
- **No flat shading in Godot.** `LiveBlueprint` has no per-material flat shading (`StandardMaterial3D` has no flat-shading flag), and octahedron and icosahedron are low-segment spheres.
- **`BlueprintObject` cannot be cloned.** It needs constructor arguments, so `.clone()` is not supported; rebuild from the blueprint instead.
