// Live signal stream: every stored event of the world as it arrives, filterable by player, namespace and text,
// with directives interleaved. Click a row for its JSON.
import type { Directive, StoredEvent } from "@liveforge/protocol";
import { app, bus, live } from "../app";
import { NS_COLORS, clock, h, icon, jsonView, label, nsOf, render } from "../ui/dom";
import { card, empty, pill, type PanelDef } from "./panel";

type Row = { kind: "event"; e: StoredEvent } | { kind: "directive"; d: Directive };

export const streamPanel: PanelDef = {
  id: "stream",
  title: "Signal stream",
  icon: "stream",
  subtitle: "Every signal and directive in the selected world, as it happens.",
  mount(root) {
    const namespaces = ["combat", "economy", "social", "movement", "gear", "quest", "world", "custom"];
    const on = new Set(namespaces);
    let paused = false;
    let showInternal = false;
    let showDirectives = true;
    let text = "";
    let player = app().player ?? "";
    let buffered = 0;

    const list = h("div", { class: "stream-list" });
    const pauseBtn = h("button", { class: "btn", onclick: () => togglePause() });
    const pausedNote = h("span", { class: "muted small" });
    const playerSel = h("select", { class: "input", onchange: () => { player = playerSel.value; redraw(); } }) as HTMLSelectElement;
    const search = h("input", { class: "input", placeholder: "Filter by type or data…", oninput: () => { text = search.value.toLowerCase(); redraw(); } }) as HTMLInputElement;
    const chips = h("div", { class: "chips" });

    const fillPlayers = () => {
      const w = app().worlds.find((x) => x.id === app().world);
      const ids = new Set([...(w?.players.map((p) => p.id) ?? []), ...live.events.map((e) => e.player).filter((p): p is string => !!p)]);
      render(playerSel, h("option", { value: "" }, "All players"), ...[...ids].sort().map((id) => h("option", { value: id, selected: id === player }, label(id))));
    };
    const drawChips = () => {
      render(chips, ...namespaces.map((ns) =>
        h("button", { class: `chip ${on.has(ns) ? "on" : ""}`, onclick: () => { if (on.has(ns)) on.delete(ns); else on.add(ns); drawChips(); redraw(); } },
          h("i", { class: "dot", style: { background: NS_COLORS[ns] } }), ns)),
        h("button", { class: `chip ${showDirectives ? "on" : ""}`, onclick: () => { showDirectives = !showDirectives; drawChips(); redraw(); } }, h("i", { class: "dot", style: { background: "#ff7a2f" } }), "directives"),
        h("button", { class: `chip ${showInternal ? "on" : ""}`, onclick: () => { showInternal = !showInternal; drawChips(); redraw(); } }, h("i", { class: "dot", style: { background: NS_COLORS.lf } }), "internal lf.*"),
      );
    };
    const togglePause = () => {
      paused = !paused;
      if (!paused) {
        buffered = 0;
        redraw();
      }
      drawPause();
    };
    const drawPause = () => {
      render(pauseBtn, icon(paused ? "play" : "pause", 14), paused ? " Resume" : " Pause");
      pausedNote.textContent = paused && buffered ? `${buffered} new while paused` : "";
    };

    const matches = (r: Row): boolean => {
      if (r.kind === "directive") {
        if (!showDirectives) return false;
        if (player && r.d.player && r.d.player !== player) return false;
        return !text || `${r.d.kind} ${r.d.target} ${r.d.why}`.toLowerCase().includes(text);
      }
      const e = r.e;
      if (e.type === "lf.directive") return false; // shown as directive rows
      if (e.type.startsWith("lf.")) {
        if (!showInternal) return false;
      } else if (!on.has(nsOf(e.type))) return false;
      if (player && e.player !== player) return false;
      return !text || `${e.type} ${JSON.stringify(e.data)}`.toLowerCase().includes(text);
    };

    const rowEl = (r: Row): HTMLElement => {
      const detail = h("div", { class: "row-detail" });
      let open = false;
      const toggle = () => {
        open = !open;
        render(detail, open ? jsonView(r.kind === "event" ? r.e : r.d) : null);
      };
      if (r.kind === "directive") {
        const d = r.d;
        return h("div", { class: "srow srow-dir flash", onclick: toggle },
          h("div", { class: "srow-main" },
            h("span", { class: "ev-time" }, clock(d.ts)),
            pill(d.kind, "#ff7a2f"),
            h("span", { class: "ev-player" }, d.player ? label(d.player) : "world"),
            h("span", { class: "ev-sum" }, h("span", { class: "dir-target" }, d.target), " ", h("span", { class: "why-inline" }, d.why))),
          detail);
      }
      const e = r.e;
      const ns = e.type.startsWith("lf.") ? "lf" : nsOf(e.type);
      const summary = Object.entries(e.data).filter(([, v]) => typeof v !== "object" || v === null).map(([k, v]) => h("span", { class: "kv" }, h("i", null, k), String(v).slice(0, 40)));
      return h("div", { class: "srow flash", onclick: toggle },
        h("div", { class: "srow-main" },
          h("span", { class: "ev-time" }, clock(e.ts)),
          h("span", { class: "ev-type" }, h("i", { class: "dot", style: { background: NS_COLORS[ns] } }), e.type),
          h("span", { class: "ev-player" }, e.player ? label(e.player) : "world"),
          h("span", { class: "ev-sum" }, ...summary),
          h("span", { class: "ev-seq" }, `#${e.seq}`)),
        detail);
    };

    const allRows = (): Row[] => {
      const rows: Row[] = [...live.events.map((e) => ({ kind: "event" as const, e })), ...live.directives.map((d) => ({ kind: "directive" as const, d }))];
      return rows.sort((a, b) => (a.kind === "event" ? a.e.ts : a.d.ts) - (b.kind === "event" ? b.e.ts : b.d.ts));
    };
    const redraw = () => {
      const rows = allRows().filter(matches).slice(-300).reverse();
      render(list, rows.length ? rows.map(rowEl) : empty("No matching signals", "Signals appear here the moment a game (or Simulate) sends them."));
      list.querySelectorAll(".flash").forEach((el) => el.classList.remove("flash"));
    };
    const add = (r: Row) => {
      if (!matches(r)) return;
      if (paused) {
        buffered++;
        drawPause();
        return;
      }
      if (list.querySelector(".empty")) list.replaceChildren();
      list.prepend(rowEl(r));
      while (list.childElementCount > 300) list.lastElementChild?.remove();
    };

    render(root, card(null, { class: "toolbar-card" },
      h("div", { class: "toolbar" }, pauseBtn, playerSel, search, pausedNote),
      chips,
    ), card(null, { class: "stream-card" }, list));

    fillPlayers();
    drawChips();
    drawPause();
    redraw();
    const offs = [
      bus.on("event", (e) => add({ kind: "event", e: e as StoredEvent })),
      bus.on("directive", (d) => add({ kind: "directive", d: d as Directive })),
      bus.on("state", () => fillPlayers()),
    ];
    const t = setInterval(fillPlayers, 5000);
    return () => {
      offs.forEach((o) => o());
      clearInterval(t);
    };
  },
};
