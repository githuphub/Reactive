# Contributing to Reactive

Thanks for helping games notice their players. Reactive is MIT licensed, and contributions are accepted under
the same license.

## Setup

```bash
npm install
npm run build        # TypeScript (project references), JSON Schemas, dashboard
npm run dev          # server on http://localhost:8787 with watch mode; dashboard at /dashboard
npm run typecheck
```

- **Node:** 22 or newer.
- **Provider keys:** none needed. Everything works on rules. Put keys in `.env` (never commit it; see
  `.env.example`).

## Repo layout

| Path | What lives there |
|---|---|
| `packages/protocol` | Wire types (zod + TS), JSON Schemas, Blueprint/VFX/Variant/move clamps, the DSL. **Every wire change starts here.** |
| `packages/manifest` | The `liveforge.yaml` schema and validator. |
| `packages/server` | Core runtime (event log, projections, asks, WS, budgets) plus modules in `src/modules/<id>/`. |
| `packages/sdk-js`, `packages/sdk-three` | JS client and Three.js helpers. |
| `packages/dashboard` | The dashboard (Vite + TS + Three.js). |
| `godot/addons/liveforge` | Godot 4 addon (GDScript). |
| `docs/` | User docs. `docs/CONTRACTS.md` is the internal contract between all of the above. |

## Ground rules

- **Instant first.** Every ask kind must answer from rules or cache without an LLM. AI is an upgrade, never a
  dependency. With no keys configured, the whole game must still work.
- **Clamp everything.** LLM or client output passes through the manifest (action schema, item schema, move
  budget) and the protocol clamps (`clampBlueprint`, `clampVfx`, `clampMove`) before it reaches a game.
- **Event log first.** Module state is a deterministic projection of the log. Anything non-deterministic (an LLM
  profile, a generated rumour) is recorded as an `lf.<module>.<what>` event first, then folded.
- **Every decision has a `why`.** Directives and Director decisions carry a short human-readable reason. The
  dashboard depends on it.
- **Keys stay on the server.** Clients only ever hold the publishable game key.
- **Protocol changes are additive.** Add optional fields and new kinds. Renaming or removing fields bumps
  `PROTOCOL_VERSION`.

## Adding a module

Modules implement `LiveforgeModule` (`packages/server/src/module.ts`) with `defineModule({...})`:

- **projections:** deterministic folds over events.
- **signalHandlers:** react to signals; record events, emit directives.
- **asks:** `instant` (rules), `upgrade` (LLM via `ctx.llm`, which may be null), `cacheKey`.
- **ticks:** periodic work for active worlds.
- **routes:** `/v1/m/<id>/*` (public) and `/admin/m/<id>/*` (admin).

Register the module in `packages/server/src/modules/index.ts`, give it a manifest toggle, and document its
options. See `docs/CONTRACTS.md` §3–§6.

## Style

- **TypeScript:** strict, ESM, NodeNext (Bundler for the dashboard).
- **Public surface:** gets JSDoc, sensible defaults and clear error messages (`{error: {code, message}}`).
- **Small files, no clever abstractions:** readable beats generic.
- **Commits:** conventional (`feat(server): …`, `fix(dashboard): …`, `docs: …`).

## Pull requests

1. Make sure `npm run typecheck` and `npm run build` pass.
2. Describe the user-visible change, and update the docs (`docs/*.md`) when behaviour or API changes.
3. For wire changes: update `packages/protocol`, regenerate the schemas (`npm run build`), and mention which SDKs
   need to follow.
4. Screenshots or GIFs of dashboard or game changes are very welcome.

## Reporting issues

Include:

- the server version (`GET /health`);
- the manifest snippet involved (validator output helps);
- the ask or signal payloads;
- the relevant `why` strings from the dashboard.

Never paste API keys.
