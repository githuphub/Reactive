// Overview: KPI tiles, tension + aggression, the "why" feed of recent directives, a compact live stream and the
// players' strongest traits. The page to keep on screen next to the game in a demo.
import type { Directive, DirectorState, PlayerModel, StatsResponse, StoredEvent } from "@liveforge/protocol";
import { app, bus, eventRate, live, replacements } from "../app";
import { TimeChart, gauge, meter, sparkline } from "../viz/charts";
import { NS_COLORS, SOURCE_COLORS, clock, fmtMs, fmtNum, fmtUsd, h, label, nsOf, render, timeAgo } from "../ui/dom";
import { card, empty, pill, useLive, type PanelDef } from "./panel";

export function directiveRow(d: Directive): HTMLElement {
  const ns = d.kind.split(".")[0];
  const color = ({ npc: NS_COLORS.social, rumour: NS_COLORS.world, spawn: NS_COLORS.combat, boss: NS_COLORS.combat, pacing: NS_COLORS.movement, difficulty: NS_COLORS.movement, quest: NS_COLORS.quest, achievement: NS_COLORS.economy, forge: NS_COLORS.gear, loot: NS_COLORS.gear, moment: NS_COLORS.economy, world: NS_COLORS.world } as Record<string, string>)[ns] ?? NS_COLORS.lf;
  const args = d.args as Record<string, unknown>;
  const text = typeof args.text === "string" ? `"${args.text}"` : typeof args.line === "string" ? `"${args.line}"` : typeof args.content === "string" ? `"${args.content}"` : (args.move as { name?: string } | undefined)?.name ?? (args.quest as { title?: string } | undefined)?.title ?? (args.achievement as { title?: string } | undefined)?.title ?? "";
  const replaced = replacements.replacedBy.has(d.id);
  const replaces = replacements.replaces.get(d.id);
  return h(
    "div",
    { class: `dir-row${replaced ? " superseded" : ""}` },
    h("div", { class: "dir-top" }, pill(d.kind, color), h("span", { class: "dir-target" }, d.target), d.player ? h("span", { class: "muted" }, `· ${label(d.player)}`) : null,
      replaced ? pill("replaced by AI upgrade", "#6b7385") : null, replaces ? pill(`upgrade · replaces ${replaces}`, "#ff7a2f") : null,
      h("span", { class: "dir-time" }, clock(d.ts))),
    text ? h("div", { class: "dir-text" }, text) : null,
    reactionTags(args),
    h("div", { class: "dir-why" }, h("span", { class: "why-tag" }, "why"), d.why || "—"),
  );
}

/** Reaction Library: recipe (+ effect) and the fingerprint facets of a library directive. */
function reactionTags(args: Record<string, unknown>): HTMLElement | null {
  const r = args.reaction as { recipe?: string; facets?: string[]; fingerprint?: string } | undefined;
  const recipe = r?.recipe ?? (typeof args.recipe === "string" ? args.recipe : undefined);
  if (!recipe) return null;
  const effect = (args.payload as { effect?: unknown } | undefined)?.effect;
  return h("div", { class: "chips" }, pill(`recipe: ${recipe}`, "#ff7a2f", { solid: true }), typeof effect === "string" ? pill(effect) : null,
    ...(r?.facets ?? []).slice(0, 6).map((f) => pill(f.replace(/_/g, " "))));
}

