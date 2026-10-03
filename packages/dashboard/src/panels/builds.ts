// Builds: builder.plan results (K6 lf.builder.planned). An isometric preview of the expanded blocks (with a build
// order slider), the Voxel DSL listing and the materials bill.
import { app, bus, live, throttle } from "../app";
import type { BuildEntry } from "../api/brain";
import { clampVoxelPlan, expandVoxelPlan, type VoxelBlock } from "@liveforge/protocol";
import { blockColor, drawIso } from "../viz/iso";
import { clock, h, jsonView, render, timeAgo } from "../ui/dom";
import { card, empty, errorBox, pill, useLive, type PanelDef } from "./panel";
import { modelPill } from "./k7-ui";

const SOURCE_COLOR: Record<string, string> = { rules: "#8a93a6", cache: "#3987e5", ai: "#ff7a2f", replay: "#c98500" };

/** Builds rebuilt from Brain entries (source "builder" with a plan in data) when the event query is unavailable. */
function buildsFromBrain(): BuildEntry[] {
  const out: BuildEntry[] = [];
  for (const b of live.brain) {
    const d = (b.data ?? {}) as Record<string, unknown>;
    const plan = d.plan as BuildEntry["plan"] | undefined;
    if (b.source !== "builder" || !plan || !Array.isArray(plan.ops)) continue;
    out.push({ id: b.id, ts: b.ts, player: null, npc: (d.npc as string) ?? b.actor, prompt: String(d.prompt ?? ""), summary: String(d.summary ?? b.text), source: String(d.source ?? b.model ?? "rules"), model: b.model, plan, ...(d.materials ? { materials: d.materials as Record<string, number> } : {}) });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export const buildsPanel: PanelDef = {
  id: "builds",
  title: "Builds",
  icon: "gallery",
  subtitle: "builder.plan results: isometric preview, Voxel DSL and materials.",
  mount(root) {
    const listEl = h("div", { class: "side-list" });
    const detail = h("div", { class: "detail" });
    render(root, h("div", { class: "split" }, card("Plans", { class: "side" }, listEl), detail));
    let builds: BuildEntry[] = [];
    let selected: string | null = null;
    let shownId: string | null = null;
    const canvas = h("canvas", { class: "iso-canvas" }) as HTMLCanvasElement;
    const slider = h("input", { type: "range", min: "0", max: "0", value: "0", class: "iso-slider" }) as HTMLInputElement;
    const sliderLabel = h("span", { class: "muted small" });
    let blocks: VoxelBlock[] = [];
    const paint = () => {
      const n = Number(slider.value);
      drawIso(canvas, blocks, { upto: n });
      sliderLabel.textContent = `${n} / ${blocks.length} blocks (build order)`;
    };
    slider.addEventListener("input", paint);
    const ro = new ResizeObserver(() => paint());
    ro.observe(canvas);

    const draw = () => {
      if (!builds.length) {
        render(listEl, empty("No plans yet", "Plans appear when an agent builds or the game asks builder.plan."));
        render(detail, card("Preview", null, empty("Nothing to preview", "Try \"build me a cosy house with a tower\" at Bram's plot.")));
        shownId = null;
        return;
      }
      if (!selected || !builds.some((b) => b.id === selected)) selected = builds[0].id;
      render(listEl, ...builds.map((b) => h("button", { class: `side-item ${b.id === selected ? "on" : ""}`, onclick: () => { selected = b.id; draw(); } },
        h("div", { class: "side-title" }, b.plan.name ?? (b.prompt || "plan")),
        h("div", { class: "side-sub" }, `${b.npc ?? "game"} · ${timeAgo(b.ts)}`),
        h("div", { class: "side-tag" }, b.source))));
      const b = builds.find((x) => x.id === selected)!;
      if (shownId === b.id) return; // keep the slider where the user left it
      shownId = b.id;
      const ex = expandVoxelPlan(clampVoxelPlan(b.plan));
      blocks = ex.blocks;
      const materials = b.materials && Object.keys(b.materials).length ? b.materials : ex.materials;
      slider.max = String(blocks.length);
      slider.value = String(blocks.length);
      const size = ex.blocks.length ? ex.bounds.max.map((v, i) => v - ex.bounds.min[i] + 1).join(" x ") : "0";
      render(detail,
        card(b.plan.name ?? "Build plan", {
          hint: `${b.npc ? `${b.npc} · ` : ""}${clock(b.ts)} · ${size} · ${ex.blocks.length} blocks`,
          actions: [pill(b.source, SOURCE_COLOR[b.source] ?? "#8a93a6"), modelPill(b.model ?? (b.source === "ai" ? "sonnet" : b.source))],
        },
          b.prompt ? h("div", { class: "dir-why" }, h("span", { class: "why-tag" }, "prompt"), `"${b.prompt}"`) : null,
          b.summary ? h("div", { class: "dir-why" }, h("span", { class: "why-tag" }, "summary"), b.summary) : null,
          h("div", { class: "iso-wrap" }, canvas),
          h("div", { class: "toolbar" }, slider, sliderLabel),
          ex.warnings.length ? h("div", { class: "muted small" }, `warnings: ${ex.warnings.join("; ")}`) : null),
        h("div", { class: "grid g-3-2" },
          card("Voxel DSL", { hint: `${b.plan.ops.length} ops` }, jsonView(b.plan)),
          card("Materials", { hint: "blocks to gather" }, h("div", { class: "materials" },
            ...Object.entries(materials).sort((x, y) => y[1] - x[1]).map(([k, v]) =>
              h("div", { class: "material" }, h("i", { class: "swatch", style: { background: blockColor(k) } }), h("span", null, k), h("b", null, String(v))))))));
      requestAnimationFrame(paint);
    };

    const stop = useLive(async () => {
      const s = app();
      try {
        const fromServer = s.source.builds ? await s.source.builds(s.world, 30) : [];
        builds = fromServer.length ? fromServer : buildsFromBrain();
      } catch (e) {
        builds = buildsFromBrain();
        if (!builds.length) {
          render(detail, errorBox(e));
          return;
        }
      }
      draw();
    }, { interval: 5000, throttleMs: 1200 });
    const offBrain = bus.on("brain", throttle(() => stop.refresh(), 1000));
    return () => {
      stop();
      offBrain();
      ro.disconnect();
    };
  },
};
