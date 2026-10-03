// Gallery: everything the Forge made (Blueprint v1 models rendered live in Three.js, with their VFX), VFX recipes
// on their own, reactive quests and personal achievements.
import type { Achievement, Blueprint, ForgeGallery, GalleryEntry, Quest, QuestLog, Variant, VfxRecipe } from "@liveforge/protocol";
import { app } from "../app";
import { BlueprintViewer, thumbnail } from "../viz/three-view";
import { meter } from "../viz/charts";
import { vfxFor } from "../viz/samples";
import { SOURCE_COLORS, h, jsonView, label, render, timeAgo } from "../ui/dom";
import { card, empty, errorBox, pill, useLive, type PanelDef } from "./panel";

type Tab = "forge" | "vfx" | "quests" | "achievements";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pull renderable parts out of any forge result shape (ForgedItem, Creature, Prop, Variant, bare Blueprint ...). */
export function extract(result: unknown): { name: string; blueprint: Blueprint | null; vfx: VfxRecipe[]; variant: Variant | null; meta: Record<string, unknown> } {
  const r = isObj(result) ? result : {};
  const items = Array.isArray(r.items) ? r.items : Array.isArray(r.pieces) ? r.pieces : null;
  const first = items && isObj(items[0]) ? (items[0] as Record<string, unknown>) : r;
  const bp = isObj(first.blueprint) ? (first.blueprint as Blueprint) : first.v === 1 && Array.isArray(first.parts) ? (first as unknown as Blueprint) : null;
  const vfx: VfxRecipe[] = [];
  if (isObj(first.vfx)) vfx.push(first.vfx as VfxRecipe);
  if (first.v === 1 && Array.isArray(first.emitters)) vfx.push(first as unknown as VfxRecipe);
  const variant = isObj(first.variant) ? (first.variant as Variant) : typeof first.baseAsset === "string" ? (first as unknown as Variant) : null;
  return { name: String(first.name ?? bp?.name ?? "Untitled"), blueprint: bp, vfx, variant, meta: first };
}

