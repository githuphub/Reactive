# Recipe: a boss that punishes dodging

**Goal:** the player always rolls left. By phase 2, the Forge Titan has *invented* a fan sweep that covers the
left side, announces it with a taunt, and the dashboard shows why.

## Manifest

```yaml
moves:
  grammar: true                       # allow invented moves (bounded by the move grammar + damage budget)
  engine:                             # moves your game already implements, with tunable params
    - { id: slam,  name: Anvil Slam, shape: slam, params: { radius: { min: 2, max: 6, default: 3 } } }
    - { id: sweep, name: Tong Sweep, shape: beam, params: { arc: { min: 60, max: 240, default: 120 } } }
bosses:
  - id: forge_titan
    name: The Forge Titan
    phases: 3
    moves: [slam, sweep]
    counters: [dodger, turtle, ranged_camper, Piercing]   # habits / gear tags it may counter
    maxInvented: 3
clamps:
  difficulty: { mode: hidden, aggressionMin: 0.25, aggressionMax: 0.9, maxStep: 0.15 }
```

## Game code

1. Report the fight honestly:

   ```ts
   lf.signal("combat.dodged", { source: "forge_titan", attack: "slam", direction: "left" });
   lf.signal("combat.hit", { target: "forge_titan", target_type: "boss", damage: 12 });
   lf.signal("combat.hurt", { source: "forge_titan", damage: 9, hp: 0.8, attack: "sweep" });
   ```

2. Let `LiveBoss` handle the rest. Map engine moves to your code, and build grammar moves from primitives:

   ```ts
   import { LiveBoss } from "@liveforge/three";

   const titan = new LiveBoss({
     client: lf, id: "forge_titan",
     moves: { slam: (p) => anvilSlam(p.radius as number), sweep: (p) => tongSweep(p.arc as number) },
     onGrammarMove: (m) => castMove(m),   // m.shape "beam", m.pattern "fan", m.bias "left", m.count, m.telegraph ...
     speakTaunts: true,
   });

   titan.dodged("left", "slam");                          // shorthand for the combat.* signals
   titan.requestPhase(2, { hp: 0.66, gear: player.gearTags });   // instant rules plan, AI counters as the upgrade
   titan.performNext();                                    // in your AI loop: pick from the weighted rotation
   ```

3. Or do it by hand:

   ```ts
   lf.on("boss.move_added", (d) => {
     rotation.add(d.args.move, d.args.engineMove);     // engineMove: { moveId: "sweep", params: { arc: 200 } }
     subtitle(d.args.move.taunt);                      // "You always roll left, little smith."
     console.log("why:", d.why);                       // "p1 dodges left 75% of the time (24 dodges) ..."
   });
   ```

Every invented move passes `clampMove`:

- the shape and element come from your manifest;
- telegraph, speed and size stay within their bounds;
- damage stays under the per-shape budget, scaled by `moves.damageScale`.

The Director never authors a stun-lock.

```gdscript
# Godot: LiveBoss node with move ids mapped to methods, or by hand:
func _on_directive(kind: String, d: Dictionary) -> void:
    if kind == "boss.move_added" and d.args.boss == "training_dummy":
        $TrainingDummy.learn(d.args.move)
        $Subtitle.text = d.args.move.taunt
```

## In the dashboard

| Panel | What you see |
|---|---|
| **Simulate → Dodger** | Fires 26 dodges, mostly to the left. |
| **Player model** | `dodger` climbs past 0.5, with the evidence "dodged 22x recently, 75% to the left". |
| **Director** | A `boss_move` decision with source `ai`, the new move card (beam · fan · bias left), the aggression step inside the clamp band, and the `why`. |
