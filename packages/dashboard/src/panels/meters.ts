// Cost / latency / cache meters per module, plus game budgets. Instant (rules / cache) latency is shown next to
// AI upgrade latency so the two-stage design is visible at a glance.
import type { StatsResponse } from "@liveforge/protocol";
import { app } from "../app";
import { gauge, meter, sparkline } from "../viz/charts";
import { fmtMs, fmtNum, fmtUsd, h, render, timeAgo } from "../ui/dom";
import { card, empty, errorBox, useLive, type PanelDef } from "./panel";

const MODULE_COLORS: Record<string, string> = {
  observer: "#3987e5", persona: "#d95926", world: "#199e70", director: "#c98500", forge: "#d55181", quests: "#3fa34d",
};

export const metersPanel: PanelDef = {
  id: "meters",
  title: "Cost & latency",
  icon: "meters",
  subtitle: "Per-module asks, cache hits, latency and spend against the manifest budgets.",
  mount(root) {
    const top = h("div", { class: "grid g-4" });
    const mods = h("div", { class: "module-grid" });
    const table = h("div");
    const history = new Map<string, number[]>();
    render(root, top, mods, card("Detail", { hint: "p50 / p95 per stage" }, table));

    const stop = useLive(async () => {
      let st: StatsResponse;
      try {
        st = await app().source.stats();
      } catch (e) {
        render(mods, errorBox(e));
        return;
      }
      const b = st.budgets.game;
      const all = Object.values(st.modules);
      const asks = all.reduce((a, m) => a + m.asks, 0);
      const hits = all.reduce((a, m) => a + m.cacheHits, 0);
      const cacheRate = st.cache.hits + st.cache.misses ? st.cache.hits / (st.cache.hits + st.cache.misses) : asks ? hits / asks : 0;
      render(top,
        card("Tokens / min", { hint: `limit ${fmtNum(b.tokensPerMin)}` }, h("div", { class: "center" }, gauge(b.tokensLastMin / Math.max(1, b.tokensPerMin), { color: "#3987e5", label: `${fmtNum(b.tokensLastMin)} in the last minute` }))),
        card("Spend today", { hint: `budget ${fmtUsd(b.usdPerDay)}` }, h("div", { class: "center" }, gauge(b.usdToday / Math.max(0.0001, b.usdPerDay), { color: "#199e70", label: fmtUsd(b.usdToday) }))),
        card("Cache", { hint: `${fmtNum(st.cache.entries)} entries` }, h("div", { class: "center" }, gauge(cacheRate, { color: "#9085e9", label: `${fmtNum(st.cache.hits)} hits · ${fmtNum(st.cache.misses)} misses` }))),
        card("Server", { hint: `since ${timeAgo(st.since)}` }, h("div", { class: "big-stats" },
          h("div", null, h("b", null, fmtNum(asks)), h("span", null, "asks")),
          h("div", null, h("b", null, fmtNum(all.reduce((a, m) => a + m.upgrades, 0))), h("span", null, "AI upgrades")),
          h("div", null, h("b", null, String(st.ws.connections)), h("span", null, "sockets")),
          h("div", null, h("b", null, fmtNum(all.reduce((a, m) => a + m.errors, 0))), h("span", null, "errors")))));
      const entries = Object.entries(st.modules);
      if (!entries.length) {
        render(mods, card(null, null, empty("No module activity yet")));
        render(table, null);
        return;
      }
      const maxUp = Math.max(1, ...entries.map(([, m]) => m.upgradeMs.p95));
      render(mods, ...entries.map(([id, m]) => {
        const hist = history.get(id) ?? [];
        hist.push(m.asks);
        if (hist.length > 40) hist.shift();
        history.set(id, hist);
        const deltas = hist.map((v, i) => (i ? v - hist[i - 1] : 0)).slice(1);
        const c = MODULE_COLORS[id] ?? "#8a93a6";
        const hitRate = m.asks ? m.cacheHits / m.asks : 0;
        return h("div", { class: "module" },
          h("div", { class: "module-head" }, h("i", { class: "dot", style: { background: c } }), h("b", null, id), h("span", { class: "muted small" }, `${fmtNum(m.asks)} asks`), deltas.length > 1 ? sparkline(deltas, c, 90, 24, 0) : null),
          h("div", { class: "lat" },
            h("div", { class: "lat-row" }, h("span", null, "instant"), h("div", { class: "lat-bar" }, h("div", { class: "lat-p50", style: { width: `${(m.instantMs.p50 / maxUp) * 100}%`, background: c } }), h("div", { class: "lat-p95", style: { width: `${(m.instantMs.p95 / maxUp) * 100}%`, background: c } })), h("b", null, fmtMs(m.instantMs.p95))),
            h("div", { class: "lat-row" }, h("span", null, "upgrade"), h("div", { class: "lat-bar" }, h("div", { class: "lat-p50", style: { width: `${(m.upgradeMs.p50 / maxUp) * 100}%`, background: c } }), h("div", { class: "lat-p95", style: { width: `${(m.upgradeMs.p95 / maxUp) * 100}%`, background: c } })), h("b", null, fmtMs(m.upgradeMs.p95)))),
          h("div", { class: "stand-row" }, h("span", null, "cache"), meter(hitRate, c, { height: 6 }), h("b", null, `${Math.round(hitRate * 100)}%`)),
          h("div", { class: "module-foot" }, h("span", null, `${fmtNum(m.inputTokens + m.outputTokens)} tok`), h("span", null, fmtUsd(m.usd)), m.errors ? h("span", { class: "bad" }, `${m.errors} err`) : h("span", { class: "muted" }, "0 err")));
      }));
      render(table, h("table", { class: "data-table" },
        h("thead", null, h("tr", null, ...["module", "asks", "upgrades", "cache hits", "errors", "instant p50", "instant p95", "upgrade p50", "upgrade p95", "tokens in", "tokens out", "cost"].map((x) => h("th", null, x)))),
        h("tbody", null, ...entries.map(([id, m]) => h("tr", null,
          h("td", null, h("i", { class: "dot", style: { background: MODULE_COLORS[id] ?? "#8a93a6" } }), ` ${id}`),
          ...[fmtNum(m.asks), fmtNum(m.upgrades), fmtNum(m.cacheHits), fmtNum(m.errors), fmtMs(m.instantMs.p50), fmtMs(m.instantMs.p95), fmtMs(m.upgradeMs.p50), fmtMs(m.upgradeMs.p95), fmtNum(m.inputTokens), fmtNum(m.outputTokens), fmtUsd(m.usd)].map((v) => h("td", { class: "num" }, v)))))));
    }, { interval: 3000, onEvent: false });
    return stop;
  },
};
