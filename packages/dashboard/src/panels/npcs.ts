// NPC memories browser: pick an NPC, see what it remembers about every player (attitude, rolling summary and
// salience-weighted entries that decay and sharpen).
import type { NpcMemory, PersonaMemories } from "@liveforge/protocol";
import { app } from "../app";
import { meter } from "../viz/charts";
import { NS_COLORS, clock, h, label, render, timeAgo } from "../ui/dom";
import { card, empty, errorBox, pill, useLive, type PanelDef } from "./panel";
import { divStyle } from "./players";

const KIND_COLORS: Record<string, string> = {
  conversation: NS_COLORS.social,
  witnessed: NS_COLORS.combat,
  rumour: NS_COLORS.world,
  gift: NS_COLORS.quest,
  harm: "#e66767",
  trade: NS_COLORS.economy,
  other: NS_COLORS.lf,
};

export const npcsPanel: PanelDef = {
  id: "npcs",
  title: "NPC memories",
  icon: "npcs",
  subtitle: "What every NPC remembers about every player - and how they feel about it.",
  mount(root) {
    const listEl = h("div", { class: "side-list" });
    const detail = h("div", { class: "detail" });
    render(root, h("div", { class: "split" }, card("NPCs", { class: "side" }, listEl), detail));
    let selected: string | null = null;

    const stop = useLive(async () => {
      const s = app();
      let all: { player: string; state: PersonaMemories }[];
      try {
        all = await s.source.projectionAll("persona.memories", s.world);
      } catch (e) {
        render(detail, errorBox(e));
        return;
      }
      const byNpc = new Map<string, NpcMemory[]>();
      for (const { state } of all) for (const m of Object.values(state.npcs)) (byNpc.get(m.npc) ?? byNpc.set(m.npc, []).get(m.npc)!).push(m);
      const ids = [...new Set([...s.game.personas.map((p) => p.id), ...byNpc.keys()])];
      if (!selected || !ids.includes(selected)) selected = ids[0] ?? null;
      render(listEl, ids.length ? ids.map((id) => {
        const p = s.game.personas.find((x) => x.id === id);
        const mems = byNpc.get(id) ?? [];
        const avg = mems.length ? mems.reduce((a, m) => a + m.attitude, 0) / mems.length : 0;
        return h("button", { class: `side-item ${id === selected ? "on" : ""}`, onclick: () => { selected = id; void stopRun(); } },
          h("div", { class: "side-title" }, p?.name ?? label(id)),
          h("div", { class: "side-sub" }, p ? `${p.role}${p.faction ? ` · ${p.faction}` : ""}` : "background NPC"),
          h("div", { class: "side-tag" }, `${mems.length} player${mems.length === 1 ? "" : "s"} · mood ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}`));
      }) : empty("No NPCs", "Declare personas in liveforge.yaml."));
      if (!selected) {
        render(detail, card(null, null, empty("No NPC selected")));
        return;
      }
      const p = s.game.personas.find((x) => x.id === selected);
      const mems = (byNpc.get(selected) ?? []).sort((a, b) => (b.entries[0]?.ts ?? 0) - (a.entries[0]?.ts ?? 0));
      render(detail,
        h("div", { class: "detail-head" },
          h("div", null, h("h2", null, p?.name ?? label(selected)), h("div", { class: "muted" }, [p?.role, p?.faction && `faction ${p.faction}`, p?.zone && `usually in the ${p.zone.replace(/_/g, " ")}`].filter(Boolean).join(" · ")))),
        mems.length ? h("div", { class: "mem-grid" }, ...mems.map((m) =>
          card(label(m.player), { hint: m.lastTalked ? `last talked ${timeAgo(m.lastTalked)}` : `${m.entries.length} memories` },
            h("div", { class: "stand-row" }, h("span", null, "attitude"), h("div", { class: "div-bar" }, h("div", { class: "div-fill", style: divStyle(m.attitude) })), h("b", null, m.attitude.toFixed(2))),
            m.summary ? h("blockquote", { class: "profile small" }, m.summary) : null,
            h("div", { class: "mem-entries" }, ...m.entries.slice(0, 10).map((e) =>
              h("div", { class: "mem" },
                h("div", { class: "mem-top" }, pill(e.kind, KIND_COLORS[e.kind]), h("span", { class: "muted small" }, clock(e.ts))),
                h("div", { class: "mem-text" }, e.text),
                h("div", { class: "mem-sal" }, h("span", { class: "muted small" }, "salience"), meter(e.salience, "#9085e9", { height: 5 }), h("span", { class: "small" }, e.salience.toFixed(2))))))))) :
          card(null, null, empty(`${p?.name ?? selected} has no memories yet`, "Talk to them, give them something - or steal from them.")));
    }, { interval: 5000, throttleMs: 1500 });
    const stopRun = () => stop.refresh();
    return stop;
  },
};
