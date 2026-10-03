// Parse + validate liveforge.yaml with human-readable errors (path, line:col, message, hint).
import { LineCounter, parseDocument, isNode, type Document } from "yaml";
import type { z } from "zod";
import {
  BUILTIN_NPC_ACTIONS, BUILTIN_SIGNALS, COMMON_RECIPE_PARAMS, DIRECTIVE_KINDS, REACTION_RECIPE_IDS, SignalType, checkDsl, recipeDoc,
} from "@liveforge/protocol";
import { MODULE_IDS, ManifestSchema, type Manifest, type ModuleId, type PersonaConfig } from "./schema.js";

export interface ManifestIssue {
  /** "personas[2].voice.rate" */
  path: string;
  message: string;
  line?: number;
  col?: number;
  severity: "error" | "warning";
}

export type ManifestResult =
  | { ok: true; manifest: Manifest; warnings: ManifestIssue[] }
  | { ok: false; errors: ManifestIssue[]; warnings: ManifestIssue[] };

const fmtPath = (p: readonly PropertyKey[]): string =>
  p.reduce<string>((acc, k) => (typeof k === "number" ? `${acc}[${k}]` : acc ? `${acc}.${String(k)}` : String(k)), "") || "(root)";

function locate(doc: Document | null, lc: LineCounter | null, path: readonly PropertyKey[]): { line?: number; col?: number } {
  if (!doc || !lc) return {};
  // walk up until a node with a range exists (missing keys point at their parent)
  for (let n = path.length; n >= 0; n--) {
    const node = doc.getIn(path.slice(0, n) as unknown[], true);
    if (isNode(node) && node.range) {
      const pos = lc.linePos(node.range[0]);
      return { line: pos.line, col: pos.col };
    }
  }
  return {};
}

function zodMessage(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `expected ${issue.expected}${"input" in issue && issue.input === undefined ? " (missing)" : ""}`;
    case "unrecognized_keys":
      return `unknown key(s): ${issue.keys.join(", ")}`;
    case "invalid_value":
      return `must be one of: ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`;
    default:
      return issue.message;
  }
}

/** Parse YAML (or JSON) text into a validated manifest. Never throws. */
export function parseManifest(text: string, opts: { filename?: string } = {}): ManifestResult {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  const errors: ManifestIssue[] = [];
  const warnings: ManifestIssue[] = [];
  for (const e of doc.errors) {
    const pos = lc.linePos(e.pos[0]);
    errors.push({ path: "(yaml)", message: e.message.split("\n")[0], line: pos.line, col: pos.col, severity: "error" });
  }
  if (errors.length) return { ok: false, errors, warnings };
  return validateManifestObject(doc.toJS(), { doc, lc, filename: opts.filename });
}

