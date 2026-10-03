# Village mind (factions)

Each faction (a village, a camp, a guild) gets a small brain. It watches what players do to its members and its
home, decides how the village treats outsiders right now, and plans the night's raid so it counters how this
player plays. Rules answer instantly; with an API key a short Haiku "council" upgrades the decision.

What the village decides:

- a **posture**: `calm`, `wary`, `hostile` or `festive`;
- a **price multiplier** for every shop in the village;
- **guard posts**: where each guard and golem stands;
- a **raid plan** on demand (`faction.raid_plan`): waves of mobs, the counter for each habit, a captain who taunts
  the habit, and a *why*.

## Switch it on

```yaml
factions:
  - id: oakhollow
    name: Oakhollow
    priceRange: [0.75, 1.8]
    members: [bram, mara, hilde, pip, captain_rowan, iron_golem]   # plus personas with faction: oakhollow
    home: oakhollow                       # zone id: signals there count as "in the village"
    traits: { proud: 0.8, nosy: 0.7 }     # village character, fed to the council
    guards: [captain_rowan, iron_golem]   # default: members whose role says guard / captain / golem
    posts: [gate, square, well, farm, walls]
    raid:
      mobs: [zombie, skeleton, creeper, spider, baby_zombie]
      captains: [Lady Webweaver, Old Rattlebones]
      size: medium

modules:
  factions: true          # opt-in: the module pushes directives your game must handle
```

Module options (`modules.factions.options`), all optional:

| Option | Default | |
|---|---|---|
| `council` | `true` | LLM council upgrade when the posture changes (fast tier, task `factions.council`). |
| `councilCooldownSec` | `30` | Minimum seconds between two councils of one faction. |
| `postureMinSec` | `20` | A posture holds this long before it may calm down. Escalation is immediate. |
| `windowMin` | `10` | Minutes of damage and threats the rules look at. |
| `directorTimeline` | `true` | Also put decisions on the Director timeline (`lf.director.decision`). |
| `directives` | `true` | Push `custom.faction_posture` and `custom.guard_posts`. |

## What it folds (`factions.mind`)

The projection `factions.mind` (world scope) holds one mind per faction:
`{posture, priceMult, trust: {player: -1..1}, damage: {count, value, recent[]}, threats[], guards[{npc, post}],
lastPlan, mood, rumours, phase, history[], raids[]}`. It folds:

| Input | Effect |
|---|---|
| `lf.world.reputation` | **trust** per player. This is the World module's reputation for the faction, mirrored, not a second copy. Add reputation rules for your own signals under `modules.world.options.reputation`. |
| `world.property_damaged`, `world.destroyed` (with owner), `block.broken` (with owner) of a member or in `home` | **damage** (count, rough value, last 12), mood down |
| `combat.killed` of a member | a **killer** threat (level 1), mood −0.5 |
| `economy.stole` from / `social.threatened` a member | **thief** / **threat** threats, mood down |
| `social.gave`, `world.helped`, trades, quest completions (giver a member), `block.placed` in the village | mood up |
| `combat.killed` of a raid mob in the village | mood up (you defended it) |
| `lf.world.rumour` about a player that a member knows | mood by the rumour's sentiment × heat |
| `world.time` | the day phase (`night` and `dusk` change the night watch) |
| `lf.factions.threat` (route below) | a game-reported threat |

Mood decays toward 0 with a 10-minute half-life; threats fade with a 5-minute half-life.

## The council

Every 20 s, and within 1.5 s of an important signal, the rules decide:

| Posture | When |
|---|---|
| `hostile` | worst trust ≤ −0.6, a fresh killer threat, 10+ things broken (or ~120 gold of damage) in the window |
| `wary` | worst trust ≤ −0.25, a threat ≥ 0.35, 2+ things broken, or mood ≤ −0.3 |
| `festive` | mood ≥ 0.45, worst trust ≥ 0.3, nothing broken and no threat |
| `calm` | otherwise |

"Worst trust" is the lowest trust among players the village saw in the last 30 minutes. The price multiplier is
`{calm 1, wary 1.25, hostile 1.6, festive 0.85} × (1 − 0.3 × trust)`, clamped to the faction's `priceRange` and
`clamps.npc.priceMultiplier`. Guard posts:

| Posture | Posts |
|---|---|
| `festive` | everyone at `square` |
| `calm` | spread over `posts` (night: the first posts, the night watch) |
| `wary` | first guard at the first post, second at the trouble spot (`home:<owner>` of the most damaged house) |
| `hostile` | first guard at the trouble spot, the rest at `player:<worst player>` (confront them) |

