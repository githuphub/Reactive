// Brain: one live feed of everything the kit is thinking - agent goals, thoughts and tool calls, builder plans,
// village-mind decisions and raid plans, Director decisions - each with its model badge (Sonnet / Haiku / rules /
// cache / replay) and latency. Filter by source; click a row for its data.
import { app, bus, live, pushBrain, throttle } from "../app";
import { BRAIN_SOURCES, type BrainEntry } from "../api/brain";
import { clock, h, jsonView, render, timeAgo } from "../ui/dom";
import { card, empty, type PanelDef } from "./panel";
import { modelPill, sourcePill } from "./k7-ui";

const KIND_LABEL: Record<string, string> = {
  goal: "GOAL", thought: "THINK", tool_call: "TOOL", tool_result: "RESULT", plan: "PLAN", decision: "DECIDE", line: "SAY",
};

export const brainPanel: PanelDef = {
  id: "brain",
  title: "Brain",
  icon: "bolt",
  subtitle: "Live reasoning: agent steps, builder plans, village-mind decisions and raid plans, with model and latency.",
  mount(root) {
    const off = new Set<string>();
    let query = "";
    let paused = false;
    let open: string | null = null;
    const chips = h("div", { class: "chips" });
    const search = h("input", { class: "input input-sm", placeholder: "filter text / actor", oninput: () => { query = search.value.trim().toLowerCase(); draw(); } }) as HTMLInputElement;
    const pauseBtn = h("button", { class: "btn btn-sm", onclick: () => { paused = !paused; pauseBtn.textContent = paused ? "Resume" : "Pause"; if (!paused) draw(); } }, "Pause");
    const counts = h("span", { class: "muted small" });
    const feed = h("div", { class: "brain-feed" });
    render(root,
      card(null, null, h("div", { class: "toolbar" }, chips, h("div", { style: { marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" } }, counts, search, pauseBtn))),
      card("Live feed", { hint: "newest first · click a row for its data" }, feed));

    const drawChips = () => render(chips, ...BRAIN_SOURCES.map((s) => h("button", {
      class: `chip ${off.has(s) ? "" : "on"}`,
      onclick: () => { if (off.has(s)) off.delete(s); else off.add(s); drawChips(); draw(); },
    }, sourcePill(s))));

    const row = (b: BrainEntry) => {
      const isOpen = open === b.id;
      return h("div", { class: `brain-row brain-${b.kind}${isOpen ? " open" : ""}`, onclick: () => { open = isOpen ? null : b.id; draw(); } },
        h("div", { class: "brain-top" },
          h("span", { class: "ev-time", title: timeAgo(b.ts) }, clock(b.ts)),
          sourcePill(String(b.source)),
          h("b", { class: "brain-actor" }, b.actor),
          h("span", { class: "brain-kind" }, KIND_LABEL[b.kind] ?? b.kind.toUpperCase()),
          h("span", { style: { marginLeft: "auto" } }, modelPill(b.model ?? "rules", b.ms))),
        h("div", { class: "brain-text" }, b.text),
        isOpen && b.data ? jsonView(b.data) : null);
    };

    function draw() {
      if (paused) return;
      const list = live.brain
        .filter((b) => !off.has(String(b.source)))
        .filter((b) => !query || b.text.toLowerCase().includes(query) || b.actor.toLowerCase().includes(query))
        .slice(-200)
        .reverse();
      render(counts, `${list.length} shown · ${live.brain.length} total`);
      render(feed, list.length ? list.map(row) : empty("Nothing in the Brain yet", "Agent steps, builder plans, faction decisions and raid plans appear here as they happen."));
    }

    drawChips();
    draw();
    const s = app();
    s.source.brainHistory?.(s.world).then((list) => { for (const b of list) pushBrain(b); draw(); }).catch(() => {});
    const offBrain = bus.on("brain", throttle(() => draw(), 250));
    const offState = bus.on("state", () => draw());
    return () => {
      offBrain();
      offState();
    };
  },
};
