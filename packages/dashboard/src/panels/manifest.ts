// Manifest validator: paste or upload liveforge.yaml and get the same errors the server would give (the validator
// from @liveforge/manifest runs right here in the browser), with click-to-line and a summary when it is valid.
import { formatIssues, moduleEnabled, parseManifest, type Manifest, type ManifestIssue } from "@liveforge/manifest";
import { app } from "../app";
import { h, icon, render, toast } from "../ui/dom";
import { card, empty, pill, type PanelDef } from "./panel";

const STORE_KEY = "liveforge.dashboard.manifestDraft";
const STARTER = `liveforge: 1
game:
  id: my_game
  name: My Game
lore:
  bible: |
    One paragraph about your world. Every prompt may rely on it.
  tone: wry, warm
personas:
  - id: smith
    name: Old Tom
    role: Blacksmith
    personality: Gruff, kind, remembers every blade he ever sold.
actions:
  emote: { description: Play an emote., args: { name: { type: string, required: true } } }
`;

function summary(m: Manifest): HTMLElement {
  const row = (k: string, v: string | number) => h("div", { class: "sum-row" }, h("span", null, k), h("b", null, String(v)));
  return h("div", { class: "sum" },
    h("h3", null, m.game.name, h("span", { class: "muted" }, `  ${m.game.id}`)),
    m.game.description ? h("div", { class: "muted small" }, m.game.description) : null,
    h("div", { class: "sum-grid" },
      row("personas", m.personas.length), row("factions", m.factions.length), row("relationships", m.relationships.length),
      row("zones", m.zones.length), row("actions", Object.keys(m.actions).length), row("custom signals", Object.keys(m.signals).length),
      row("designer traits", Object.keys(m.traits).length), row("reactions", m.reactions.rules.length), row("library recipes", m.reactions.library.length), row("bosses", m.bosses.length),
      row("engine moves", m.moves.engine.length), row("achievements", m.achievements.length), row("item families", m.items?.families.length ?? 0),
      row("safety rating", m.safety.rating), row("difficulty", `${m.clamps.difficulty.mode} ${m.clamps.difficulty.aggressionMin}-${m.clamps.difficulty.aggressionMax}`),
      row("budget / day", `$${m.budgets.game.usdPerDay}`), row("models", `${m.models.fast} / ${m.models.rich}`)),
    h("div", { class: "vi-tags" }, ...Object.keys(m.modules).map((k) => pill(k, moduleEnabled(m, k) ? "#3fa34d" : "#6b7385", { title: moduleEnabled(m, k) ? "enabled" : "disabled" }))));
}

