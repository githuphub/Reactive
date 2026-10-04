# Livecraft

A bright, blocky voxel sandbox for the web (Vite + TypeScript + three.js), and the flagship demo of
[Reactive](../Liveforge), the adaptive-game kit. Villagers plan and build with tools, the village mind adapts
prices, guards and night raids to how you play, the village remembers what you did, and you can forge anything.
All art is generated in code.

## Run it

You need the Reactive repo next to this one (`../Liveforge`, or set `LIVEFORGE_DIR`), with its packages built
(`npm install && npm run build` there).

**1. The Reactive server (port 8790) with the Livecraft manifest**

```bash
cd ../Liveforge
PORT=8790 LIVEFORGE_MANIFESTS=examples/livecraft.liveforge.yaml npm run dev
# rules only without a key; with ANTHROPIC_API_KEY in the server env, Sonnet/Haiku upgrade the answers
# deterministic demo: LIVEFORGE_PROVIDER_MODE=replay (see docs/demo-script.md for record → replay)
```

**2. Livecraft (port 5180)**

```bash
npm install
npm run dev          # links @liveforge/* first (scripts/link-liveforge.mjs), then http://localhost:5180
```

Open `http://localhost:5180/?demo` for the Demo panel, Brain View and captions. Without a server everything still
runs on local rules (the badge says *Offline · local rules*).

`npm run typecheck` and `npm run build` link the Reactive packages first as well.

## URL parameters

| Param | |
|---|---|
| `?demo` | Demo panel (top-right), Brain View open, villager voices on |
| `?lf=http://host:8790` / `?lf=off` | Reactive server URL (default `VITE_LIVEFORGE_URL` or `http://localhost:8790`) / offline |
| `?lfkey=pk_...` | Publishable key (default `pk_dev_livecraft`) |
| `?lfworld=` `?lfplayer=` `?lfname=Alex` | Reactive world id (default `lc-<seed>`), player id, display name |
| `?lfdash=` | Dashboard URL (default `<server>/dashboard`) |
| `?cassette=replay` | Force the cassette label on the badge |
| `?seed=` `?fresh` `?creative` `?time=dusk` `?weather=rain` `?rd=6` | World options (V0) |

## Controls

| Key | |
|---|---|
| WASD, Space, Shift, Ctrl | Move, jump, sneak, sprint |
| LMB / RMB / MMB | Break / place or use / pick block |
| E | Inventory (on a villager: the villager menu) |
| **T** | Chat with the villager you look at |
| **hold V** | Talk with your voice (browser speech recognition, or the server's STT) |
| **F** | Forge anything |
| **B** | Brain View |
| G | Creative / survival |
| N | Villager name tags |
| Esc | Pause menu (with a **Demo panel · Brain View** entry) |

Ask villagers for things in plain words ("Bram, build me a cosy house with a little tower", "bring me 8 oak logs",
"follow me", "guard the gate"): the request becomes an agent goal and you can watch every step in Brain View.

## Docs

- `docs/specs/2026-10-03-livecraft-design.md`: the design spec.
- `docs/demo-script.md`: the 3-minute video script and the record → replay workflow.
- `docs/internal/V*-report.md`: lane reports (engine, survival, village, Reactive integration).
