# K6 report: Voxel DSL, builder, agents (native tool use) and Brain feed

**Status:** done. `npm run typecheck` and `npm run build` pass in `F:/Development/Liveforge-K6` (branch `K6`). Both
example manifests still validate.

Per the user rules:
- No tests were written or run, and the server was never started.
- No live API calls were made, and no key files were read.
- While developing I evaluated the pure protocol functions (template sizes, clamp, planner) once with `node -e`. This
  was a sanity check of their output only; no test files were added.

`npm install` in the worktree needed `--ignore-scripts`, because the better-sqlite3 native build (node-gyp) failed
there. This does not affect typecheck or build, but running the server from this worktree needs a working
better-sqlite3 build.

## Commits (branch `K6`)

1. `d22a553` feat(protocol): Voxel DSL, agents and Brain wire types; manifest builder/agents sections
2. `30342da` feat(server): builder and agents modules, provider `tools()`, `ctx.brain` and the Brain ring buffer
3. `0a2e2fe` feat(sdk): `lf.agents`, `lf.builder`, `lf.brain`
4. `b08a0f5` docs: agents.md, builder.md, README "Agents & Builder"
5. (this report)

## What was built

### Voxel DSL (`@liveforge/protocol`: `voxel.ts`, `voxel-expand.ts`, `voxel-templates.ts`)

- **Types.** `VoxelPlan {name, palette, ops, summary?}`, `VoxelOp` (a union of the 14 ops) and
  `ExpandedPlan {blocks: {x, y, z, block, facing?}[], materials, bounds, warnings}`. All of them have zod validators.
  JSON Schemas are emitted as `VoxelPlan`, `VoxelOp`, `VoxelBlock`, `ExpandedPlan` and `VoxelPlan.llm`.
- **`clampVoxelPlan(raw, {maxOps = 60, maxExpandedOps = 200, maxBlocks = 4000, site?})`.** Never throws.
  - Accepts the spec form, the flat structured-output form (nulls, palette as `[{key, block}]`) or a JSON string.
  - Normalises op aliases and block ids, rounds coordinates and clamps them into the site (box ops are trimmed to it).
  - Caps radius, height, `repeat.count` and nesting (one level).
  - Enforces the op and expanded-op budgets, then drops trailing ops until the block count fits.