/** Validate an already-parsed object (JSON body, programmatic manifests). */
export function validateManifestObject(
  raw: unknown,
  ctx: { doc?: Document; lc?: LineCounter; filename?: string } = {},
): ManifestResult {
  const doc = ctx.doc ?? null;
  const lc = ctx.lc ?? null;
  const errors: ManifestIssue[] = [];
  const warnings: ManifestIssue[] = [];
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ path: fmtPath(issue.path), message: zodMessage(issue), ...locate(doc, lc, issue.path), severity: "error" });
    }
    return { ok: false, errors, warnings };
  }
  const m = parsed.data;
  const err = (path: PropertyKey[], message: string) => errors.push({ path: fmtPath(path), message, ...locate(doc, lc, path), severity: "error" });
  const warn = (path: PropertyKey[], message: string) => warnings.push({ path: fmtPath(path), message, ...locate(doc, lc, path), severity: "warning" });

  // ---- uniqueness
  const dupes = (list: { id: string }[], path: string) => {
    const seen = new Set<string>();
    list.forEach((x, i) => {
      if (seen.has(x.id)) err([path, i, "id"], `duplicate id "${x.id}"`);
      seen.add(x.id);
    });
  };
  dupes(m.personas, "personas");
  dupes(m.factions, "factions");
  dupes(m.bosses, "bosses");
  const rulesBase: PropertyKey[] = Array.isArray((raw as { reactions?: unknown } | null)?.reactions) ? ["reactions"] : ["reactions", "rules"];
  {
    const seen = new Set<string>();
    m.reactions.rules.forEach((r, i) => {
      if (seen.has(r.id)) err([...rulesBase, i, "id"], `duplicate id "${r.id}"`);
      seen.add(r.id);
    });
  }
  dupes(m.achievements, "achievements");
  dupes(m.zones, "zones");

  const personaIds = new Set(m.personas.map((p) => p.id));
  const factionIds = new Set(m.factions.map((f) => f.id));
  const zoneIds = new Set(m.zones.map((z) => z.id));
  const actionNames = new Set(Object.keys(m.actions));
  const engineMoves = new Set(m.moves.engine.map((e) => e.id));

  // ---- personas
  m.personas.forEach((p, i) => {
    if (p.faction && !factionIds.has(p.faction)) err(["personas", i, "faction"], `unknown faction "${p.faction}" (declare it under factions)`);
    if (p.zone && zoneIds.size && !zoneIds.has(p.zone)) warn(["personas", i, "zone"], `zone "${p.zone}" is not declared under zones`);
    p.allowedActions?.forEach((a, j) => {
      if (!actionNames.has(a)) err(["personas", i, "allowedActions", j], `action "${a}" is not declared under actions`);
    });
  });
  if (m.personas.length && actionNames.size === 0) {
    warn(["actions"], `no actions declared: NPCs can only talk. Built-in action names: ${BUILTIN_NPC_ACTIONS.join(", ")}`);
  }
  // ---- factions / relationships
  m.factions.forEach((f, i) => {
    for (const other of Object.keys(f.relations)) if (!factionIds.has(other)) err(["factions", i, "relations", other], `unknown faction "${other}"`);
  });
  m.relationships.forEach((r, i) => {
    if (!personaIds.has(r.a)) err(["relationships", i, "a"], `unknown persona "${r.a}"`);
    if (!personaIds.has(r.b)) err(["relationships", i, "b"], `unknown persona "${r.b}"`);
  });
  // ---- DSL strings
  const checkRule = (path: PropertyKey[], src: string) => {
    const e = checkDsl(src);
    if (e) err(path, `rule ${JSON.stringify(src)}: ${e}`);
  };
  for (const [k, v] of Object.entries(m.traits)) checkRule(["traits", k], v);
  for (const [k, v] of Object.entries(m.moments)) checkRule(["moments", k], v);
  // reaction rules live at reactions[i] (list form) or reactions.rules[i] (block form)
  const rulesPath = (i: number): PropertyKey[] => [...rulesBase, i];
  m.reactions.rules.forEach((r, i) => {
    checkRule([...rulesPath(i), "when"], r.when);
    const k = r.then.kind;
    if (!(DIRECTIVE_KINDS as string[]).includes(k) && !k.startsWith("custom.")) {
      err([...rulesPath(i), "then", "kind"], `unknown directive kind "${k}" (use one of ${DIRECTIVE_KINDS.join(", ")} or custom.<name>)`);
    }
    if (k === "npc.action") {
      const action = (r.then.args as { action?: { action?: string } }).action?.action;
      if (action && !actionNames.has(action)) err([...rulesPath(i), "then", "args", "action"], `action "${action}" is not declared under actions`);
    }
  });
  // ---- reaction library
  m.reactions.library.forEach((entry, i) => {
    const rdoc = recipeDoc(entry.recipe);
    const path: PropertyKey[] = ["reactions", "library", i];
    if (!rdoc) {
      const near = REACTION_RECIPE_IDS.find((id) => id.startsWith(entry.recipe.slice(0, 4)) || entry.recipe.startsWith(id.slice(0, 6)));
      err(path, `unknown reaction recipe "${entry.recipe}"${near ? ` (did you mean "${near}"?)` : ""}. Shipped recipes: ${REACTION_RECIPE_IDS.join(", ")}`);
      return;
    }
    for (const [k, v] of Object.entries(entry.params)) {
      const spec = rdoc.params[k] ?? COMMON_RECIPE_PARAMS[k];
      if (!spec) {
        warn([...path, k], `"${entry.recipe}" has no param "${k}" (known: ${[...Object.keys(rdoc.params), ...Object.keys(COMMON_RECIPE_PARAMS)].join(", ")})`);
        continue;
      }
      if (k === "when" && typeof v === "string") checkRule([...path, k], v);
      if (spec.type === "npc" && typeof v === "string" && !personaIds.has(v)) warn([...path, k], `persona "${v}" is not declared; the recipe falls back to a nameless NPC`);
      if (spec.type === "number" && typeof v !== "number") err([...path, k], `expected a number`);
      if (spec.type === "boolean" && typeof v !== "boolean") err([...path, k], `expected true or false`);
    }
  });
  m.achievements.forEach((a, i) => checkRule(["achievements", i, "condition"], a.condition));
  m.progression.unlocks.forEach((u, i) => u.condition && checkRule(["progression", "unlocks", i, "condition"], u.condition));
  // ---- custom signals
  for (const name of Object.keys(m.signals)) {
    if (!SignalType.safeParse(name).success) err(["signals", name], `signal names are dotted lowercase, e.g. "magic.raise_dead"`);
    if (name in BUILTIN_SIGNALS) warn(["signals", name], `"${name}" is a built-in signal; no need to declare it`);
  }
  // ---- bosses / moves
  m.bosses.forEach((b, i) => {
    if (b.persona && !personaIds.has(b.persona)) err(["bosses", i, "persona"], `unknown persona "${b.persona}"`);
    b.moves.forEach((mv, j) => {
      if (!engineMoves.has(mv)) err(["bosses", i, "moves", j], `engine move "${mv}" is not declared under moves.engine`);
    });
  });
  if (!m.moves.grammar && m.moves.engine.length === 0 && m.bosses.length) {
    err(["moves"], "bosses are declared but moves.grammar is false and moves.engine is empty: the Director has nothing to use");
  }
  // ---- items
  if (m.items) {
    for (const [stat, b] of Object.entries(m.items.stats)) if (b.min > b.max) err(["items", "stats", stat], `min (${b.min}) > max (${b.max})`);
  }
  // ---- quests
  m.quests.givers?.forEach((g, i) => { if (!personaIds.has(g)) err(["quests", "givers", i], `unknown persona "${g}"`); });
  // ---- clamps
  const d = m.clamps.difficulty;
  if (d.aggressionMin > d.aggressionMax) err(["clamps", "difficulty"], "aggressionMin > aggressionMax");
  // ---- agents / builder (K6)
  {
    const seen = new Set<string>();
    m.agents.tools.forEach((t, i) => {
      if (seen.has(t.name)) err(["agents", "tools", i, "name"], `duplicate tool "${t.name}"`);
      seen.add(t.name);
      if (t.schema.type !== undefined && t.schema.type !== "object") err(["agents", "tools", i, "schema", "type"], `tool input schemas must be {type: object, properties: {...}}`);
      if (!t.description) warn(["agents", "tools", i, "description"], `tool "${t.name}" has no description: the model only knows what you tell it`);
    });
    if (m.builder.blockIds?.length) {
      const known = new Set(m.builder.blockIds);
      m.builder.palette.forEach((b, i) => {
        if (!known.has(b)) warn(["builder", "palette", i], `"${b}" is not in builder.blockIds (plans map it to the nearest known block)`);
      });
    }
  }
  // ---- modules
  for (const k of Object.keys(m.modules)) {
    if (!(MODULE_IDS as readonly string[]).includes(k)) warn(["modules", k], `"${k}" is not a built-in module (fine if a plugin registers it)`);
  }
  if (!moduleEnabled(m, "observer") && MODULE_IDS.some((x) => x !== "observer" && moduleEnabled(m, x))) {
    warn(["modules", "observer"], "observer is off: traits, moments and profiles will be empty for every other module");
  }

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, manifest: m, warnings };
}

