// Small shared bits for the K7 panels (Agents, Builds, Brain, village mind): model badges, posture colours.
import { BRAIN_SOURCE_COLORS, MODEL_COLORS } from "../api/brain";
import { fmtMs, h } from "../ui/dom";
import { pill } from "./panel";

/** "sonnet 1.2s" / "haiku" / "rules" / "replay" badge. Accepts a model id or a badge name. */
export function modelPill(model: string | undefined | null, ms?: number): HTMLElement {
  const m = !model ? "rules" : model.startsWith("replay:") ? "replay" : /haiku/i.test(model) ? "haiku" : /sonnet|opus|claude/i.test(model) ? "sonnet" : model;
  return pill(`${m}${typeof ms === "number" && ms > 0 ? ` · ${fmtMs(ms)}` : ""}`, MODEL_COLORS[m] ?? "#8a93a6", { title: model ?? "rules" });
}

export function sourcePill(source: string): HTMLElement {
  return pill(source, BRAIN_SOURCE_COLORS[source] ?? "#8a93a6");
}

export const POSTURE_COLORS: Record<string, string> = { calm: "#3fa34d", wary: "#c98500", hostile: "#e66767", festive: "#9085e9" };

export function posturePill(posture: string): HTMLElement {
  return pill(posture, POSTURE_COLORS[posture] ?? "#8a93a6", { solid: true });
}

/** Compact one-line JSON (for tool inputs / outputs). */
export function compact(v: unknown, max = 160): string {
  if (v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > max ? `${s.slice(0, max - 1)}…` : s ?? "";
}

/** A labelled value chip. */
export function kv(k: string, v: string | number): HTMLElement {
  return h("span", { class: "stat-chip" }, h("span", { class: "muted" }, `${k} `), String(v));
}
