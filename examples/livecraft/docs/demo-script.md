# Livecraft × Reactive: 3-minute demo video script

**Goal:** show judges, in three minutes, that Reactive drives real agentic NPCs, a village mind that adapts, memory
with consequences, and forge-anything, and that the reasoning is visible (Brain View in game, the dashboard on the
right half of the screen).

**Setup:** Livecraft at `http://localhost:5180/?demo&seed=demo&lfname=Alex` on the left half of the screen. Press the
Demo panel's **📊 Dashboard** button to open the Reactive dashboard on the right half. The Brain View is open
bottom-left, captions are on, and so are voices. The badge (top-right) shows **Reactive online · REPLAY**.

## Before the shoot: record once, then replay

Cassettes make every take identical and free. Record each scenario once with your key, then replay with no key.

```bash
# in ../Liveforge, with ANTHROPIC_API_KEY in the server env (never in the game)
PORT=8790 LIVEFORGE_MANIFESTS=examples/livecraft.liveforge.yaml LIVEFORGE_PROVIDER_MODE=record npm run dev
```

1. Open `http://localhost:5180/?demo&seed=demo&lfname=Alex`.
2. Before each scenario, click **🧽 Reset memory**. This gives a fresh Reactive world, so habits and grudges don't
   leak between takes.
3. Play scenarios 1 to 4 below once each, in that order, by clicking the Demo buttons. Wait for each AI upgrade: the
   Brain View badges turn **SONNET** / **HAIKU**.
4. Stop the server. Commit `cassettes/` in the Reactive repo.
5. Restart in replay mode. No key is needed and no calls are made:

   ```bash
   PORT=8790 LIVEFORGE_MANIFESTS=examples/livecraft.liveforge.yaml LIVEFORGE_PROVIDER_MODE=replay npm run dev
   ```

   The startup log says `llm: claude (replay, N cassettes)`. Badges now read **REPLAY**, and the answers arrive after
   about 300 ms.

Tips:
- Use the same seed, the same Demo buttons and the same typed lines as the recording.
- Numbers in prompts (time of day, counts) are ignored by the loose matcher.
- If one step misses, the rules answer is shown instead (grey **RULES** badge), so the take never stalls.

## Shot list (≈ 3:00)

| Time | Shot | Do | Judges see |
|---|---|---|---|
| 0:00–0:15 | **Cold open.** Fly-over of Oakhollow at noon: the plaza, the well, villagers at work. | Creative mode (G), fly over the village. | Caption: *"Every villager here is driven by Reactive."* Badge: online · REPLAY. |
| 0:15–0:55 | **1. 🏠 Build me a house.** | Click **🏠 Build me a house**. You stand facing Bram at his plot and he waves. The chat opens with *"Bram, build me a cosy house with a little tower"* filled in. Press **Enter**. | Brain View: a goal header with Bram's face. 💭 thought (SONNET), 🔧 `build({prompt:"cosy house with a little tower"})`, 📐 plan "… · 23 ops · 410 blocks (oak planks, bricks …)". A translucent ghost of the house appears on the plot. Bram fetches materials from the yard, then builds bottom-up at about 6 blocks/s, narrating ("Bottom up, as my father taught me"). Each progress update shows ⏳. Dashboard → **Agents** shows the same loop, and **Builds** shows the isometric preview and the DSL. |
| 0:55–1:30 | **2. 🌙 Night raid.** | Click **🌙 Night raid**. The village mind has already read your play style (seeded: 6 pillars, 10 bow shots). Dusk falls, and you get a bow, arrows and cobblestone. Pillar up two or three blocks and shoot. | Caption: *"Raid night 1: climbing spiders + skeleton crossfire, countering pillaring."* Brain View 🏰: threat model (pillaring 1.00, bow_heavy 0.83) → raid plan → why (HAIKU or REPLAY). The captain (for example **Lady Webweaver**) appears with a name tag and taunts *"Build your pillar as high as you like … My spiders climb."* Spiders climb the pillar, skeletons keep their distance, and Captain Rowan and the golem run in. Dashboard → **Factions** shows the raid plan with its counters. |
| 1:30–2:20 | **3. The village remembers.** | Click **🔨 Grief Mara's house** and break 3 or 4 blocks of her thatched house. | ✨ `property_damage → repair_quest`. Mara storms over and glares. Pip spreads the rumour, and Rowan announces *"Doors are bolted in Oakhollow…"* (🏰 posture calm → wary, prices ×1.25). The golem confronts you, and the quest card **Mend Mara's house** pops up. |
| | | Click **🤝 Make amends** (you get the materials and the quest). Then click **🧱 Bram, help me repair it**. | Bram's agent loop: `build({prompt:"help me repair Mara's house"})` → 📐 "Repair mara_house: 4 missing blocks". He co-builds while the quest tracker bar fills. At 80 %: *"Mara's house is mended"*, trust recovers, and the village coins a nickname (✨ deed_nicknames). **The village raises a statue of you** on the plaza in your outfit colours (📐 statue plan, placed with particles). |
| 2:20–2:50 | **4. ⚡ Forge anything.** | Click **⚡ Forge anything**. The Forge screen opens with *"a pickaxe made of lightning"*. Press Enter, or hold 🎤 and say it. | A result card with the pixel icon, name (*Stormcaller Pickaxe*), stats, effect `chain_lightning` and its crafting recipe. Brain View ⚒: rules item first, then the Sonnet design (*"The forge refined it"*). The item is in your hotbar and held as an extruded voxel model. Mine one stone: lightning arcs through the connected stone and breaks up to 6 more blocks. |
| 2:50–3:00 | **Close.** | Pull back to the plaza with the statue and the new house. | Caption: *"Reactive: engine-agnostic. Agents, builder, village mind, memory, forge. Rules instantly; AI upgrades."* |

## What to point at (voice-over notes)

- **Model badges:** SONNET (purple) for agents, build plans and forge; HAIKU (teal) for the village mind and raid
  plans; RULES (grey) for the instant answers; REPLAY (amber) for cassette answers. Every row shows its latency.
- **Rules first, AI upgrades:** the template house appears at once, and the AI plan replaces it if it lands before the
  first block. The raid always has a rules counter-plan.
- **The same tools offline:** run with `?lf=off` and every scenario still plays on local rules. This shows the game
  never blocks on the AI.
- **Engine-agnostic:** the game only registers tools, sends signals and handles directives. The dashboard shows the
  same data any engine would get.

## Utility buttons (Demo panel)

| Button | Use |
|---|---|
| ☀ Day / 🌙 Night | Jump to noon or midnight |
| Rain | Weather on/off; Reaction Library time/weather barks fire |
| Creative | Fly for the cold open |
| 🎒 Give kit | Iron tools, bow and arrows, building blocks, food |
| 🧽 Reset memory | A new Reactive world id for this seed (fresh habits, trust and quests) |
| 📊 Dashboard | Opens the dashboard on the right half of the screen |
| 🧠 Brain View, Captions, 🔊 Voices | Toggles |
| 📼 label | Shows the cassette mode |
