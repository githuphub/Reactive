// Rumour spread graph: NPCs as nodes, "who told whom" as arrows coloured per rumour, recent hops animated. The list
// shows heat, truthfulness and how the wording drifted as it spread.
import type { Rumour, RumourState } from "@liveforge/protocol";
import { app } from "../app";
import { ForceGraph, type GraphEdge, type GraphNode } from "../viz/graph";
import { meter } from "../viz/charts";
import { h, label, render, timeAgo } from "../ui/dom";
import { card, empty, errorBox, pill, useLive, type PanelDef } from "./panel";

/** Fixed categorical order (dark steps). Rumours past the 8th fold into grey. */
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#3fa34d", "#9085e9", "#e66767"];
export const FACTION_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];

export const rumoursPanel: PanelDef = {
  id: "rumours",
  title: "Rumours",
  icon: "rumours",
  subtitle: "How gossip about players travels between NPCs, and how it mutates on the way.",
  mount(root) {
    const graph = new ForceGraph(520);
    const listEl = h("div", { class: "rumour-list" });
    const legend = h("div", { class: "legend" });
    let focus: string | null = null;
    let state: RumourState | null = null;

    render(root, h("div", { class: "grid g-3-2" },
      card("Spread graph", { hint: "drag nodes · click to focus", actions: [legend] }, graph.el),
      card("Rumours", { hint: "heat decays; each retelling may mutate" }, listEl)));

    const colorOf = (r: Rumour, ordered: Rumour[]) => {
      const i = ordered.findIndex((x) => x.id === r.id);
      return i >= 0 && i < SERIES.length ? SERIES[i] : "#6b7385";
    };

    const draw = () => {
      if (!state) return;
      const s = app();
      const factions = s.game.factions.map((f) => f.id);
      const ordered = [...state.rumours].sort((a, b) => a.createdAt - b.createdAt);
      const visible = focus ? state.rumours.filter((r) => r.id === focus) : state.rumours;
      const ids = new Set<string>();
      for (const r of visible) r.knownBy.forEach((n) => ids.add(n));
      for (const e of state.spread) if (!focus || e.rumourId === focus) { ids.add(e.from); ids.add(e.to); }
      for (const p of s.game.personas) ids.add(p.id);
      const nodes: GraphNode[] = [...ids].map((id) => {
        const p = s.game.personas.find((x) => x.id === id);
        const knows = visible.filter((r) => r.knownBy.includes(id)).length;
        const fi = p?.faction ? factions.indexOf(p.faction) : -1;
        return {
          id,
          label: p?.name ?? label(id),
          color: p ? "#e6e9f0" : "#5b6377",
          ring: fi >= 0 ? FACTION_COLORS[fi % FACTION_COLORS.length] : undefined,
          size: 7 + Math.min(10, knows * 2.2),
          sub: `${p ? `${p.role}${p.faction ? ` · ${p.faction}` : ""}` : "background NPC"} · knows ${knows} rumour${knows === 1 ? "" : "s"}`,
        };
      });
      const edges: GraphEdge[] = state.spread
        .filter((e) => !focus || e.rumourId === focus)
        .slice(-160)
        .map((e) => {
          const r = state!.rumours.find((x) => x.id === e.rumourId);
          return { from: e.from, to: e.to, color: r ? colorOf(r, ordered) : "#6b7385", arrow: true, ts: e.ts, width: 1.8 };
        });
      graph.setData(nodes, edges);
      render(legend, ...ordered.slice(0, SERIES.length).filter((r) => !focus || r.id === focus).map((r) => h("span", { class: "legend-item", title: r.content }, h("i", { class: "dot", style: { background: colorOf(r, ordered) } }), r.id)));
      render(listEl, state.rumours.length ? [...state.rumours].sort((a, b) => b.heat - a.heat).map((r) => {
        const open = focus === r.id;
        return h("div", { class: `rumour ${open ? "on" : ""}`, onclick: () => { focus = open ? null : r.id; draw(); } },
          h("div", { class: "rumour-top" }, h("i", { class: "dot", style: { background: colorOf(r, ordered) } }), h("b", null, r.id), pill(r.origin.kind), r.mutations ? pill(`${r.mutations} mutation${r.mutations === 1 ? "" : "s"}`, "#d55181") : null, h("span", { class: "muted small" }, timeAgo(r.createdAt))),
          h("div", { class: "rumour-text" }, `"${r.content}"`),
          h("div", { class: "rumour-meters" },
            h("span", { class: "small muted" }, "heat"), meter(r.heat, "#ff7a2f", { height: 5 }), h("span", { class: "small" }, r.heat.toFixed(2)),
            h("span", { class: "small muted" }, "truth"), meter(r.truthfulness, "#3987e5", { height: 5 }), h("span", { class: "small" }, r.truthfulness.toFixed(2))),
          h("div", { class: "small muted" }, `known by ${r.knownBy.length}: ${r.knownBy.map(label).join(", ")}`),
          open && r.history?.length ? h("div", { class: "drift" }, h("div", { class: "small muted" }, "drift (newest first)"), ...r.history.map((t) => h("div", { class: "drift-line" }, `"${t}"`))) : null);
      }) : empty("No rumours yet", "Moments with high salience become rumours; NPCs pass them on over time."));
    };
    graph.onSelect = () => undefined;

    const stop = useLive(async () => {
      const s = app();
      try {
        state = (await s.source.projection("world.rumours", s.world)) ?? { rumours: [], spread: [] };
      } catch (e) {
        render(listEl, errorBox(e));
        return;
      }
      draw();
    }, { interval: 3000, throttleMs: 1000, onDirective: true });
    return () => {
      stop();
      graph.dispose();
    };
  },
};
