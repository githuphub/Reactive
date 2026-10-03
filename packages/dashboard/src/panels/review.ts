// Review / bake queue: approve or reject pre-generated forge output, then export a bake pack (BakePack JSON) that
// SDKs load for offline / console play.
import type { ReviewItem } from "@liveforge/protocol";
import { app } from "../app";
import { thumbnail } from "../viz/three-view";
import { downloadJson, h, icon, jsonView, render, timeAgo, toast } from "../ui/dom";
import { card, empty, errorBox, pill, useLive, type PanelDef } from "./panel";
import { extract } from "./gallery";

type Filter = ReviewItem["status"] | "all";
const STATUS_COLORS: Record<ReviewItem["status"], string> = { pending: "#c98500", approved: "#3fa34d", rejected: "#e66767" };

export const reviewPanel: PanelDef = {
  id: "review",
  title: "Review & bake",
  icon: "review",
  subtitle: "Approve generated content, then export a pack SDKs can load offline.",
  mount(root) {
    let filter: Filter = "pending";
    let items: ReviewItem[] = [];
    const summary = h("div", { class: "review-summary" });
    const filters = h("div", { class: "chips" });
    const list = h("div", { class: "review-list" });
    const busy = new Set<string>();

    const set = async (ids: string[], status: ReviewItem["status"]) => {
      ids.forEach((id) => busy.add(id));
      draw();
      let ok = 0;
      for (const id of ids) {
        try {
          const it = await app().source.reviewSet(id, status);
          const i = items.findIndex((x) => x.id === id);
          if (i >= 0) items[i] = { ...items[i], ...it, status };
          ok++;
        } catch (e) {
          toast(`${id}: ${(e as Error).message}`, "err");
        } finally {
          busy.delete(id);
        }
      }
      if (ok) toast(`${ok} item${ok === 1 ? "" : "s"} ${status}`, "ok");
      draw();
    };

    const exportPack = async () => {
      try {
        const pack = await app().source.bakeExport();
        const n = Object.values(pack.entries).reduce((a, l) => a + l.length, 0);
        if (!n) {
          toast("Nothing approved yet - approve items first", "info");
          return;
        }
        downloadJson(`${pack.game}-bake-${new Date(pack.createdAt).toISOString().slice(0, 10)}.json`, pack);
        toast(`Exported bake pack with ${n} entries`, "ok");
      } catch (e) {
        toast(`Export failed: ${(e as Error).message}`, "err");
      }
    };

    const draw = () => {
      const counts = { pending: 0, approved: 0, rejected: 0 } as Record<ReviewItem["status"], number>;
      for (const it of items) counts[it.status]++;
      render(summary,
        ...(["pending", "approved", "rejected"] as const).map((s) => h("div", { class: "kpi kpi-sm" }, h("div", { class: "kpi-k" }, s), h("div", { class: "kpi-v", style: { color: "var(--text)" } }, h("i", { class: "dot", style: { background: STATUS_COLORS[s] } }), String(counts[s])))),
        h("div", { class: "review-actions" },
          h("button", { class: "btn", disabled: !counts.pending, onclick: () => set(items.filter((i) => i.status === "pending").map((i) => i.id), "approved") }, icon("check", 14), " Approve all pending"),
          h("button", { class: "btn btn-primary", onclick: exportPack }, icon("download", 14), ` Export bake pack (${counts.approved})`)));
      render(filters, ...(["pending", "approved", "rejected", "all"] as Filter[]).map((f) => h("button", { class: `chip ${filter === f ? "on" : ""}`, onclick: () => { filter = f; draw(); } }, f)));
      const shown = items.filter((i) => filter === "all" || i.status === filter).sort((a, b) => b.createdAt - a.createdAt);
      render(list, shown.length ? shown.map((it) => {
        const x = extract(it.payload);
        const src = x.blueprint ? thumbnail(`rv:${it.id}`, x.blueprint, 120) : "";
        const raw = h("div", { class: "raw hidden" }, jsonView(it.payload));
        const isBusy = busy.has(it.id);
        return h("div", { class: `review-item ${it.status}` },
          h("div", { class: "review-thumb" }, src ? h("img", { src, alt: x.name }) : h("div", { class: "thumb-ph" }, it.kind.split(".").pop() ?? "item")),
          h("div", { class: "review-body" },
            h("div", { class: "review-top" }, h("b", null, x.name), pill(it.kind), pill(it.status, STATUS_COLORS[it.status])),
            typeof x.meta.flavor === "string" ? h("div", { class: "muted small" }, x.meta.flavor) : null,
            h("div", { class: "small muted" }, `${it.id} · created ${timeAgo(it.createdAt)}${it.note ? ` · note: ${it.note}` : ""}`),
            h("button", { class: "btn btn-ghost btn-sm", onclick: () => raw.classList.toggle("hidden") }, "JSON"),
            raw),
          h("div", { class: "review-btns" },
            h("button", { class: "btn btn-ok", disabled: isBusy || it.status === "approved", onclick: () => set([it.id], "approved") }, icon("check", 14), " Approve"),
            h("button", { class: "btn btn-bad", disabled: isBusy || it.status === "rejected", onclick: () => set([it.id], "rejected") }, icon("x", 14), " Reject")));
      }) : empty(filter === "pending" ? "Queue is clear" : `No ${filter} items`, "Bake mode pre-generates catalogues (items, looks, barks) into this queue."));
    };

    render(root, card(null, null, summary), card("Queue", { actions: [filters] }, list));
    const stop = useLive(async () => {
      try {
        items = await app().source.reviewList();
      } catch (e) {
        render(list, errorBox(e));
        return;
      }
      draw();
    }, { interval: 6000, throttleMs: 3000, onEvent: false });
    return stop;
  },
};