- **`expandVoxelPlan(plan, {site?, origin?, blockIds?, aliases?, fallback?, maxBlocks?})`.**
  - Deterministic; when ops overlap, the last write wins.
  - Order: y ascending, then structure, then details (door, window, stairs, torch-like ids), then air.
  - `door` clears 2 cells of air and puts the door block in the lower half; `window` is a single block (default
    `glass`).
  - Roofs: gable (ridge along the longer axis unless `axis` is given, end triangles filled), hip (stepped rings),
    flat (the box).
  - Unknown ids are mapped through the caller aliases, then `DEFAULT_VOXEL_ALIASES`, then plural / `_block`
    variants, then name similarity, then the fallback (default: the palette's first entry). Each mapping produces a
    warning.
- **`voxelPlanJsonSchema()`.** The flat Anthropic structured-output subset, following the ruling: an op object with
  every field required and nullable when unused. Nested ops are one level of the same flat op (no recursion).
- **`VOXEL_TEMPLATES`.** `house(w, d, h, palette)`, `tower(w, h, palette)`, `wall(length, h, palette)`,
  `statue(colors[], scale, palette)` (blocky humanoid, torso 2x3x1 units x scale, on a plinth, hex colours mapped
  with `colorToBlock`), `bridge(length, w, palette)`, `farm(w, d, palette)` and `well(palette)`.
- **Helpers.** `voxelTemplateFor(name, {size, palette, colors})` sizes a template to a site. `chooseVoxelTemplate`
  picks one by keyword. `rulesVoxelPlan` is the instant answer: "house with a tower" combines both on sites at least
  13 wide, and material words such as "stone tower" set the palette. `shiftVoxelOps` moves ops by an offset.

### builder module (`packages/server/src/modules/builder/**`)

- **Ask `builder.plan`.** Params: `{prompt, site: {size, ground?}, palette?, style?, npc?, context?}`. Result:
  `{plan, summary, materials, template?}`.
- **Instant:** a template sized to the site, with the palette from the params or the manifest's `builder.palette`.
  For statues the palette is the colours. Materials are counted after mapping to `builder.blockIds`, and the summary
  is a rules sentence.
- **Upgrade:** `ctx.llm.json(voxelPlanJsonSchema(), system, user, {tier: "rich", task: "builder.plan", maxTokens: 2500, timeoutMs: 40000})`.
  - The system prompt teaches the DSL with two compact examples (house, tower) and adds lore, tone, safety, the
    block ids and the style guide. It is stable per manifest.
  - The answer is clamped, expanded and rejected (`null`) when it has 0 blocks. The name and summary are moderated.
  - `cacheKey` is prompt + site + palette + style, kept for 24 h. `upgradeTimeoutMs` is 45 s.
- **Records:** `lf.builder.planned {npc, prompt, plan, summary, source, template, materials}` and a Brain `plan`
  entry (badge `rules` or `sonnet`).

### agents module (`packages/server/src/modules/agents/**`)

- **Provider.** `LlmProvider.tools?()` (optional) and `ClaudeProvider.tools({system, messages, tools, tier, maxTokens, timeoutMs, signal})`
  return `{content, stopReason, usage, model, ms, source?}`.
  - It uses native tool use with `tool_choice: auto` (forced choice is rejected by Sonnet 5.5) and the same knobs as
    `json()`: thinking `between_tools`, effort, and server-side refusal fallbacks with auto-disable.
  - It adds top-level `cache_control: ephemeral`, so the growing loop prefix is cached.
  - No retries. A refusal throws `TruncatedError`.
  - `ScopedLlm.tools()` and `supportsTools` wrap it with tier mapping, budget check and charge, and metrics, exactly
    like `json()`.
- **Tool registry.**
  - The manifest `agents.tools` allow-list holds `{name, description, schema}` entries.
  - `POST /v1/m/agents/register {npc | "*", tools}` validates each tool (name rule, object schema, allow-list) and
    stores the result in kv.
  - Effective tools are the NPC's registrations merged with the `"*"` registrations and filtered by the allow-list.
    With no registrations, the allow-list itself is used.
- **Ask `agent.goal {npc, goal, context?, maxSteps?}`** returns `{runId, accepted, plan, reason?}` as a final
  answer (no upgrade). It pushes the goal stack, interrupts the NPC's previous run and starts a background run.
- **AI loop** (rich tier, task `agents.step`, 30 s per step).
  - The system prompt holds persona, lore, safety and designer guidance and is stable per NPC. The user turn holds
    the goal, the goal stack (up to 3 earlier goals), the world context (kv, from `/context`) and the goal context.
  - Each `tool_use` becomes directive `agent.tool_call {agent, runId, callId, tool, input, timeoutMs, step}` with
    target `npc:<id>`, scoped to the asking player.
  - The run waits for `agent.tool_result` (signal or `POST /result`). The default timeout is 30 s (manifest
    `agents.toolTimeoutMs`), re-armed by `agent.tool_progress` (signal or `POST /progress`).
  - Results are fed back as `tool_result` blocks (`is_error` when failed). Changed world context is appended as
    "World update". Text blocks become `thought` entries.
  - The run stops on `end_turn` / `max_tokens`, at `maxSteps` (12), on interrupt (signal `agent.interrupt`, a route,
    or a new goal) or when the budget is exhausted.
- **Rules fallback** (no LLM, no tool-capable provider, no tools, or an LLM error mid-run): `planAgentGoal(goal, {tools})`
  (protocol, shared with the SDK) keyword-matches `build`, `fetch`/`gather`, `follow`, `guard`, `trade`, `go_to` and
  `say`. Required inputs are filled from each tool's schema, and the steps call the same directives sequentially.
- **Records:**
  - Events `lf.agents.run {runId, npc, goal, state, source, player, plan, summary}` and
    `lf.agents.step {runId, i, kind, tool?, callId?, input?, output?, ok?, text?, model, ms}`. Large values are capped.
  - Projection `agents.runs` (world scope; last 20 runs, 60 steps each), registered in protocol `PROJECTIONS` with
    the zod shape `AgentRuns`.
  - Directive `agent.done {runId, npc, ok, summary, state}`.
- **Routes** (`/v1/m/agents/*`): `register`, `result`, `progress`, `interrupt`, `context`, `GET runs?world=` and
  `GET tools?npc=`.
- **Concurrency:** one active run per (world, npc).

### Brain feed

- **Protocol:**
  - `BrainEntry {id, ts, source, actor, kind, text, data?, model?, ms?, ref?, world?}` and `BrainPage`.
  - `brainModel(modelId, source)` returns `replay` / `cache` / `rules`, else `haiku` or `sonnet`.
  - WS `{t: "brain", entry}` under the new topic `brain`.
- **Core:**
  - `ctx.brain(draft, scope?)` is additive in the ctx API (ModuleContext needs `{world}`; scoped contexts default
    to their world).
  - `core/brain.ts` keeps a ring buffer of 300 entries per world, served at `GET /v1/brain?world=&after=&limit=`.
  - The hub delivers entries to every socket subscribed to the world. `brain` is now in the server's default topics.
- **Hooks without touching other modules:**
  - `lf.director.decision` becomes a director `decision`. Its badge comes from the task tier (`models.overrides`,
    default fast, so `haiku`) when the source is `ai`.
  - `lf.world.reaction` becomes a reactions `decision`.
  - Directives that carry a Reaction Library `reaction` become reactions `line`s.
- **`source` passthrough:** `LlmToolsResult.source` exists, and builder and agents read `r.source` (for json results,
  through a loose cast). If K7's cassette sets `source: "replay"`, the badge shows `replay`.

### sdk-js

- **`lf.agents`:**
  - `register(npcId | "*", tools)`. Each tool is `{name, description, schema, run(input, {npc, runId, callId, progress, signal})}`.
  - Handles `agent.tool_call` directives automatically and dedupes by `callId`.
  - Posts `/result`. When that fails it falls back to the `agent.tool_result` signal. A throw becomes
    `{ok: false, output: message}`. `progress()` is throttled to 1/s. The tool's `signal` aborts on `agent.done`.
  - `goal(npc, goal, {context, maxSteps})`, `interrupt(npc, reason)`, `setContext(npc | "*", text)`,
    `onStep(cb, npc?)` (Brain entries with source `agents`), `onDone(cb)` and `toolsFor(npc)`.
  - **Offline-safe:** with `offline`, a retryable failure, or the module disabled, `goal()` runs `planAgentGoal`
    locally through the registered tools and emits local Brain entries.
- **`lf.builder`:**
  - `plan(params, opts)` is a two-stage ask.
  - A default `setFallback("builder.plan")` uses `localBuilderPlan`, the same template rules as the server.
  - `expand(plan, opts)` and `setBlockIds(ids)`.
- **`lf.brain`:** `subscribe(cb, {source?, actor?, kind?, ref?})`, `recent({limit, after})` (server history merged
  with the local buffer; local only when offline) and `add(draft)`.
- **Re-exports:** `expandVoxelPlan`, `clampVoxelPlan`, `VOXEL_TEMPLATES`, `voxelTemplateFor`, `rulesVoxelPlan`,
  `chooseVoxelTemplate`, `colorToBlock`, `voxelPlanJsonSchema`, `planAgentGoal`, `brainModel` and `localBuilderPlan`.

### Manifest

- **`builder`:** `{palette: string[], blockIds?: string[], aliases: {word: id}, maxBlocks = 4000, fallbackBlock?, styleGuide?}`.
- **`agents`:** `{tools: [{name, description, schema}], maxSteps = 12, toolTimeoutMs = 30000, maxTokens = 1500, guidance?}`.
- **Modules:** `modules.agents` and `modules.builder` (true or `{options}`) are opt-in, because undefined means off.
  `MODULE_IDS` now includes both.
- **Validation:**
  - Duplicate tool names and non-object tool schemas are errors.
  - A missing tool description is a warning.
  - Palette ids that are not in `blockIds` are warnings.
- **Module options:** `modules.builder.options {maxTokens, timeoutMs}` and `modules.agents.options {stepTimeoutMs}`.

## How to try it

1. Add the K6 sections to a manifest:

   ```yaml
   modules: { agents: true, builder: true }
   builder: { palette: [oak_planks, spruce_log, bricks, cobblestone, glass, torch] }
   agents: { tools: [ {name: say, description: "Say a line"}, {name: build, description: "Build on your plot", schema: {type: object, properties: {prompt: {type: string}}, required: [prompt]}} ] }
   ```

2. Start the server: `npm run dev` with `LIVEFORGE_MANIFESTS` set.
3. Try the builder:

   ```
   curl -X POST localhost:8790/v1/ask/builder.plan -H 'x-liveforge-key: pk_dev_<game>' -H 'content-type: application/json' \
     -d '{"world":"w","player":"p","params":{"prompt":"a cosy house with a tower","site":{"size":[16,14,10]}}}'
   ```

4. Try an agent: `POST /v1/ask/agent.goal` with `{"npc":"bram","goal":"build me a house"}`. Then watch the WS
   directives and `GET /v1/brain?world=w`, and answer each call with
   `POST /v1/m/agents/result {runId, callId, ok:true, output:"done"}`.
5. In code: see `docs/agents.md` and `docs/builder.md`.

## Shared-file edits (all additive)

- **protocol:**
  - `asks.ts`: `builder.plan` and `agent.goal`.
  - `directives.ts`: `agent.tool_call` and `agent.done`.
  - `signals.ts`: `agent.tool_result`, `agent.tool_progress` and `agent.interrupt` in BUILTIN_SIGNALS; namespace
    `agent`.
  - `ws.ts`: topic `brain` and `WsBrain`.
  - `state.ts`: PROJECTIONS `agents.runs`.
  - `index.ts`: exports.
  - `emitSchemas.ts`: new schemas, `VoxelPlan.llm.json` and index vocabularies. `schema/v1` was regenerated.
- **manifest:**
  - `schema.ts`: BuilderSchema, AgentsSchema and MODULE_IDS.
  - `validate.ts`: agents and builder checks.
  - `schema/liveforge.schema.json` was regenerated.
- **server:**
  - `module.ts`: `ScopedLlm.tools` / `supportsTools` and `ctx.brain`.
  - `providers/llm.ts`: tool-use types and `LlmProvider.tools?`.
  - `providers/claude.ts`: only the new `tools()` method plus one extra `import type` line; the constructor and
    client are untouched.
  - `core/runtime.ts`: `scopedLlm.tools`, `brain()`, the ring buffer and the hook in `appendEvent`.
  - `core/hub.ts`: `brain()` delivery and the default topic.
  - `core/fallbacks.ts`: cases for the 2 new kinds.
  - `http/app.ts`: `GET /v1/brain`.
  - `modules/index.ts`: registers agents and builder, plus ASK_OWNERS.
  - New file: `core/brain.ts`.
- **sdk-js:**
  - `client.ts`: the `agents` / `builder` / `brain` fields, constructor wiring and the `brain` WS case.
  - `index.ts`: exports.
- **docs:** `README.md` (section and docs table rows) and `docs/README.md` (index links).

## Deviations from the brief / CONTRACTS (noted)

- **CONTRACTS §1/§3** says module lanes never edit `modules/index.ts` or core. common.md and the K6 brief explicitly
  allow small additive edits there (registry, ctx API, protocol), so I followed the brief.
- **Signal payload:** spec §1.1 writes `agent.tool_result {callId, ok, output}`, and the brief adds `runId`.
  `runId` is required, because results are routed by run.
- **`BrainEntry.source`** is a free string (max 32) with `BRAIN_SOURCES` as the documented list, so plugins can use
  their own. `kind` and `model` are strict enums as in spec §4. I added optional `ref` (run or ask grouping) and
  `world`.
- **DSL additions:**
  - An extra op `block` (a single voxel; the spec has no way to place a torch or chest).
  - `facing?` on expanded blocks (doors, stairs).
  - `VoxelPlan.summary?`.
  - Mirror `at` may be a `.5` plane.
  - In the flat LLM schema, `at` is a vector; clamp takes the axis component for mirrors.
- **Optional extra fields:** `agent.goal` result `reason?`; `agent.tool_call` `timeoutMs?` / `step?`; `agent.done`
  `state?`.
- **The `builder.plan` cacheKey also includes `style`**, because it changes the output.
- **`site` in clamp and expand is the plot size.** Expand has an extra `origin` for world placement.

## Gaps and concerns

- **Typecheck only.** The loop, the routes, the WS brain delivery and the Claude `tools()` request were never run.
  The `tools()` request shape is unverified live:
  - top-level `cache_control`
  - `thinking: between_tools` with tool use
  - `fallbacks: "default"`

  If the API rejects one of these, every AI run falls back to the rules plan. That is safe, but worth a first live
  check. There is no env toggle for the top-level `cache_control`.
- **In memory only.** Active runs and the Brain ring buffer do not survive a restart, so runs that were running at
  shutdown stay `running` in the `agents.runs` projection. Pending tool calls also do not survive.
- **AI error mid-run:** the whole rules plan runs, so steps may repeat (for example a second `build`).
- **No server-side validation of tool input** against the tool's schema; the game validates.
- **`builder.plan` cache hits** (`source: "cache"`) return before `instant`, so no `lf.builder.planned` event or
  Brain entry is produced for them.
- **Directive scope:** `agent.tool_call` / `agent.done` go to the asking player (plus admin spectators), not the
  whole world. One client owns an NPC's run; in multiplayer the other clients see the work only through Brain
  entries and world sync.
- **Brain hooks not done:** factions (K7 should call `ctx.brain` from `modules/factions`), forge and persona.
  Director and reactions are hooked in core.
- **For K7:**
  - The cassette wrapper should cover `tools()`, because it uses the same `this.client.messages.create` / `beta`
    path. It should set `source: "replay"` on the result so the badge shows replay.
  - The dashboard admin WS must include `brain` if it subscribes with explicit topics.
  - The Agents panel can use `agents.runs`, `GET /v1/brain` and WS `brain`.
- **For K7 / V3:** `examples/livecraft.liveforge.yaml` needs:
  - `modules.agents: true` and `modules.builder: true`
  - `builder.palette` and `builder.blockIds` (Livecraft's ids)
  - the `agents.tools` allow-list: `walk_to`, `look_at`, `mine`, `place`, `gather`, `give`, `take`, `follow`, `say`,
    `emote`, `build`, `trade`, `guard`, `wait`

  The rules templates use the tool names `say`, `build`, `gather`, `walk_to`, `give`, `follow`, `guard` and `trade`
  with inputs `text`, `prompt`, `item` / `count`, `target`, `to` and `with`.
- **Statue colours:** `colorToBlock` maps hex to named wool ids, and `blockIds` then maps unknown wools by name. With
  only 4 wool colours in Livecraft, colour fidelity depends on V3 passing real block ids in the palette.