When something changed the module records `lf.factions.decision`, pushes the directives below, adds a Director
timeline entry (`kind: faction_posture`) and a Brain entry (`source: factions`). With an LLM, a Haiku council
then reviews it: it may move the posture **one step** (calm ↔ wary ↔ hostile, calm ↔ festive), set prices
within range, reassign guards to declared posts, and write the announcement. Its answer is clamped and moderated,
and pushed as a second `custom.faction_posture` with `stage: "ai"`.

## Directives

```jsonc
// custom.faction_posture (target "world", every player in the world)
{ "faction": "oakhollow", "posture": "wary", "priceMult": 1.4, "previous": "calm", "stage": "rules",
  "announcement": "Doors are bolted in Oakhollow. Someone keeps breaking mara's house, so prices rise." }
// custom.guard_posts (target "world")
{ "faction": "oakhollow", "posts": [{ "npc": "captain_rowan", "post": "gate" }, { "npc": "iron_golem", "post": "home:mara" }] }
```

Post ids are yours to map: anything from `posts`, plus `home:<npc>` (that member's house) and `player:<id>` (shadow or
confront that player). A later `stage: "ai"` posture replaces the rules one (show its announcement instead).

## Raid plans: `faction.raid_plan`

```ts
const raid = lf.factions.raidPlan({ night: 2 });   // params: {faction?, player?, night?, size?: small|medium|large}
spawner.plan((await raid.instant).result);          // rules counter-plan, instant
raid.onUpgrade((r) => spawner.plan(r.result));       // Haiku plan, same shape
```

Result: `{waves: [{mob, count, tactic, spawn: edge|underground|behind_player|rooftops, delaySec?}], captain?: {name,
taunt}, counters: [{habit, tactic, why}], why, faction, night, size, aggression, habits[]}`.

The rules read the player's last 20 minutes of signals plus Observer traits:

| Habit | Read from | Counter |
|---|---|---|
| `pillaring` | `build.pillared {height}`, trait `pillarer` | climbing spiders + skeleton crossfire |
| `bow_heavy` | `combat.shot_bow`, hits with a bow, traits `archer`, `ranged_camper` | shielded zombies + rush |
| `hiding` | `combat.hid {depth}`, traits `hider`, `turtle` | creepers tunnel underground |
| `melee_heavy` | melee `combat.hit`, trait `berserker` | skeletons keep distance |
| `kiting` | `movement.sprint*`, `combat.dodged`, fleeing, traits `speedrunner`, `dodger` | fast baby zombies |
| `fire` | fire / lava hits, items and blocks | fire-resistant tactic, spread out |

No strong habit means a mixed wave. The two strongest habits split the mob budget; the budget grows with the
Director's aggression (`director.state`) and a little each night, inside the size limits (small 6, medium 12,
large 20 mobs; 2 / 3 / 4 waves). The captain's taunt (7 templates, seeded per player and night) names the habit:
*"Build your pillar as high as you like, ember. My spiders climb."*

The Haiku upgrade gets the habits, the counter-table and the rules draft, and must answer in the same shape. Mobs
are restricted to the faction's `raid.mobs` (an enum in the schema, and clamped again), counts to the size limits,
spawns to the four points; the taunt is moderated. Both stages record `lf.factions.raid_plan`, a Director timeline
entry (`kind: raid_plan`) and Brain entries (threat model → plan → why). Upgraded plans are cached by player,
night, size, the top two habits and the aggression band, so the same situation gets the same plan.

## SDK

```ts
const mind = await lf.factions.state("oakhollow");    // FactionMind | null
const all = await lf.factions.all();                  // {oakhollow: FactionMind, ...}
lf.factions.onPosture((p) => { shop.setPrices(p.priceMult); toast(p.announcement); }, { faction: "oakhollow" });
lf.factions.onGuardPosts((g) => g.posts.forEach(({ npc, post }) => villagers[npc].walkTo(post)));
await lf.factions.reportThreat({ faction: "oakhollow", kind: "raid", source: "zombie", level: 0.7 });
```

Offline, `raidPlan` answers with a plain mixed raid.

## Routes

| Route | |
|---|---|
| `GET /v1/m/factions/state?world=&faction=` | One faction's mind (`{faction, name, mind}`); without `faction`, `{factions: {...}}`. |
| `POST /v1/m/factions/threat {world, faction, kind?, source?, level?, note?, player?}` | Report a threat; the village re-thinks at once. |
| `GET /admin/m/factions/state?world=` | Every mind plus the resolved config (members, guards, posts, raid mobs). |
| `POST /admin/m/factions/council {world, faction?}` | Force a council now (rules, then the LLM when keyed). |

Events: `lf.factions.decision`, `lf.factions.raid_plan`, `lf.factions.threat`.
