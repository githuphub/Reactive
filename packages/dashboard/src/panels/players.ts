// Player model: trait bars with evidence, the LLM profile, running stats, moments timeline, quests + achievements,
// faction standing and how each NPC feels about them.
import type { FactionState, PersonaMemories, PlayerModel, QuestLog } from "@liveforge/protocol";
import { app, setState } from "../app";
import { meter } from "../viz/charts";
import { clock, diverging, fmtNum, h, label, render, timeAgo } from "../ui/dom";
import { card, empty, errorBox, pill, useLive, type PanelDef } from "./panel";

const TRAIT_COLOR = "#ff7a2f";
const DESIGNER_COLOR = "#9085e9";

export function traitBars(model: PlayerModel, opts: { evidence?: boolean } = {}): HTMLElement {
  const entries = Object.entries(model.traits).sort((a, b) => b[1].score - a[1].score);
  if (!entries.length) return empty("No traits yet", "Traits appear once the Observer has seen enough signals.");
  return h("div", { class: "traits" }, ...entries.map(([name, t]) =>
    h("div", { class: "trait" },
      h("div", { class: "trait-head" },
        h("span", { class: "trait-name" }, name.replace(/_/g, " ")),
        t.designer ? pill("designer", DESIGNER_COLOR, { title: "manifest DSL trait" }) : null,
        h("b", { class: "trait-score" }, t.score.toFixed(2))),
      meter(t.score, t.designer ? DESIGNER_COLOR : TRAIT_COLOR, { height: 8 }),
      opts.evidence !== false && t.evidence.length ? h("div", { class: "evidence" }, ...t.evidence.slice(0, 3).map((e, i) => h("span", { class: i ? "ev-old" : "" }, e))) : null)));
}