export const manifestPanel: PanelDef = {
  id: "manifest",
  title: "Manifest validator",
  icon: "manifest",
  subtitle: "Paste or upload liveforge.yaml - errors come back with line numbers and fixes.",
  mount(root) {
    let draft = "";
    try {
      draft = localStorage.getItem(STORE_KEY) ?? "";
    } catch {
      /* storage unavailable */
    }
    const gutter = h("div", { class: "gutter" });
    const ta = h("textarea", { class: "code", spellcheck: false, wrap: "off" }) as HTMLTextAreaElement;
    const result = h("div", { class: "validate-result" });
    const status = h("div", { class: "validate-status" });
    const file = h("input", { type: "file", accept: ".yaml,.yml,.json,text/yaml,application/json", class: "hidden" }) as HTMLInputElement;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let errLines = new Set<number>();

    const drawGutter = () => {
      const n = ta.value.split("\n").length;
      render(gutter, ...Array.from({ length: n }, (_, i) => h("div", { class: errLines.has(i + 1) ? "gl err" : "gl" }, String(i + 1))));
      gutter.scrollTop = ta.scrollTop;
    };
    const jump = (line?: number, col?: number) => {
      if (!line) return;
      const lines = ta.value.split("\n");
      let pos = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      pos += Math.max(0, (col ?? 1) - 1);
      ta.focus();
      ta.setSelectionRange(pos, pos + Math.max(1, (lines[line - 1]?.length ?? 1) - ((col ?? 1) - 1)));
      ta.scrollTop = Math.max(0, (line - 6) * 20);
    };
    const issueRow = (i: ManifestIssue) =>
      h("button", { class: `issue issue-${i.severity}`, onclick: () => jump(i.line, i.col) },
        h("span", { class: "issue-sev" }, i.severity === "error" ? "error" : "warning"),
        h("span", { class: "issue-loc" }, i.line ? `${i.line}:${i.col ?? 1}` : "-"),
        h("code", { class: "issue-path" }, i.path),
        h("span", { class: "issue-msg" }, i.message));

    const validate = () => {
      const text = ta.value;
      try {
        localStorage.setItem(STORE_KEY, text);
      } catch {
        /* ignore */
      }
      if (!text.trim()) {
        errLines = new Set();
        drawGutter();
        render(status, pill("empty", "#6b7385"));
        render(result, empty("Paste a liveforge.yaml", "Or load the server's current manifest / upload a file."));
        return;
      }
      const r = parseManifest(text, { filename: "liveforge.yaml" });
      const issues = r.ok ? r.warnings : [...r.errors, ...r.warnings];
      errLines = new Set(issues.filter((i) => i.severity === "error" && i.line).map((i) => i.line!));
      drawGutter();
      if (r.ok) {
        render(status, h("div", { class: "vs vs-ok" }, icon("check", 16), h("b", null, " Valid manifest"), r.warnings.length ? h("span", null, ` · ${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}`) : null));
        render(result, r.warnings.length ? h("div", { class: "issues" }, ...r.warnings.map(issueRow)) : null, summary(r.manifest));
      } else {
        render(status, h("div", { class: "vs vs-bad" }, icon("x", 16), h("b", null, ` ${r.errors.length} error${r.errors.length === 1 ? "" : "s"}`), r.warnings.length ? h("span", null, ` · ${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}`) : null,
          h("button", { class: "btn btn-ghost btn-sm", onclick: () => navigator.clipboard?.writeText(formatIssues(issues)).then(() => toast("Copied", "ok")) }, "Copy as text")));
        render(result, h("div", { class: "issues" }, ...issues.map(issueRow)));
      }
    };
    const schedule = () => {
      drawGutter();
      if (timer) clearTimeout(timer);
      timer = setTimeout(validate, 250);
    };
    ta.addEventListener("input", schedule);
    ta.addEventListener("scroll", () => (gutter.scrollTop = ta.scrollTop));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText("  ", s, ta.selectionEnd, "end");
        schedule();
      }
    });
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      ta.value = await f.text();
      toast(`Loaded ${f.name}`, "ok");
      validate();
      file.value = "";
    });
    const loadCurrent = async () => {
      try {
        const doc = await app().source.manifest();
        if (doc.yaml) ta.value = doc.yaml;
        else if (doc.manifest) ta.value = JSON.stringify(doc.manifest, null, 2);
        else throw new Error("the server did not return a manifest");
        toast(`Loaded ${doc.filename ?? "current manifest"}`, "ok");
        validate();
      } catch (e) {
        toast(`Could not load: ${(e as Error).message}`, "err");
      }
    };
    const dropZone = h("div", { class: "editor" }, gutter, ta);
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("drag");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag"));
    dropZone.addEventListener("drop", async (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag");
      const f = e.dataTransfer?.files[0];
      if (f) {
        ta.value = await f.text();
        validate();
      }
    });

    render(root, h("div", { class: "grid g-1-1" },
      card("liveforge.yaml", {
        hint: "drop a file here",
        actions: [
          h("button", { class: "btn btn-sm", onclick: loadCurrent }, icon("download", 14), " Load current"),
          h("button", { class: "btn btn-sm", onclick: () => file.click() }, icon("upload", 14), " Upload"),
          h("button", { class: "btn btn-sm btn-ghost", onclick: () => { ta.value = STARTER; validate(); } }, "Starter"),
          file,
        ],
      }, dropZone),
      card("Result", { hint: "same validator as the server" }, status, result)));

    ta.value = draft;
    if (!draft) void loadCurrent();
    else validate();
    return () => {
      if (timer) clearTimeout(timer);
    };
  },
};
