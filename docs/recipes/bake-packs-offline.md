# Recipe: bake packs for consoles and offline play

**Goal:** ship generated content without a live server, for a console certification build, a flight-mode
handheld, or a game jam submission. You pre-generate a catalogue, review it by hand, export a pack, and the SDK
answers asks from it.

## 1. Generate a catalogue (bake mode)

In the dashboard, go to **Review & bake → Bake mode**. Pick a kind (item, armour set, creature, prop, VFX, loot),
a count and optional prompts, then click **Generate**. The API equivalent:

```bash
curl -s localhost:8787/admin/m/forge/bake -H "x-liveforge-key: $ADMIN" -H "content-type: application/json" \
  -d '{"kind": "item", "count": 24, "ai": true}'
curl -s localhost:8787/admin/m/forge/bake -H "x-liveforge-key: $ADMIN" -H "content-type: application/json" \
  -d '{"kind": "item", "prompts": ["a frost harpoon", "a lantern that eats shadows", "a teapot mace"]}'
```

How the entries are produced:

- **Without prompts,** bake mode cycles your item families × elements, or creature and prop nouns.
- **With `ai: true`,** an AI pass upgrades each entry in the background, within your budgets.
- **Clamps:** every entry is clamped to the manifest, as usual.

## 2. Review

The **Review & bake** queue shows each entry with a 3D thumbnail, its flavour text and the JSON. Approve or
reject entries one at a time, or use **Approve all pending**. Reviews are events, so they are kept in the log and
show up in the gallery too.

API: `GET /admin/m/forge/review?status=pending` and `POST /admin/m/forge/review/:id {"status": "approved"}`.

## 3. Export

Click **Export bake pack**, or call `GET /admin/m/forge/pack` (`?kinds=item,vfx` to filter). You get a
`BakePack`:

```json
{ "protocol": "liveforge-protocol/1", "game": "counterforge", "createdAt": 1791043200000,
  "entries": { "forge.item": [ { "key": "a frost harpoon", "result": { "item": { "name": "Rimebite Harpoon", "...": "..." } }, "tags": ["ice"] } ] },
  "assets": ["/v1/assets/abc123.glb"] }
```

- **`key`:** the prompt or catalogue key. The SDK matches asks by key first, then picks at random.
- **`assets`:** any Hyper3D meshes the pack references. Download them and ship them with the build.

## 4. Load it in the game

```ts
const lf = createClient({ url, gameKey, player, offline: true });   // never calls the server
await lf.loadPack(packJson);
const a = lf.ask("forge.item", { prompt: "a frost harpoon" });      // answered from the pack (source "bake")
```

```gdscript
Liveforge.configure({"offline": true})
Liveforge.load_pack(JSON.parse_string(FileAccess.get_file_as_string("res://packs/counterforge.json")))
```

Online games benefit too. With a pack loaded, the instant answer for a cold cache comes from approved content
instead of procedural rules.

## Tips

- **Bake other things:** besides gear, you can bake NPC bark pools and quest templates, for example a handful of
  `npc.bark` lines per persona and trigger. The fallback cache keeps the last good answer for everything else.
- **Version packs with the build:** they are plain JSON (`schema/v1/BakePack.json`) and diff nicely.
