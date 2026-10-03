// Director: tension curve with decision markers, aggression gauge inside the manifest clamp band, bosses with
// their invented moves, and the decision timeline - every entry with its `why` and where it came from.
import type { DirectorState, MoveSpec } from "@liveforge/protocol";
import { app } from "../app";
import { TimeChart, gauge } from "../viz/charts";
import { SOURCE_COLORS, clock, h, render } from "../ui/dom";
import { card, empty, errorBox, pill, useLive, type PanelDef } from "./panel";

const ELEMENT_COLORS: Record<string, string> = { fire: "#d95926", ice: "#3987e5", lightning: "#c98500", physical: "#8a93a6" };

export function moveCard(m: MoveSpec): HTMLElement {
  const stat = (k: string, v: string | number) => h("div", { class: "mv-stat" }, h("i", null, k), h("b", null, String(v)));
  return h("div", { class: "move" },
    h("div", { class: "move-head" }, h("b", null, m.name), pill(m.element, ELEMENT_COLORS[m.element] ?? "#9085e9"), pill(`${m.shape} · ${m.pattern}`)),
    h("div", { class: "move-taunt" }, `"${m.taunt}"`),
    h("div", { class: "mv-stats" },
      stat("count", m.count), stat("telegraph", `${m.telegraph}s`), stat("speed", `x${m.speed}`), stat("size", `x${m.size}`), stat("damage", m.damage_budget), stat("status", m.status), stat("bias", m.bias)),
    m.engine ? h("div", { class: "small muted" }, `engine move ${m.engine.moveId} ${Object.entries(m.engine.params).map(([k, v]) => `${k}=${v}`).join(" ")}`) : null);
}

export const directorPanel: PanelDef = {
  id: "director",
  title: "Director",
  icon: "director",
  subtitle: "Pacing, difficulty and boss adaptation - each decision with its reason.",
  mount(root) {
    const chart = new TimeChart({ color: "#ff7a2f", min: 0, max: 1, height: 220, refs: [{ value: 0.62, label: "breather threshold" }] });
    const gaugeEl = h("div", { class: "center" });
    const bossesEl = h("div", { class: "bosses" });
    const timeline = h("div", { class: "decisions" });
    const filterEl = h("div", { class: "chips" });
    const legend = h("div", { class: "legend" }, ...Object.entries(SOURCE_COLORS).map(([k, c]) => h("span", { class: "legend-item" }, h("i", { class: "dot", style: { background: c } }), k)));
    let kindFilter: string | null = null;
    let state: DirectorState | null = null;
    let band: [number, number] | undefined;

    render(root,
      h("div", { class: "grid g-3-1" },
        card("Tension", { hint: "markers = decisions, coloured by source", actions: [legend] }, chart.el),
        card("Aggression", { hint: "hidden-adaptive / assist / off" }, gaugeEl)),
      h("div", { class: "grid g-2-3" },
        card("Bosses", { hint: "invented moves stay in rotation (manifest maxInvented)" }, bossesEl),
        card("Decision timeline", { hint: "newest first", actions: [filterEl] }, timeline)));

    const draw = () => {
      if (!state) return;
      const s = app();
      chart.update(state.tension.map((p) => ({ ts: p.ts, value: p.value })), state.timeline.map((d) => ({ ts: d.ts, label: `${d.kind}: ${d.summary}`, color: SOURCE_COLORS[d.source] ?? "#8a93a6" })));
      render(gaugeEl, gauge(state.aggression, { color: "#ff7a2f", label: `mode: ${state.difficultyMode}`, band, size: 180 }));
      const bosses = Object.entries(state.bosses);
      render(bossesEl, bosses.length ? bosses.map(([id, b]) => {
        const info = s.game.bosses.find((x) => x.id === id);
        const phases = info?.phases ?? 3;
        return h("div", { class: "boss" },
          h("div", { class: "boss-head" },
            h("b", null, info?.name ?? id),
            h("div", { class: "phases" }, ...Array.from({ length: phases }, (_, i) => h("span", { class: `phase ${i + 1 <= b.phase ? "on" : ""}` }, String(i + 1)))),
            b.attune ? pill(`attuned: ${b.attune}`, ELEMENT_COLORS[b.attune] ?? "#9085e9") : null),
          b.invented.length ? h("div", { class: "moves" }, ...b.invented.map(moveCard)) : h("div", { class: "muted small" }, "No invented moves yet - it is still watching."));
      }) : empty("No bosses declared"));
      const kinds = [...new Set(state.timeline.map((d) => d.kind))];
      render(filterEl, h("button", { class: `chip ${kindFilter === null ? "on" : ""}`, onclick: () => { kindFilter = null; draw(); } }, "all"),
        ...kinds.map((k) => h("button", { class: `chip ${kindFilter === k ? "on" : ""}`, onclick: () => { kindFilter = k; draw(); } }, k.replace(/_/g, " "))));
      const items = state.timeline.filter((d) => !kindFilter || d.kind === kindFilter).slice().reverse().slice(0, 80);
      render(timeline, items.length ? items.map((d) =>
        h("div", { class: "decision" },
          h("div", { class: "decision-rail", style: { background: SOURCE_COLORS[d.source] ?? "#8a93a6" } }),
          h("div", { class: "decision-body" },
            h("div", { class: "decision-top" }, pill(d.kind.replace(/_/g, " ")), pill(d.source, SOURCE_COLORS[d.source], { solid: true }), h("span", { class: "muted small" }, clock(d.ts))),
            h("div", { class: "decision-sum" }, d.summary),
            h("div", { class: "dir-why" }, h("span", { class: "why-tag" }, "why"), d.why)))) : empty("No decisions yet", "The Director decides when tension, habits or moments call for it."));
    };

    const stop = useLive(async () => {
      const s = app();
      try {
        state = await s.source.projection("director.state", s.world);
      } catch (e) {
        render(timeline, errorBox(e));
        return;
      }
      const doc = await s.source.manifest().catch(() => null);
      const c = doc?.manifest?.clamps.difficulty;
      band = c ? [c.aggressionMin, c.aggressionMax] : undefined;
      if (!state) {
        render(timeline, empty("Director has no state for this world yet"));
        return;
      }
      draw();
    }, { interval: 2500, throttleMs: 800, onDirective: true });
    return () => {
      stop();
      chart.dispose();
    };
  },
};
