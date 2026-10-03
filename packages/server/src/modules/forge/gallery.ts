// Projection "forge.gallery" (world scope): every forged result (instant, upgrade, bake) with its review status,
// folded from lf.forge.created / lf.forge.review / lf.forge.job. Deterministic (event data + event.ts only).
import type { ForgeGallery, GalleryEntry, StoredEvent } from "@liveforge/protocol";
import type { Projection } from "../../module.js";
import { isObj } from "./model.js";

/** Entries kept per world (oldest reviewed / unreviewed entries are dropped first; pending ones last). */
export const GALLERY_MAX = 500;

/** Gallery entry plus the request key (prompt) used for bake-pack lookups. */
export type ForgeGalleryEntry = GalleryEntry & { key?: string };

const REVIEW = ["none", "pending", "approved", "rejected"] as const;
const SOURCES = ["rules", "cache", "ai", "bake"] as const;

/** Update every `mesh` object with this job id inside a result (item, items[], pieces[], creature, prop). */
function patchMesh(v: unknown, jobId: string, state: string, url: unknown, depth = 0): boolean {
  if (depth > 4 || v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.map((x) => patchMesh(x, jobId, state, url, depth + 1)).some(Boolean);
  const o = v as Record<string, unknown>;
  let hit = false;
  if (isObj(o.mesh) && o.mesh.jobId === jobId) {
    o.mesh.state = state;
    if (typeof url === "string") o.mesh.url = url;
    hit = true;
  }
  for (const k of ["item", "items", "pieces", "creature", "prop"]) if (k in o) hit = patchMesh(o[k], jobId, state, url, depth + 1) || hit;
  return hit;
}

function trim(entries: ForgeGalleryEntry[]): void {
  while (entries.length > GALLERY_MAX) {
    const i = entries.findIndex((e) => e.review !== "pending");
    entries.splice(i < 0 ? 0 : i, 1);
  }
}

export const galleryProjection: Projection<ForgeGallery> = {
  name: "forge.gallery",
  scope: "world",
  version: 1,
  types: ["lf.forge.created", "lf.forge.review", "lf.forge.job"],
  init: () => ({ entries: [] }),
  apply(state, ev: StoredEvent) {
    const d = ev.data;
    const entries = state.entries as ForgeGalleryEntry[];
    if (ev.type === "lf.forge.created") {
      const id = typeof d.askId === "string" ? d.askId : `ev${ev.seq}`;
      const source = (SOURCES as readonly string[]).includes(String(d.source)) ? (d.source as GalleryEntry["source"]) : "rules";
      const existing = entries.find((e) => e.id === id);
      const review = (REVIEW as readonly string[]).includes(String(d.review)) ? (d.review as GalleryEntry["review"]) : undefined;
      if (existing) {
        existing.result = structuredClone(d.result);
        existing.source = source;
        existing.ts = ev.ts;
        if (review) existing.review = review;
        if (typeof d.key === "string") existing.key = d.key;
      } else {
        entries.push({
          id, askKind: String(d.askKind ?? "forge.item"), ts: ev.ts, player: ev.player, source, result: structuredClone(d.result),
          review: review ?? "none", ...(typeof d.key === "string" ? { key: d.key } : {}),
        });
        trim(entries);
      }
    } else if (ev.type === "lf.forge.review") {
      const e = entries.find((x) => x.id === d.id);
      const status = (REVIEW as readonly string[]).includes(String(d.status)) ? (d.status as GalleryEntry["review"]) : null;
      if (e && status) e.review = status;
    } else if (ev.type === "lf.forge.job" && typeof d.jobId === "string") {
      let hit = false;
      for (const e of entries) if ((hit = patchMesh(e.result, d.jobId, String(d.state ?? "queued"), d.url))) break;
      // the instant answer may have been sent before the job id was known: attach by askId
      const owner = !hit && typeof d.askId === "string" ? entries.find((e) => e.id === d.askId) : undefined;
      if (owner && isObj(owner.result)) {
        const r = owner.result;
        const holder = [r.item, r.creature, r.prop].find(isObj);
        if (holder) holder.mesh = { jobId: d.jobId, state: String(d.state ?? "queued"), ...(typeof d.url === "string" ? { url: d.url } : {}) };
      }
    }
    return state;
  },
};