export const galleryPanel: PanelDef = {
  id: "gallery",
  title: "Gallery",
  icon: "gallery",
  subtitle: "Forge output rendered live: blueprints, variants, VFX, quests and achievements.",
  mount(root) {
    let tab: Tab = "forge";
    let selected: string | null = null;
    let gallery: ForgeGallery = { entries: [] };
    let quests: { player: string; state: QuestLog }[] = [];
    let lastKey = "";
    const tabsEl = h("div", { class: "tabs" });
    const body = h("div");
    const viewerHost = h("div", { class: "viewer" });
    const info = h("div", { class: "viewer-info" });
    const viewer = new BlueprintViewer(viewerHost);
    render(root, tabsEl, body);

    const drawTabs = () => {
      const counts: Record<Tab, number> = {
        forge: gallery.entries.length,
        vfx: vfxList().length,
        quests: quests.reduce((a, q) => a + q.state.offered.length + q.state.active.length, 0),
        achievements: quests.reduce((a, q) => a + q.state.achievements.length, 0),
      };
      render(tabsEl, ...(["forge", "vfx", "quests", "achievements"] as Tab[]).map((t) =>
        h("button", { class: `tab ${tab === t ? "on" : ""}`, onclick: () => { tab = t; selected = null; lastKey = ""; draw(); } }, t === "forge" ? "Forge" : t === "vfx" ? "VFX" : t[0].toUpperCase() + t.slice(1), h("span", { class: "tab-count" }, String(counts[t])))));
    };

    const vfxList = (): { id: string; recipe: VfxRecipe; from: string }[] => {
      const out: { id: string; recipe: VfxRecipe; from: string }[] = [];
      for (const e of gallery.entries) {
        const x = extract(e.result);
        x.vfx.forEach((r, i) => out.push({ id: `${e.id}:${i}`, recipe: r, from: x.name }));
        x.blueprint?.vfx?.forEach((r, i) => out.push({ id: `${e.id}:bp${i}`, recipe: r, from: x.name }));
      }
      if (!out.length) for (const el of ["fire", "ice", "lightning", "veil"]) out.push({ id: `sample:${el}`, recipe: vfxFor(el), from: "built-in sample" });
      const seen = new Set<string>();
      return out.filter((o) => {
        const k = `${o.recipe.name}|${o.recipe.emitters[0]?.colorRamp[1]?.color ?? ""}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    const showEntry = (e: GalleryEntry) => {
      const x = extract(e.result);
      const key = `${e.id}:${tab}`;
      if (key !== lastKey) {
        viewer.show(x.blueprint, x.blueprint ? [] : x.vfx);
        lastKey = key;
      }
      const stats = isObj(x.meta.stats) ? (x.meta.stats as Record<string, number>) : {};
      const statMax = Math.max(100, ...Object.values(stats));
      const raw = h("div", { class: "raw hidden" }, jsonView(e.result));
      render(info,
        h("div", { class: "vi-head" }, h("h3", null, x.name), h("div", { class: "vi-pills" }, pill(e.askKind), pill(e.source, SOURCE_COLORS[e.source], { solid: true }), e.review !== "none" ? pill(`review: ${e.review}`, e.review === "approved" ? "#3fa34d" : e.review === "rejected" ? "#e66767" : "#c98500") : null)),
        typeof x.meta.flavor === "string" ? h("div", { class: "flavor" }, x.meta.flavor) : null,
        h("div", { class: "vi-tags" },
          ...[x.meta.rarity, x.meta.element, x.meta.family, x.meta.slot, x.meta.role].filter((v): v is string => typeof v === "string").map((v) => pill(v)),
          ...(Array.isArray(x.meta.tags) ? (x.meta.tags as string[]) : []).map((t) => pill(t, "#9085e9"))),
        Object.keys(stats).length ? h("div", { class: "vi-stats" }, ...Object.entries(stats).map(([k, v]) => h("div", { class: "stand-row" }, h("span", null, k), meter(v / statMax, "#ff7a2f", { height: 6 }), h("b", null, String(v))))) : null,
        x.blueprint ? h("div", { class: "small muted" }, `Blueprint v1 · ${x.blueprint.kind} · ${x.blueprint.parts.length} parts · ${x.blueprint.attachments.length} attachment points${x.blueprint.source ? ` · ${x.blueprint.source}` : ""}`) : null,
        x.variant ? h("div", { class: "small" }, pill("variant", "#199e70"), ` restyles asset "${x.variant.baseAsset}" · ${x.variant.materialSwaps.length} material swaps${x.variant.decals?.length ? ` · ${x.variant.decals.length} decals` : ""}`) : null,
        typeof x.meta.creativity === "number" ? h("div", { class: "small muted" }, `creativity ${(x.meta.creativity as number).toFixed(2)}`) : null,
        h("div", { class: "small muted" }, `${e.player ? `for ${label(e.player)} · ` : ""}${timeAgo(e.ts)}`),
        h("button", { class: "btn btn-ghost", onclick: () => raw.classList.toggle("hidden") }, "Toggle JSON"),
        raw);
    };

    const draw = () => {
      drawTabs();
      if (tab === "forge") {
        const entries = gallery.entries;
        if (!entries.length) {
          render(body, card(null, null, empty("Nothing forged yet", "forge.* asks land here: items, armour sets, creatures, props, looks and loot.")));
          return;
        }
        if (!selected || !entries.some((e) => e.id === selected)) selected = entries[0].id;
        const grid = h("div", { class: "thumbs" }, ...entries.map((e) => {
          const x = extract(e.result);
          const src = x.blueprint ? thumbnail(`${e.id}`, x.blueprint) : "";
          return h("button", { class: `thumb ${e.id === selected ? "on" : ""}`, onclick: () => { selected = e.id; draw(); } },
            src ? h("img", { src, alt: x.name }) : h("div", { class: "thumb-ph" }, x.variant ? "variant" : "vfx"),
            h("div", { class: "thumb-name" }, x.name),
            h("div", { class: "thumb-sub" }, h("i", { class: "dot", style: { background: SOURCE_COLORS[e.source] } }), e.askKind.replace("forge.", "")));
        }));
        render(body, h("div", { class: "grid g-2-3" }, card("Forged", { hint: `${entries.length} results · newest first` }, grid), card(null, { class: "viewer-card" }, viewerHost, info)));
        showEntry(entries.find((e) => e.id === selected)!);
      } else if (tab === "vfx") {
        const list = vfxList();
        if (!selected || !list.some((v) => v.id === selected)) selected = list[0]?.id ?? null;
        const cur = list.find((v) => v.id === selected);
        if (cur && lastKey !== `vfx:${cur.id}`) {
          viewer.show(null, [cur.recipe]);
          lastKey = `vfx:${cur.id}`;
        }
        render(body, h("div", { class: "grid g-2-3" },
          card("VFX recipes", { hint: "emitters · trails · auras · lights" }, h("div", { class: "side-list" }, ...list.map((v) =>
            h("button", { class: `side-item ${v.id === selected ? "on" : ""}`, onclick: () => { selected = v.id; draw(); } },
              h("div", { class: "side-title" }, v.recipe.name ?? "VFX"),
              h("div", { class: "ramp" }, ...(v.recipe.emitters[0]?.colorRamp ?? []).map((c) => h("span", { style: { background: c.color, opacity: String(Math.max(0.25, c.alpha ?? 1)) } }))),
              h("div", { class: "side-sub" }, `${v.recipe.emitters.length} emitter${v.recipe.emitters.length === 1 ? "" : "s"}${v.recipe.auras?.length ? ` · ${v.recipe.auras.length} aura` : ""}${v.recipe.lights?.length ? ` · ${v.recipe.lights.length} light` : ""} · from ${v.from}`))))),
          card(null, { class: "viewer-card" }, viewerHost, cur ? h("div", { class: "viewer-info" }, h("h3", null, cur.recipe.name ?? "VFX"), h("div", { class: "small muted" }, (cur.recipe.tags ?? []).join(" · ")), jsonView(cur.recipe)) : empty("No VFX"))));
      } else if (tab === "quests") {
        const all: { player: string; q: Quest; status: string }[] = [];
        for (const { player, state } of quests) {
          state.offered.forEach((q) => all.push({ player, q, status: "offered" }));
          state.active.forEach((a) => all.push({ player, q: a.quest, status: "active" }));
        }
        render(body, all.length ? h("div", { class: "quest-cards" }, ...all.map(({ player, q, status }) =>
          card(q.title, { hint: `${status} · ${label(player)}` },
            h("div", { class: "muted" }, q.summary),
            q.dialogue?.offer ? h("blockquote", { class: "profile small" }, `${q.giver ?? "giver"}: "${q.dialogue.offer}"`) : null,
            h("ul", { class: "objectives" }, ...q.objectives.map((o) => h("li", null, pill(o.type), ` ${o.description}`))),
            h("div", { class: "vi-tags" }, ...q.rewards.map((r) => pill(`${r.type}${r.amount ? ` ${r.amount}` : ""}${r.id ? ` ${r.id}` : ""}`, "#c98500"))),
            q.origin ? h("div", { class: "small muted" }, `origin: ${q.origin.kind}${q.origin.ref ? ` (${q.origin.ref})` : ""}`) : null))) : card(null, null, empty("No reactive quests yet", "Quests are generated from moments, rumours and world state.")));
      } else {
        const all: { player: string; a: Achievement }[] = quests.flatMap(({ player, state }) => state.achievements.map((a) => ({ player, a })));
        render(body, all.length ? h("div", { class: "ach-grid" }, ...all.map(({ player, a }) =>
          h("div", { class: `ach ach-${a.rarity}` },
            h("div", { class: "ach-icon", style: { background: a.icon.color ?? "#ff7a2f" } }, (a.icon.glyph ?? a.title).slice(0, 1).toUpperCase()),
            h("div", { class: "ach-body" },
              h("b", null, a.title), h("div", { class: "small" }, a.description),
              h("code", { class: "dsl" }, a.condition),
              h("div", { class: "small muted" }, `${a.rarity}${a.personal ? " · personal" : ""} · ${label(player)}${a.unlockedAt ? ` · ${timeAgo(a.unlockedAt)}` : ""}`))))) : card(null, null, empty("No achievements yet")));
      }
    };

    const stop = useLive(async () => {
      const s = app();
      try {
        const [g, q] = await Promise.all([s.source.projection("forge.gallery", s.world), s.source.projectionAll("quests.log", s.world)]);
        gallery = g ?? { entries: [] };
        quests = q;
      } catch (e) {
        render(body, errorBox(e));
        return;
      }
      draw();
    }, { interval: 6000, throttleMs: 2500, onEvent: false, onDirective: true });
    return () => {
      stop();
      viewer.dispose();
    };
  },
};
