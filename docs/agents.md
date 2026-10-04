# Agents

NPCs that take a goal ("build me a cosy house with a tower", "bring me 10 oak logs") and work it out step by step
with the tools your game already has. The server runs the loop; your game runs the tools.

```
game                                  Liveforge server
 lf.agents.register("bram", tools) ->  POST /v1/m/agents/register (checked against manifest agents.tools)
 lf.agents.goal("bram", "...")     ->  ask agent.goal -> {runId, accepted, plan}  (instant, final)
                                       run starts in the background:
                                         Claude (rich tier, native tool use)  or  the rules plan
 tool runs (walk, mine, build ...) <-  directive agent.tool_call {agent, runId, callId, tool, input}
 result                            ->  POST /v1/m/agents/result  (or signal agent.tool_result)
                                   <-  ... next step ...
                                   <-  directive agent.done {runId, npc, ok, summary}
 lf.brain.subscribe(...)           <-  WS {t:"brain"}: goal, thoughts, tool calls, results, done
```

## Turn it on

```yaml
modules:
  agents: true

agents:
  maxSteps: 12          # step budget per goal
  toolTimeoutMs: 30000  # wait per tool call (progress updates extend it)
  maxTokens: 1500       # per model step
  guidance: "Villagers are practical and cheerful; they narrate what they do."
  tools:                # optional allow-list: when set, the game may only register these names
    - { name: walk_to, description: "Walk to a named place, an NPC or 'player'." }
    - { name: say, description: "Say a short line out loud." }
    - { name: build, description: "Build a structure on your plot from a description." }
```

With no `tools` list, the game may register any tool. With a list, registrations are filtered to it, and when the
game registers nothing the list itself is offered to the model (the game must still handle the calls).

## In the game (JS SDK)

```ts
import { createClient } from "@liveforge/sdk";
const lf = createClient({ url: "http://localhost:8790", gameKey: "pk_dev_livecraft", player: "steve", world: "seed-42" });

lf.agents.register("bram", [
  {
    name: "walk_to",
    description: "Walk to a named place ('well', 'plot', 'forest'), an NPC id, or 'player'. Returns where you ended up.",
    schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    run: async ({ target }) => ((await bram.walkTo(target)) ? `at ${target}` : `no path to ${target}`),
  },
  {
    name: "build",
    description: "Build a structure on your plot from a description. Gathers missing materials first.",
    schema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    run: async ({ prompt }, { progress, signal }) => {
      const h = lf.builder.plan({ prompt, site: { size: [16, 14, 10] }, npc: "bram" });
      const plan = (await h.final).result.plan;              // waits for the AI plan (or keeps the template)
      const { blocks } = lf.builder.expand(plan, { origin: plot.origin });
      for (const [i, b] of blocks.entries()) {
        if (signal.aborted) return "stopped";
        await bram.place(b);
        if (i % 25 === 0) progress(`${i}/${blocks.length} blocks`);   // keeps the server waiting
      }
      return { placed: blocks.length };
    },
  },
]);

const { runId, plan, local } = await lf.agents.goal("bram", "build me a cosy house with a tower", { context: "Bram stands at his plot by the well." });
lf.agents.onDone((d) => toast(`${d.npc}: ${d.summary}`));
lf.agents.setContext("*", "Night is falling; zombies were seen at the east gate.");
lf.agents.interrupt("bram", "the player hit him");
```

- **Tools** are `{name, description, schema, run(input, {npc, runId, callId, progress, signal})}`. Return any JSON
  value; throw to report a failure (the model sees `ok: false` and the message). `signal` aborts when the run is
  interrupted or ends.
- **`goal()`** gives the NPC a goal. A new goal interrupts the NPC's current run. Unfinished earlier goals stay on a
  small goal stack the model sees as lower-priority work.
- **Offline-safe.** When the client is `offline`, or the server is unreachable, `goal()` runs the same rules plan
  locally through the registered tools and reports `local: true`. Brain entries are produced locally too.
- **`setContext(npc | "*", text)`** stores the game's latest situation text; the server puts it into the agent's
  prompt, and later changes ride along with tool results ("World update: ...").
