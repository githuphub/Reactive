// Factions + relationships: a player x faction reputation heatmap (diverging, -1..1) and the NPC relationship graph
// (rival / family / ally ...) that colours gossip and help.
import type { FactionState } from "@liveforge/protocol";
import { app } from "../app";
import { ForceGraph, type GraphEdge, type GraphNode } from "../viz/graph";
import { diverging, h, label, render } from "../ui/dom";
import { card, empty, errorBox, useLive, type PanelDef } from "./panel";
import { FACTION_COLORS } from "./rumours";
import { mountVillageMind } from "./village-mind";

const REL_COLORS: Record<string, string> = {
  ally: "#3987e5", friend: "#199e70", family: "#c98500", mentor: "#9085e9", employer: "#8a93a6", lover: "#d55181", rival: "#d95926", enemy: "#e66767",
};
const HOSTILE = new Set(["rival", "enemy"]);

export const factionsPanel: PanelDef = {
  id: "factions",
  title: "Factions",
  icon: "factions",
  subtitle: "Village minds (posture, prices, guards, raid plans), reputation and relationships.",
  mount(root) {
    const heat = h("div", { class: "heat-wrap" });
    const graph = new ForceGraph(440);
    const relLegend = h("div", { class: "legend" });
    const factionCards = h("div", { class: "faction-cards" });
    const mindHost = h("div", { class: "stack" });
    render(root,
      mindHost,
      card("Reputation", { hint: "player x faction, -1 hostile .. +1 revered" }, heat),
      h("div", { class: "grid g-3-2" },
        card("Relationships", { hint: "line width = strength · dashed = hostile", actions: [relLegend] }, graph.el),
        card("Factions", { hint: "from liveforge.yaml" }, factionCards)));

    const stop = useLive(async () => {
      const s = app();
      let st: FactionState | null;
      try {
        st = await s.source.projection("world.factions", s.world);
      } catch (e) {
        render(heat, errorBox(e));
        return;
      }
      const state = st ?? { reputation: {}, relationships: [] };
      const factions = s.game.factions.length ? s.game.factions : Object.keys(state.reputation).map((id) => ({ id, name: id }));
      const players = [...new Set(Object.values(state.reputation).flatMap((r) => Object.keys(r)))].sort();
      render(heat, players.length && factions.length
        ? h("table", { class: "heat" },
          h("thead", null, h("tr", null, h("th", null, "player"), ...factions.map((f) => h("th", null, f.name)))),
          h("tbody", null, ...players.map((p) => h("tr", null,
            h("td", { class: "heat-p" }, h("a", { href: `#/players/${encodeURIComponent(p)}` }, label(p))),
            ...factions.map((f) => {
              const v = state.reputation[f.id]?.[p] ?? 0;
              return h("td", { class: "heat-c", title: `${label(p)} with ${f.name}: ${v.toFixed(2)}`, style: { background: diverging(v) } }, h("span", null, v.toFixed(2)));
            })))))
        : empty("No reputation yet", "Reputation moves when players steal, help, trade or fight in a faction's zone."));
      // relationship graph
      const ids = new Set<string>();
      for (const r of state.relationships) { ids.add(r.a); ids.add(r.b); }
      for (const p of s.game.personas) ids.add(p.id);
      const fIds = factions.map((f) => f.id);
      const nodes: GraphNode[] = [...ids].map((id) => {
        const p = s.game.personas.find((x) => x.id === id);
        const fi = p?.faction ? fIds.indexOf(p.faction) : -1;
        return { id, label: p?.name ?? label(id), color: p ? "#e6e9f0" : "#5b6377", ring: fi >= 0 ? FACTION_COLORS[fi % FACTION_COLORS.length] : undefined, size: p ? 11 : 7, sub: p ? `${p.role}${p.faction ? ` · ${p.faction}` : ""}` : "background NPC" };
      });
      const edges: GraphEdge[] = state.relationships.map((r) => ({ from: r.a, to: r.b, color: REL_COLORS[r.kind] ?? "#8a93a6", width: 1 + r.strength * 4, dashed: HOSTILE.has(r.kind), label: `${r.kind} ${r.strength.toFixed(1)}` }));
      graph.setData(nodes, edges);
      const kinds = [...new Set(state.relationships.map((r) => r.kind))];
      render(relLegend, ...kinds.map((k) => h("span", { class: "legend-item" }, h("i", { class: "dot", style: { background: REL_COLORS[k] ?? "#8a93a6" } }), k)),
        ...factions.map((f, i) => h("span", { class: "legend-item" }, h("i", { class: "ring", style: { borderColor: FACTION_COLORS[i % FACTION_COLORS.length] } }), f.name)));
      const doc = await s.source.manifest().catch(() => null);
      const mf = doc?.manifest?.factions ?? [];
      render(factionCards, mf.length ? mf.map((f, i) =>
        h("div", { class: "faction" },
          h("div", { class: "faction-head" }, h("i", { class: "ring", style: { borderColor: FACTION_COLORS[i % FACTION_COLORS.length] } }), h("b", null, f.name), h("span", { class: "muted small" }, `default attitude ${f.attitude >= 0 ? "+" : ""}${f.attitude.toFixed(1)} · prices x${f.priceRange[0]}-${f.priceRange[1]}`)),
          f.description ? h("div", { class: "muted small" }, f.description) : null,
          h("div", { class: "rel-chips" }, ...Object.entries(f.relations).map(([o, v]) => h("span", { class: "rel-chip", style: { borderColor: diverging(v) } }, `${o} ${v >= 0 ? "+" : ""}${v.toFixed(1)}`))),
          h("div", { class: "muted small" }, `members: ${s.game.personas.filter((p) => p.faction === f.id).map((p) => p.name).join(", ") || "none"}`))) : factions.map((f) => h("div", { class: "faction" }, h("b", null, f.name))));
    }, { interval: 5000, throttleMs: 1500 });
    const stopMind = mountVillageMind(mindHost);
    return () => {
      stop();
      stopMind();
      graph.dispose();
    };
  },
};
