# Recipe: an NPC that comments on your armour

**Goal:** you put on a gaudy helmet, and the porter notices: *"Ooh, a Gilded Circlet! Heavy, is it?"* The next
time you talk to him, he still remembers it.

## Manifest

```yaml
personas:
  - id: pell
    name: Pell
    role: Head porter
    personality: Gossip with a heart of gold. Calls everyone "young master" and notices every new thing you wear.
    voice: { pitch: 0.9, rate: 1.1, accent: en-GB, style: chatty }
    likes: [shiny things, punctuality]
    barks:
      - Heard you've been busy, young master.
    zone: courtyard
```

That is all the configuration it needs. Persona & Voice turns gear signals into memories, and bark context
includes the player's current gear.

## Game code

Report what the player equips. `name`, `tags` and `value` give the NPC something to talk about.

```ts
lf.signal("gear.equipped", { item: "gilded_circlet", slot: "head", name: "Gilded Circlet", tags: ["gold", "showy"], value: 900 });

// When the player walks up (or let LiveNPC do it with barkRadius):
const bark = lf.ask("npc.bark", { npc: "pell", trigger: "gear", context: { slot: "head" } });
say("pell", (await bark.instant).result.text);
bark.onUpgrade((r) => say("pell", r.result.text));
```

With `@liveforge/three`, `new LiveNPC({ client: lf, id: "pell", object, player })` asks for proximity barks
automatically. Its `say` events carry the line.

```gdscript
Liveforge.send_signal("gear.equipped", {"item": "iron_helm", "slot": "head", "name": "Iron Helm", "tags": ["iron"], "value": 120})
var a := Liveforge.ask("npc.bark", {"npc": "bess", "trigger": "gear"})
a.answered.connect(func(r): $Bess.say(r.text))
```

**What arrives:**

- **Instant:** a line from the persona's bark pool or a gear template.
- **Upgrade:** a line written for this item and this NPC's personality, with `emote` and `voice` hints.

## Also unprompted

Very valuable gear (and the `absurd_purchase` moment) can trigger an `npc.bark` **directive** with no ask at all:

```ts
lf.on("npc.bark", (d) => say(d.args.npc, d.args.text), { target: "npc:pell" });
```

## In the dashboard

| Panel | What you see |
|---|---|
| **Signal stream** | `gear.equipped` arrives. |
| **NPC memories → Pell** | A *witnessed* entry: "Saw a Gilded Circlet … on their head." |
| **Why feed** | The bark with its reason, e.g. `gear comment: equipped Gilded Circlet (900 marks)`. |