- **`onStep(cb, npc?)`** gives you every step as a Brain entry; **`onDone(cb)`** fires when a run ends.

### Other engines

Handle the `agent.tool_call` directive (target `npc:<id>`), run the tool, then either
`POST /v1/m/agents/result {runId, callId, ok, output}` or send the signal `agent.tool_result` with the same fields.
Long tools send `agent.tool_progress {runId, callId, text}` (or `POST /v1/m/agents/progress`). Stop a run with the
signal `agent.interrupt {npc | runId, reason}` or `POST /v1/m/agents/interrupt {world, npc | runId, reason}`.

## The loop

- **AI** (an LLM key with native tool use, and at least one tool): Sonnet (`rich` tier, task `agents.step`) with a
  system prompt of persona + lore + tone + safety + designer guidance. It is stable per NPC, so prompt caching works.
  The first user turn carries the goal, the goal stack and the world context.
  - Each `tool_use` becomes one `agent.tool_call` directive. The server waits for the result: 30 s by default, and
    every progress update re-arms the timer. A timeout comes back to the model as a failed tool.
  - Text blocks become **thought** entries in the Brain feed.
  - The run stops on `end_turn`, at `maxSteps` or on an interrupt. When the player or game budget runs out (at the
    start or mid-run), the rules plan takes over.
- **Rules** (no LLM, a provider without tool use, an exhausted budget, or an LLM error mid-run): the goal is keyword-matched to a
  template and its steps call the same directives one by one, so your game code path is identical.

| Template | Matches | Steps |
|---|---|---|
| `build` | build, construct, make, repair, fix ... | `say`, `build {prompt}`, `say` |
| `fetch` | fetch, gather, collect, bring, mine, chop ... | `say`, `gather {item, count}`, `walk_to {target: player}`, `give {to: player, item, count}` |
| `follow` | follow, come with, escort ... | `say`, `follow {target: player}` |
| `guard` | guard, protect, defend, patrol ... | `say`, `guard {target}` |
| `trade` | trade, sell, buy, barter ... | `walk_to {target: player}`, `trade {with: player}` |
| `go_to` | go to, walk to, head to ... | `walk_to {target}` |
| `say` | say, tell, announce, greet ... | `say {text}` |
| (default) | anything else | `say {text}` |

Steps whose tool is not registered are skipped. Required inputs a template did not set are filled from the tool's
schema (strings from the goal, numbers `1`). The same planner is exported as `planAgentGoal(goal, {tools})`.

## Records

- Events `lf.agents.run {runId, npc, goal, state, source, plan, summary}` and
  `lf.agents.step {runId, i, kind, tool?, callId?, input?, output?, ok?, text?, model, ms}`.
- Projection **`agents.runs`** (world scope): the last 20 runs with their steps (`GET /v1/m/agents/runs?world=`,
  or `/admin/projections/agents.runs?world=`).
- `GET /v1/m/agents/tools?npc=` lists the tools an NPC can use.

## Brain feed

Every agent step, build plan and AI decision is a `BrainEntry`:

```ts
{ id, ts, source: "agents" | "builder" | "factions" | "director" | "reactions" | "forge" | "persona",
  actor, kind: "goal" | "thought" | "tool_call" | "tool_result" | "plan" | "decision" | "line",
  text, data?, model?: "sonnet" | "haiku" | "rules" | "cache" | "replay", ms?, ref? }
```

- **Live:** WS `{t:"brain", entry}` goes to every socket subscribed to the world. The `brain` topic is on by default.
- **History:** `GET /v1/brain?world=&after=<id>&limit=` serves a 300-entry ring buffer per world, kept in memory.
- **SDK:** `lf.brain.subscribe(cb, {source?, actor?, kind?, ref?})`, `await lf.brain.recent()`, and `lf.brain.add(draft)`
  for your own entries.
- **Server modules:** `ctx.brain({source, actor, kind, text, data?, model?, ms?, ref?})`. `brainModel(modelId, source)`
  gives the badge.
- **Already wired:** agents and builder, Director decisions (`lf.director.decision`), manifest reaction rules
  (`lf.world.reaction`) and Reaction Library lines (directives that carry a `reaction`).
