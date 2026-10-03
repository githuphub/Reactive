# Record / replay cassettes

Record every LLM answer once, then replay them: a demo that behaves the same every time, costs nothing and needs
no API key. Replayed answers still arrive as AI upgrades (after a ~300 ms simulated latency, streamed sentence by
sentence where the original was streamed), and everything that shows a model shows **replay**.

```bash
# 1. record (needs ANTHROPIC_API_KEY): play the demo once
LIVEFORGE_PROVIDER_MODE=record npm run dev
# 2. commit the cassettes (they hold prompts and answers, never keys)
git add cassettes && git commit -m "demo cassettes"
# 3. replay anywhere, no key
LIVEFORGE_PROVIDER_MODE=replay npm run dev
#    llm: claude (replay, 42 cassettes)
```

## Settings

| Env | Default | |
|---|---|---|
| `LIVEFORGE_PROVIDER_MODE` | `live` | `live` calls the API; `record` calls it and saves every answer; `replay` serves saved answers only. |
| `LIVEFORGE_CASSETTES` | `./cassettes` | The directory (relative to the server's working directory). Commit it; it is not gitignored. |
| `LIVEFORGE_CASSETTE_LATENCY_MS` | `300` | Simulated latency before a replayed answer. |
| `LIVEFORGE_CASSETTE_FUZZY` | `0.6` | Near-miss threshold (0-1) for fuzzy matching; `0` = exact and loose matches only. |

The startup log says which mode is on: `llm: claude (replay, 42 cassettes)`. In replay mode the LLM provider is
created even without `ANTHROPIC_API_KEY`, so modules get a non-null `ctx.llm` and schedule their upgrades as usual.

## How it works

The wrapper sits on the Anthropic **client** (`providers/cassette.ts`, hooked in where `claude.ts` constructs it). It
covers `messages.create` and `messages.stream` and their `beta.messages` twins, so every provider call is
recorded: `json()`, `stream()` and the agents module's `tools()`.

- **Key:** sha256 of the canonical request: model, system, messages, tools, tool choice and the output schema.
  Betas, effort, `max_tokens`, cache hints and metadata are left out. Volatile text is normalised first: ISO
  times, epoch-ms numbers and "3 min ago" phrases.
- **Matching** in replay, in order:
  1. **exact** key;
  2. **loose** key: the same request with every number replaced, because trait scores, counters and prices drift
     between runs;
  3. **fuzzy**: same model, system prompt, tools, schema and conversation shape; the cassette whose message words
     overlap most (Jaccard ≥ `LIVEFORGE_CASSETTE_FUZZY`) wins.
- **Miss:** the call throws `ReplayMissError`. Callers treat it like any LLM failure, so the rules answer stands,
  and nothing is called.
- **Streams:** recorded as the final message and replayed as a synthetic stream: text (or tool-input JSON) in small
  chunks, so sentence streaming (`npc.reply`) still works.
- **Files:** one JSON per cassette, `<model>-<key16>.json`, holding `{v, key, loose, group, model, createdAt,
  streamed, request, response}`. Re-recording the same request overwrites its file.

## What "replay" looks like

- Replayed messages carry the model id `replay:<model>` (for example `replay:claude-haiku-4-5`).
- **Metrics:** `/admin/stats` logs them with source `replay`, 0 tokens and $0. Budgets are not charged.
- **Why:** modules that print the model in their `why` (persona replies, raid plans) show `replay`. Director timeline
  entries from the village mind end with `(replay)`.
- **Brain:** `modelBadge(model)` (exported from `providers/cassette.ts`) maps a model id to the Brain badge:
  `replay`, `haiku` or `sonnet`, or `rules` when there was no model.
- **Dashboard:** the top bar shows a LIVE / RECORD / REPLAY badge with the cassette count. Pick another mode there to
  switch at runtime.

## Admin routes

| Route | |
|---|---|
| `GET /admin/cassettes?limit=` | `{mode, dir, count, liveAvailable, latencyMs, fuzzy, stats: {hits, looseHits, fuzzyHits, misses, recorded}, cassettes: [{key, file, model, createdAt, streamed, preview}]}` |
| `POST /admin/cassettes/mode {mode}` | Switch `live` / `record` / `replay` at runtime. Answers 503 `provider_unavailable` for live or record without an API key. |
| `POST /admin/cassettes/reload` | Re-read the directory (after copying cassettes in). |

## Tips for a deterministic demo

- Record with the same manifest, seeds and scripted steps you will demo (a Demo panel helps).
- Keep prompts free of wall-clock times. The normaliser handles the common forms, but your own game context strings
  should not embed `Date.now()`.
- Replay with `upgrade: true` asks as usual. If a step misses, the rules answer is shown, so the demo never stalls.
- Record again after changing a system prompt: the system prompt is part of every key.