export const playersPanel: PanelDef = {
  id: "players",
  title: "Player model",
  icon: "players",
  subtitle: "Traits with evidence, profile, moments and standing for each player.",
  mount(root) {
    const listEl = h("div", { class: "side-list" });
    const detail = h("div", { class: "detail" });
    const search = h("input", { class: "input", placeholder: "Find player…", oninput: () => drawList() }) as HTMLInputElement;
    render(root, h("div", { class: "split" }, card("Players", { class: "side" }, search, listEl), detail));
    let models: { player: string; state: PlayerModel }[] = [];

    const drawList = () => {
      const q = search.value.toLowerCase();
      const sel = app().player;
      const items = models.filter((m) => !q || m.player.toLowerCase().includes(q)).sort((a, b) => (b.state.lastSeen ?? 0) - (a.state.lastSeen ?? 0));
      render(listEl, items.length ? items.map(({ player, state }) => {
        const top = Object.entries(state.traits).sort((a, b) => b[1].score - a[1].score)[0];
        return h("button", { class: `side-item ${player === sel ? "on" : ""}`, onclick: () => setState({ player }) },
          h("div", { class: "side-title" }, label(player)),
          h("div", { class: "side-sub" }, `${fmtNum(state.eventCount)} events · ${timeAgo(state.lastSeen)}`),
          top ? h("div", { class: "side-tag" }, `${top[0].replace(/_/g, " ")} ${top[1].score.toFixed(2)}`) : null);
      }) : empty("No players"));
    };

    const stop = useLive(async () => {
      const s = app();
      try {
        models = await s.source.projectionAll("observer.player_model", s.world);
      } catch (e) {
        render(detail, errorBox(e));
        return;
      }
      if (!s.player && models.length) {
        setState({ player: models.sort((a, b) => (b.state.lastSeen ?? 0) - (a.state.lastSeen ?? 0))[0].player });
        return;
      }
      drawList();
      const player = app().player;
      if (!player) {
        render(detail, card(null, null, empty("No player selected", "Players appear once a game sends signals - or run a preset from Simulate.")));
        return;
      }
      const model = models.find((m) => m.player === player)?.state ?? (await s.source.projection("observer.player_model", s.world, player));
      const [mem, quests, factions] = await Promise.all([
        s.source.projection("persona.memories", s.world, player).catch(() => null) as Promise<PersonaMemories | null>,
        s.source.projection("quests.log", s.world, player).catch(() => null) as Promise<QuestLog | null>,
        s.source.projection("world.factions", s.world).catch(() => null) as Promise<FactionState | null>,
      ]);
      if (!model) {
        render(detail, card(null, null, empty(`No model for ${player} yet`)));
        return;
      }
      const statChips = Object.entries(model.stats).map(([k, v]) => h("span", { class: "stat-chip" }, h("i", null, k.replace(/_/g, " ")), typeof v === "number" ? fmtNum(v) : String(v)));
      const moments = model.moments.slice(0, 20);
      const factionRows = s.game.factions.map((f) => ({ f, v: factions?.reputation[f.id]?.[player] ?? 0 }));
      const npcRows = Object.values(mem?.npcs ?? {}).sort((a, b) => Math.abs(b.attitude) - Math.abs(a.attitude));
      render(detail,
        h("div", { class: "detail-head" },
          h("div", null, h("h2", null, label(player)), h("div", { class: "muted" }, `${fmtNum(model.eventCount)} events · last seen ${timeAgo(model.lastSeen)}`)),
          h("div", { class: "stat-chips" }, ...statChips)),
        h("div", { class: "grid g-1-1" },
          card("Traits", { hint: "score 0-1 · newest evidence first" }, traitBars(model)),
          h("div", { class: "stack" },
            card("Profile", { hint: model.profile ? `updated at event ${model.profile.eventCount} · ${timeAgo(model.profile.updatedAt)}` : "rich tier, every N events" },
              model.profile ? h("blockquote", { class: "profile" }, model.profile.text) : empty("No profile yet", "The Observer writes a 2-3 sentence narrative every N events.")),
            card("Moments", { hint: "broadcast as moment directives" },
              moments.length ? h("ol", { class: "timeline" }, ...moments.map((m) =>
                h("li", null,
                  h("span", { class: "tl-dot", style: { background: `rgba(255,122,47,${0.35 + m.salience * 0.65})`, width: `${8 + m.salience * 8}px`, height: `${8 + m.salience * 8}px` } }),
                  h("div", { class: "tl-body" },
                    h("div", null, h("b", null, m.kind.replace(/_/g, " ")), h("span", { class: "muted" }, ` · ${clock(m.ts)} · salience ${m.salience.toFixed(2)}`)),
                    h("div", { class: "muted" }, m.evidence.join(" · ")))))) : empty("No moments yet")))),
        h("div", { class: "grid g-1-1-1" },
          card("Quests", { hint: "reactive, from moments / rumours" },
            quests && (quests.offered.length || quests.active.length || quests.completed.length)
              ? h("div", { class: "quest-list" },
                ...quests.offered.map((q) => h("div", { class: "quest" }, pill("offered", "#c98500"), h("b", null, q.title), h("div", { class: "muted small" }, `${q.giver ? `from ${q.giver} · ` : ""}${q.origin ? `origin ${q.origin.kind}` : ""}`))),
                ...quests.active.map((a) => h("div", { class: "quest" }, pill("active", "#3fa34d"), h("b", null, a.quest.title), h("div", { class: "muted small" }, a.quest.objectives.map((o) => o.description).join(" · ")))),
                ...quests.completed.map((c) => h("div", { class: "quest" }, pill("done", "#3987e5"), h("b", null, c.title))))
              : empty("No quests yet")),
          card("Achievements", { hint: "personal, DSL-conditioned" },
            quests?.achievements.length ? h("div", { class: "badges" }, ...quests.achievements.map((a) =>
              h("div", { class: "badge", title: `${a.description}\n${a.condition}` },
                h("div", { class: "badge-icon", style: { background: a.icon.color ?? "#ff7a2f" } }, (a.icon.glyph ?? a.title).slice(0, 1).toUpperCase()),
                h("div", null, h("b", null, a.title), h("div", { class: "muted small" }, a.rarity))))) : empty("None unlocked")),
          card("Standing", { hint: "faction reputation · NPC attitude (-1..1)" },
            h("div", { class: "standing" },
              ...factionRows.map(({ f, v }) => h("div", { class: "stand-row" }, h("span", null, f.name), h("div", { class: "div-bar" }, h("div", { class: "div-fill", style: divStyle(v) })), h("b", null, v.toFixed(2)))),
              npcRows.length ? h("div", { class: "sep" }) : null,
              ...npcRows.map((n) => h("div", { class: "stand-row" }, h("span", null, s.game.personas.find((p) => p.id === n.npc)?.name ?? n.npc), h("div", { class: "div-bar" }, h("div", { class: "div-fill", style: divStyle(n.attitude) })), h("b", null, n.attitude.toFixed(2))))))),
      );
    }, { interval: 4000, throttleMs: 1200 });
    return stop;
  },
};

/** Style for a centred diverging bar (-1..1). */
export function divStyle(v: number): Partial<CSSStyleDeclaration> {
  const c = Math.max(-1, Math.min(1, v));
  return c >= 0
    ? { left: "50%", width: `${c * 50}%`, background: diverging(Math.max(0.35, c)) }
    : { left: `${50 + c * 50}%`, width: `${-c * 50}%`, background: diverging(Math.min(-0.35, c)) };
}
