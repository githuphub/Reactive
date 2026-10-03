// Village mind (K7 factions module), shown at the top of the Factions panel: per faction its posture, price
// multiplier, mood, trust per player, guard posts, damage and threats, the last council decision with its why,
// posture history, and raid plans with their counters, captain taunt and why.
import type { FactionMind } from "@liveforge/protocol";
import { app } from "../app";
import { meter } from "../viz/charts";
import { clock, diverging, h, label, render, timeAgo } from "../ui/dom";
import { card, empty, errorBox, pill, useLive } from "./panel";
import { modelPill, posturePill, POSTURE_COLORS } from "./k7-ui";

function trustRows(mind: FactionMind): HTMLElement {
  const rows = Object.entries(mind.trust).sort((a, b) => a[1] - b[1]).slice(0, 8);
  if (!rows.length) return h("div", { class: "muted small" }, "no players known yet");
  return h("div", { class: "standing" }, ...rows.map(([p, v]) => h("div", { class: "stand-row" },
    h("span", null, label(p)),
    h("div", { class: "div-bar" }, h("div", { class: "div-fill", style: { left: v < 0 ? `${50 + v * 50}%` : "50%", width: `${Math.abs(v) * 50}%`, background: diverging(v) } })),
    h("b", null, v.toFixed(2)))));
}

function raidCard(r: FactionMind["raids"][number]): HTMLElement {
  const total = r.waves.reduce((n, w) => n + w.count, 0);
  return h("div", { class: "raid" },
    h("div", { class: "dir-top" },
      h("b", null, `Night ${r.night ?? "?"}`),
      pill(r.size, "#d95926"),
      r.player ? h("span", { class: "muted small" }, `vs ${label(r.player)}`) : null,
      h("span", { class: "dir-time" }, clock(r.ts)),
      modelPill(r.source === "rules" ? "rules" : r.source === "replay" ? "replay" : "haiku")),
    h("div", { class: "chips" }, ...r.waves.map((w) => h("span", { class: "wave-chip" }, h("b", null, `${w.count} ${w.mob}`), ` ${w.tactic} · ${w.spawn}`))),
    r.counters.length ? h("ul", { class: "counters" }, ...r.counters.map((c) => h("li", null, h("b", null, c.habit.replace(/_/g, " ")), " → ", c.tactic, h("span", { class: "muted" }, ` (${c.why})`)))) : null,
    r.captain ? h("div", { class: "taunt" }, h("b", null, `${r.captain.name}: `), `"${r.captain.taunt}"`) : null,
    h("div", { class: "dir-why" }, h("span", { class: "why-tag" }, "why"), h("span", null, r.why), h("span", { class: "muted small" }, ` · ${total} mobs`)));
}

function mindCard(name: string, mind: FactionMind): HTMLElement {
  const color = POSTURE_COLORS[mind.posture] ?? "#8a93a6";
  const lp = mind.lastPlan;
  const recentDamage = mind.damage.recent.slice(-5).reverse();
  return card(name, {
    class: "mind-card",
    hint: `${mind.phase ? `${mind.phase} · ` : ""}posture since ${mind.postureSince ? timeAgo(mind.postureSince) : "start"}`,
    actions: [posturePill(mind.posture), h("span", { class: "price-tag", style: { borderColor: color } }, `prices x${mind.priceMult.toFixed(2)}`)],
  },
    h("div", { class: "grid g-1-1-1" },
      h("div", { class: "stack" },
        h("div", { class: "kpi-k" }, "Mood"),
        h("div", { class: "mood-row" }, meter((mind.mood + 1) / 2, mind.mood >= 0 ? "#3fa34d" : "#e66767", { height: 8 }), h("b", null, mind.mood.toFixed(2))),
        h("div", { class: "kpi-k" }, "Trust per player"),
        trustRows(mind)),
      h("div", { class: "stack" },
        h("div", { class: "kpi-k" }, "Guard posts"),
        mind.guards.length ? h("ul", { class: "guards" }, ...mind.guards.map((g) => h("li", null, h("b", null, label(g.npc)), " → ", h("code", null, g.post)))) : h("div", { class: "muted small" }, "no guards assigned"),
        h("div", { class: "kpi-k" }, `Damage (${mind.damage.count} total, ~${Math.round(mind.damage.value)} gold)`),
        recentDamage.length ? h("ul", { class: "guards" }, ...recentDamage.map((d) => h("li", null, `${d.object}${d.owner ? ` (${label(d.owner)})` : ""}`, h("span", { class: "muted small" }, ` ${d.player ? label(d.player) : ""} · ${timeAgo(d.ts)}`)))) : h("div", { class: "muted small" }, "nothing broken"),
        mind.threats.length ? h("div", { class: "kpi-k" }, "Threats") : null,
        mind.threats.length ? h("ul", { class: "guards" }, ...mind.threats.slice(-4).reverse().map((t) => h("li", null, pill(t.kind, "#e66767"), ` ${t.note ?? t.source}`, h("span", { class: "muted small" }, ` · ${timeAgo(t.ts)}`)))) : null),
      h("div", { class: "stack" },
        h("div", { class: "kpi-k" }, "Last decision"),
        lp ? h("div", { class: "dir-row" },
          h("div", { class: "dir-top" }, pill(lp.kind, "#d95926"), h("span", { class: "dir-time" }, clock(lp.ts)), modelPill(lp.model ?? (lp.source === "rules" ? "rules" : lp.source))),
          h("div", null, lp.summary),
          lp.announcement ? h("div", { class: "dir-text" }, `"${lp.announcement}"`) : null,
          h("div", { class: "dir-why" }, h("span", { class: "why-tag" }, "why"), lp.why)) : h("div", { class: "muted small" }, "no decision yet"),
        mind.history.length ? h("div", { class: "kpi-k" }, "Posture history") : null,
        mind.history.length ? h("ul", { class: "history" }, ...mind.history.slice(-6).reverse().map((x) => h("li", null, h("i", { class: "dot", style: { background: POSTURE_COLORS[x.posture] ?? "#8a93a6" } }), ` ${x.posture} x${x.priceMult.toFixed(2)} `, h("span", { class: "muted small" }, `${clock(x.ts)} · ${x.source}`)))) : null)),
    mind.raids.length ? h("div", { class: "raids" }, h("div", { class: "kpi-k" }, "Raid plans"), ...mind.raids.slice(-3).reverse().map(raidCard)) : null);
}

/** Mount the village-mind section into `host`; returns a dispose function. */
export function mountVillageMind(host: HTMLElement): () => void {
  return useLive(async () => {
    const s = app();
    let st;
    try {
      st = await s.source.projection("factions.mind", s.world);
    } catch (e) {
      render(host, errorBox(e));
      return;
    }
    const minds = Object.values(st?.factions ?? {});
    if (!minds.length) {
      render(host, card("Village mind", { hint: "factions module" }, empty("No village mind", "Enable it with modules.factions: true and give a faction members (see docs/factions.md).")));
      return;
    }
    const names = new Map(s.game.factions.map((f) => [f.id, f.name]));
    render(host, ...minds.map((m) => mindCard(names.get(m.faction) ?? m.faction.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), m)));
  }, { interval: 4000, throttleMs: 1200, onDirective: true });
}