/** One issue per line: "liveforge.yaml:12:5 personas[0].faction: unknown faction "x"". */
export function formatIssues(issues: ManifestIssue[], filename = "liveforge.yaml"): string {
  return issues
    .map((i) => `${filename}${i.line ? `:${i.line}:${i.col ?? 1}` : ""} ${i.severity === "warning" ? "warning" : "error"} ${i.path}: ${i.message}`)
    .join("\n");
}

export class ManifestError extends Error {
  constructor(public readonly issues: ManifestIssue[], filename?: string) {
    super(`Invalid Liveforge manifest${filename ? ` (${filename})` : ""}:\n${formatIssues(issues, filename)}`);
    this.name = "ManifestError";
  }
}

// ---------------------------------------------------------------- helpers for the server / modules

export function moduleEnabled(m: Manifest, id: ModuleId | string): boolean {
  const t = (m.modules as Record<string, boolean | { enabled: boolean }>)[id];
  if (t === undefined) return false;
  return typeof t === "boolean" ? t : t.enabled;
}

export function moduleOptions(m: Manifest, id: ModuleId | string): Record<string, unknown> {
  const t = (m.modules as Record<string, boolean | { options: Record<string, unknown> }>)[id];
  return t && typeof t === "object" ? t.options : {};
}

export function personaById(m: Manifest, id: string): PersonaConfig | undefined {
  return m.personas.find((p) => p.id === id);
}

/** Actions an NPC may take: persona allowedActions ∩ manifest actions usable "by npc". */
export function actionsFor(m: Manifest, personaId: string): string[] {
  const all = Object.entries(m.actions).filter(([, a]) => a.by.includes("npc")).map(([k]) => k);
  const p = personaById(m, personaId);
  return p?.allowedActions ? all.filter((a) => p.allowedActions!.includes(a)) : all;
}

/** True when a signal type is built-in or declared (or undeclared signals are allowed). */
export function signalAllowed(m: Manifest, type: string): boolean {
  return type in BUILTIN_SIGNALS || type in m.signals || m.allowUndeclaredSignals;
}
