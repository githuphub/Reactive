# Recipe: thieves target rich players

**Goal:** flash a fat purse in the courtyard, and Kit Quickfingers comes calling. Gossip about your wealth
spreads, and the porters warn you (or don't).

## Manifest

```yaml
personas:
  - id: kit
    name: Kit Quickfingers
    role: Pickpocket
    faction: undercroft
    personality: Cheerful, quick-talking pickpocket who targets anyone who flashes forge-marks.
    allowedActions: [emote, trade, steal, flee]
    zone: courtyard
actions:
  steal:
    description: Pickpocket the player.
    args: { gold: { type: number, min: 1, max: 200 } }
    by: [npc, world]                      # reaction rules may use it too
reactions:
  - id: pickpocket_rich
    when: trait(rich) > 0.6 & stat(zone) == "courtyard"
    then:
      kind: npc.action
      target: npc:kit
      args: { npc: kit, action: { action: steal, args: { gold: 50 } } }
    cooldown: 600                         # once per 10 minutes per player
    flavour: true                         # the LLM may add a line and a plan
```

The `rich` trait is built in. It reads `economy.gold` balances, and `stat(zone)` comes from
`movement.entered_zone`.

## Game code

```ts
lf.signal("economy.gold", { amount: 1800, delta: 600 });
lf.signal("movement.entered_zone", { zone: "courtyard" });

lf.on("npc.action", (d) => {
  if (d.args.action.action !== "steal") return;
  const npc = npcs[d.args.npc];
  npc.walkTo(player).then(() => {
    const gold = Number(d.args.action.args.gold ?? 10);   // clamped to 1..200 by the action schema
    player.gold -= gold;
    if (d.args.line) bubble(npc, d.args.line);            // flavour line: "Pardon me, love - dropped something?"
    lf.signal("economy.gold", { amount: player.gold, delta: -gold });
  });
}, { target: "npc:kit" });
```

```gdscript
func _on_directive(kind: String, d: Dictionary) -> void:
    if kind == "npc.action" and d.args.action.action == "steal":
        $Kit.pickpocket(int(d.args.action.args.get("gold", 10)))
```

## Variations

| Condition | Directive |
|---|---|
| `trait(feared) > 0.7` | `world.reaction {effect: "guards keep distance, children flee"}` |
| `trait(famous) > 0.7` | `npc.bark` from a challenger NPC |
| `rep(undercroft) > 0.5` | Kit offers a fence `trade` instead of stealing |

## In the dashboard

| Panel | What you see |
|---|---|
| **Simulate → Rich hoarder** | `rich` and `hoarder` climb. |
| **Why feed** | `npc.action npc:kit` with the reason `reaction pickpocket_rich: trait(rich)=0.72 & zone=courtyard`. |
| **Rumours** | The *absurd purchase* rumour travels from Kit to the Undercroft. |
| **Factions** | Reputation shifts as Kit and the porters react. |
