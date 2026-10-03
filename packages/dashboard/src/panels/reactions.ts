// Reactions (R1 Reaction Library): which recipes are on, what fired (recipe + the facets of the situation it was
// chosen for), and per NPC the live context fingerprint and the novelty ledger - the lines it will not repeat.
import { REACTION_RECIPES } from "@liveforge/protocol";
import { app } from "../app";
import type { ReactionLibraryState } from "../api/types";
import { clock, h, label, render } from "../ui/dom";
import { card, empty, errorBox, pill, useLive, type PanelDef } from "./panel";

const KIND_COLORS: Record<string, string> = {
  trait: "#9085e9", moment: "#c98500", gear: "#3987e5", color: "#d95926", style: "#5aa469", appearance: "#e66767",
  time: "#6b7385", weather: "#4aa3b5", zone: "#6b7385", rumour: "#b56fd6", attitude: "#e0a43a", nickname: "#ff7a2f", status: "#8a93a6",
};

/** "kind:key" facet chips, coloured by kind. */
export function facetChips(facets: string[], max = 8): HTMLElement {
  return h("div", { class: "chips" }, ...facets.slice(0, max).map((f) => {
    const [kind, ...rest] = f.split(":");
    return pill(`${kind}: ${rest.join(":").replace(/_/g, " ")}`, KIND_COLORS[kind] ?? "#8a93a6");
  }));
}

const title = (id: string) => REACTION_RECIPES.find((r) => r.id === id)?.title ?? id.replace(/_/g, " ");

export const reactionsPanel: PanelDef = {
  id: "reactions",
  title: "Reactions",
  icon: "spark",
  subtitle: "Reaction Library: recipes, fingerprints and the novelty ledger per NPC.",
  mount(root) {
    const libEl = h("div", { class: "side-list" });
    const firedEl = h("div", { class: "decisions" });
    const npcsEl = h("div", { class: "mem-grid" });
    const headEl = h("div", { class: "muted small" });
    render(root,
      h("div", { class: "split" },
        card("Library", { class: "side", hint: "manifest reactions.library" }, libEl),
        h("div", { class: "detail" },
          headEl,
          card("Fired reactions", { hint: "newest first · why = recipe + facets" }, firedEl),
          card("NPC fingerprints + novelty ledger", { hint: "same facets = same fingerprint; a line in the ledger is never repeated" }, npcsEl))));

    const stop = useLive(async () => {
      const s = app();
      let st: ReactionLibraryState | null;
      try {
        st = s.source.reactionLibrary ? await s.source.reactionLibrary(s.world, s.player) : null;
      } catch (e) {
        render(firedEl, errorBox(e));
        return;
      }
      if (!st) {
        render(libEl, empty("Not available", "Connect to a server to see the Reaction Library."));
        render(firedEl, empty("No data"));
        render(npcsEl, empty("No data"));
        return;
      }
      render(libEl, st.library.length ? st.library.map((r) => {
        const params = Object.entries(r.params).filter(([k]) => !["enabled", "chance", "ai"].includes(k));
        return h("div", { class: "side-item" },
          h("div", { class: "side-title" }, title(r.recipe)),
          h("div", { class: "side-sub" }, r.recipe),
          params.length ? h("div", { class: "side-tag" }, params.map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ").slice(0, 140)) : null);
      }) : empty("No recipes on", "Add reactions: { library: [outfit_comments, ...] } to the manifest."));
      const players = Object.entries(st.players);
      const [pid, p] = (s.player ? players.find(([id]) => id === s.player) : undefined) ?? players[0] ?? [];
      if (!pid || !p) {
        render(headEl, "");
        render(firedEl, empty("No player has met the library yet", "Send signals (appearance.outfit, world.time, social.promise ...) or run a preset."));
        render(npcsEl, empty("No ledger yet"));
        return;
      }
      render(headEl, [
        `player ${label(pid)}`,
        p.nickname ? `nickname "${p.nickname.name}"` : "",
        p.mood?.turned && p.mood.turned !== "neutral" ? `town ${p.mood.turned}` : "",
        p.time ? `${p.time.phase}, ${p.time.weather}` : "",
      ].filter(Boolean).join(" · "));
      render(firedEl, p.fired.length ? p.fired.map((f) =>
        h("div", { class: "decision" },
          h("div", { class: "decision-rail", style: { background: "#ff7a2f" } }),
          h("div", { class: "decision-body" },
            h("div", { class: "decision-top" }, pill(title(f.recipe), "#ff7a2f"), f.effect ? pill(f.effect) : null, pill(f.speaker), h("span", { class: "muted small" }, `fp ${f.fingerprint}`), h("span", { class: "muted small" }, clock(f.ts))),
            f.line ? h("div", { class: "decision-sum" }, `"${f.line}"`) : null,
            facetChips(f.facets),
            h("div", { class: "dir-why" }, h("span", { class: "why-tag" }, "why"), f.why)))) : empty("Nothing fired yet"));
      render(npcsEl, ...p.npcs.map((n) =>
        card(n.name, { hint: `fingerprint ${n.fingerprint}` },
          facetChips(n.facets, 10),
          h("div", { class: "small muted" }, n.sentence),
          n.ledger.length ? h("div", { class: "mem-entries" }, ...n.ledger.slice(0, 8).map((l) =>
            h("div", { class: "mem" },
              h("div", { class: "mem-top" }, pill(l.recipe === "persona" ? "persona" : title(l.recipe)), l.variant >= 0 ? h("span", { class: "muted small" }, `variant ${l.variant}`) : null, h("span", { class: "muted small" }, clock(l.ts))),
              h("div", { class: "mem-text" }, l.line)))) : h("div", { class: "muted small" }, "No lines yet."))));
    }, { interval: 4000, throttleMs: 1200, onDirective: true });
    return stop;
  },
};