export function eventLine(e: StoredEvent): HTMLElement {
  const ns = e.type.startsWith("lf.") ? "lf" : nsOf(e.type);
  const summary = Object.entries(e.data)
    .filter(([, v]) => typeof v !== "object" || v === null)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${String(v).slice(0, 28)}`)
    .join("  ");
  return h(
    "div",
    { class: "ev-line flash" },
    h("span", { class: "ev-time" }, clock(e.ts)),
    h("span", { class: "ev-type", style: { color: "var(--text)" } }, h("i", { class: "dot", style: { background: NS_COLORS[ns] } }), e.type),
    h("span", { class: "ev-player" }, e.player ? label(e.player) : "world"),
    h("span", { class: "ev-sum" }, summary),
  );
}

export const overviewPanel: PanelDef = {
  id: "overview",
  title: "Overview",
  icon: "overview",
  subtitle: "Everything the game is learning about its players, live.",
  mount(root) {
    const kpis = h("div", { class: "kpis" });
    const tension = new TimeChart({ color: "#ff7a2f", min: 0, max: 1, height: 190, refs: [{ value: 0.62, label: "breather" }], emptyText: "No tension samples yet" });
    const aggr = h("div", { class: "center" });
    const why = h("div", { class: "feed" });
    const stream = h("div", { class: "ev-mini" });
    const players = h("div", { class: "player-cards" });
    const rateHist: number[] = [];
    let stats: StatsResponse | null = null;

    render(
      root,
      kpis,
      h("div", { class: "grid g-3-1" },
        card("Tension curve", { hint: "Director pacing input, 0-1" }, tension.el),
        card("Aggression", { hint: "within manifest clamps" }, aggr)),
      h("div", { class: "grid g-1-1" },
        card("Why feed", { hint: "every directive carries its reason" }, why),
        card("Live signals", { hint: "admin firehose" }, stream)),
      card("Players", { hint: "strongest traits right now" }, players),
    );

    const drawKpis = () => {
      const s = app();
      const rate = eventRate();
      const w = s.worlds.find((x) => x.id === s.world);
      const mods = stats ? Object.values(stats.modules) : [];
      const asks = mods.reduce((a, m) => a + m.asks, 0);
      const hits = mods.reduce((a, m) => a + m.cacheHits, 0);
      const ups = mods.reduce((a, m) => a + m.upgrades, 0);
      const p95 = mods.length ? Math.max(...mods.map((m) => m.instantMs.p95)) : 0;
      const recentDir = live.directives.filter((d) => Date.now() - d.ts < 5 * 60_000).length;
      const tile = (k: string, v: string, sub: string, extra?: Node) => h("div", { class: "kpi" }, h("div", { class: "kpi-k" }, k), h("div", { class: "kpi-v" }, v), h("div", { class: "kpi-sub" }, sub), extra ?? null);
      render(
        kpis,
        tile("Signals / min", fmtNum(rate), `${fmtNum(w?.events || live.events.length)} events in ${s.world}`, sparkline(rateHist.slice(-40), "#ff7a2f", 140, 30, 0)),
        tile("Players", String(w?.players.length ?? 0), w?.lastEventAt ? `last activity ${timeAgo(w.lastEventAt)}` : "no activity yet"),
        tile("Directives", fmtNum(recentDir), "pushed in the last 5 min"),
        tile("AI upgrades", fmtNum(ups), asks ? `${Math.round((hits / Math.max(1, asks)) * 100)}% served from cache` : "no asks yet"),
        tile("Instant p95", fmtMs(p95), "rules / cache fast path"),
        tile("Spend today", stats ? fmtUsd(stats.budgets.game.usdToday) : "-", stats ? `of ${fmtUsd(stats.budgets.game.usdPerDay)} budget` : "", stats ? meter(stats.budgets.game.usdToday / Math.max(0.0001, stats.budgets.game.usdPerDay), "#199e70") : undefined),
      );
    };

    const drawWhy = () => {
      const list = live.directives.slice(-14).reverse();
      render(why, list.length ? list.map(directiveRow) : empty("No directives yet", "Run a preset from Simulate to see the Director, NPCs and world react."));
    };
    const drawStream = () => {
      const list = live.events.slice(-18).reverse();
      render(stream, list.length ? list.map(eventLine) : empty("Waiting for signals…"));
    };

    const offE = bus.on("event", () => drawStream());
    const offD = bus.on("directive", () => drawWhy());
    const rateTimer = setInterval(() => {
      rateHist.push(eventRate());
      if (rateHist.length > 60) rateHist.shift();
      drawKpis();
    }, 2000);
    drawWhy();
    drawStream();

    const stop = useLive(async () => {
      const s = app();
      const [st, dir, models] = await Promise.all([
        s.source.stats().catch(() => null),
        s.source.projection("director.state", s.world).catch(() => null),
        s.source.projectionAll("observer.player_model", s.world).catch(() => [] as { player: string; state: PlayerModel }[]),
      ]);
      stats = st;
      drawKpis();
      const d = dir as DirectorState | null;
      tension.update(d?.tension.map((p) => ({ ts: p.ts, value: p.value })) ?? [], d?.timeline.slice(-30).map((x) => ({ ts: x.ts, label: x.summary, color: SOURCE_COLORS[x.source] })));
      render(aggr, d ? gauge(d.aggression, { color: "#ff7a2f", label: `mode: ${d.difficultyMode}` }) : empty("Director idle"));
      const cards = models
        .sort((a, b) => (b.state.lastSeen ?? 0) - (a.state.lastSeen ?? 0))
        .slice(0, 8)
        .map(({ player, state }) => {
          const top = Object.entries(state.traits).sort((a, b) => b[1].score - a[1].score).slice(0, 3);
          return h(
            "a",
            { class: "pcard", href: `#/players/${encodeURIComponent(player)}` },
            h("div", { class: "pcard-name" }, label(player), h("span", { class: "muted" }, ` · ${state.eventCount} events`)),
            ...top.map(([k, t]) => h("div", { class: "trait-mini" }, h("span", null, k.replace(/_/g, " ")), meter(t.score, "#ff7a2f", { height: 6 }), h("b", null, t.score.toFixed(2)))),
            top.length ? null : h("div", { class: "muted small" }, "no traits yet"),
          );
        });
      render(players, cards.length ? cards : empty("No players yet"));
    }, { interval: 4000, throttleMs: 1500 });

    return () => {
      stop();
      offE();
      offD();
      clearInterval(rateTimer);
      tension.dispose();
    };
  },
};
