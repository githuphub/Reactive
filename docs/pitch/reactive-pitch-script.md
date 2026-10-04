# Reactive: 3-minute pitch script

**Deck:** "Reactive — Hackathon Pitch" (10 slides). **Total:** 3:00. Speak at about 150 words per minute. *Italics* are stage directions.
**Repo:** https://github.com/githuphub/Reactive

**Before you go on stage:**
- Reactive server running with AI on, Livecraft open with the Demo panel.
- Bram's plot is clear, and Brain View is visible.
- Second screen: the dashboard. Recorded cassettes are the fallback if the network wobbles.

---

## 0:00–0:25 · Slides 1–2 · The hook (stale games)

*[Slide 1, cover: two beats of silence, then:]*

> You've heard this line a thousand times.
>
> *[Slide 2: the repeated "Lovely weather" lines.]*
>
> Same line, every visit. Same boss, a fixed pattern you look up on a wiki. Same world, which forgets you the moment you leave.
> Games are written once… and played a million times.

## 0:25–0:45 · Slides 3–4 · The problem and the reveal

*[Slide 3]*

> For players, that means games feel scripted, predictable and solved.
> For studios, it's the content treadmill: every reaction is hand-written, and players burn through it faster than teams can write it.
> So: what if the game reacted to you?

*[Slide 4, orange reveal]*

> This is **Reactive**: a reaction engine you plug into any game. It watches what players do, remembers it, and changes the world back. Live, and different every time.

## 0:45–1:05 · Slide 5 · Four games you know

> Imagine Elden Ring where the boss notices you always roll left, sweeps left, and mocks your fourteenth death.
> GTA where the shopkeeper remembers the robbery, and the rumour spreads across the city.
> Stardew Valley where neighbours remember the gift and the broken promise, and you can just *talk* to them.
> And a Minecraft-style world where villagers build what you ask for. Let me show you that one.

## 1:05–2:20 · Slide 6 → switch to Livecraft · Live demo (75 s)

**Beat 1 · Voice agent builds (about 30 s)**

*[Click "🏠 Build me a house" in the Demo panel. Look at Bram, hold V:]*

> "Bram, build me a cosy house with a little tower."

*[Release V. Point at the Brain View while it fills.]*

> That's real speech. Bram is an AI agent: he plans, calls tools in the game (walk, gather, place) and builds it block by block. Every step and the reason for it is here in the Brain View.

**Beat 2 · Forge anything (about 20 s)**

*[Press F, type a prompt, Forge.]*

> Forge anything. I describe it, and the AI designs it as a 3D voxel thing that exists in the world right now. Nobody made this asset.

*(Fallback while the forge lane is paused: use the **Building** tab with "a wizard tower" and right-click the blueprint to build it.)*

**Beat 3 · The village remembers (about 25 s)**

*[Click "Grief Mara's house", break a few blocks.]*

> Now I'll be a terrible neighbour. Watch: Mara saw it. The rumour spreads villager to villager, it changes as it travels, prices go up, the golem comes for me, and a repair quest appears.

*[Press J to open the Journal.]*

> And here's what the village now thinks of me.

## 2:20–2:45 · Slides 7–8 · How it works

*[Slide 7, the loop]*

> Under the hood it's one loop. The game's SDK sends **signals** (a block was broken, a dodge, something said). The Reactive server keeps an event log and runs modules: memory, rumours, a Director, agents, forge, quests. Then it sends **directives** back, each with a "why".
> And it never blocks a frame: an instant rules answer in milliseconds, then the AI upgrade streams in. It even works offline.

*[Slide 8]*

> Studios stay in control. One manifest sets what the AI is allowed to do, with budgets and moderation. Haiku handles fast reactions, Sonnet handles agents and forging. Voice is built in. And you can record a session and replay it deterministically for QA.

## 2:45–3:00 · Slides 9–10 · Engines and close

*[Slide 9]*

> It runs live on the web today, there's a Godot 4 addon, Unity and Unreal are next, and any engine can talk to it through the open protocol.

*[Slide 10]*

> Reactive is MIT licensed and self-hosted. Plug it into your game this afternoon: github.com/githuphub/Reactive.
> Every game can be a living world. Thank you.

---

## Cut list (if you're running long)

- **Slide 5:** drop the Stardew line (−5 s).
- **Beat 2:** skip it if the forge is slow; mention it on slide 8 (−20 s).
- **Slide 8:** say only "Studios stay in control: guardrails, model tiers, voice, record and replay." (−10 s)

## Likely judge questions

- **Cost per player?** Fast reactions run on Haiku, and everything is cached and budgeted per player in the manifest. Rules answer instantly at no cost.
- **What if the AI says something off-brand?** The manifest allow-lists actions, clamps values, sets a safety rating and moderates text in and out. The rules fallback is always there.
- **Latency?** Two-stage answers: the instant rules answer never waits on the model, and the AI upgrade streams over WebSocket.
- **Does it work in my engine?** Today it's the Web SDK and the Godot addon. Any engine can use the plain HTTP + WebSocket JSON protocol with JSON Schemas.
