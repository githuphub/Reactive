// Panel plumbing: definition type, card / empty / error helpers and a live-refresh hook.
import { bus, throttle } from "../app";
import { h, icon } from "../ui/dom";

export interface PanelDef {
  id: string;
  title: string;
  icon: string;
  /** One-line description under the title. */
  subtitle: string;
  /** Mount into root; return a dispose function. */
  mount(root: HTMLElement): () => void;
}

export function card(
  title: string | null,
  opts: { class?: string; actions?: (Node | string)[]; hint?: string } | null,
  ...children: (Node | string | null | false | undefined)[]
): HTMLElement {
  return h(
    "section",
    { class: `card ${opts?.class ?? ""}` },
    title ? h("header", { class: "card-head" }, h("h3", null, title), opts?.hint ? h("span", { class: "card-hint" }, opts.hint) : null, h("div", { class: "card-actions" }, ...(opts?.actions ?? []))) : null,
    h("div", { class: "card-body" }, ...children),
  );
}

export function empty(text: string, hint?: string): HTMLElement {
  return h("div", { class: "empty" }, icon("spark", 22), h("div", null, text), hint ? h("div", { class: "empty-hint" }, hint) : null);
}

export function errorBox(e: unknown): HTMLElement {
  const msg = e instanceof Error ? e.message : String(e);
  return h("div", { class: "error-box" }, h("b", null, "Could not load"), h("div", null, msg));
}

export function pill(text: string, color?: string, opts: { title?: string; solid?: boolean } = {}): HTMLElement {
  const style = color ? (opts.solid ? { background: color, color: "#0b0d12" } : { borderColor: `${color}88`, color: "var(--text)" }) : undefined;
  return h("span", { class: `pill${opts.solid ? " pill-solid" : ""}`, style, title: opts.title }, color && !opts.solid ? h("i", { class: "dot", style: { background: color } }) : null, text);
}

/**
 * Run `load` now, again (throttled) whenever live events / directives arrive or app state changes, and on an
 * interval as a fallback. Errors are passed to `onError` (default: console).
 */
export function useLive(
  load: () => Promise<void> | void,
  opts: { interval?: number; throttleMs?: number; onEvent?: boolean; onDirective?: boolean; onError?: (e: unknown) => void } = {},
): LiveHandle {
  let disposed = false;
  let running = false;
  let again = false;
  const run = async () => {
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await load();
    } catch (e) {
      (opts.onError ?? ((x) => console.warn("[dashboard]", x)))(e);
    } finally {
      running = false;
      if (again && !disposed) {
        again = false;
        void run();
      }
    }
  };
  const t = throttle(() => void run(), opts.throttleMs ?? 900);
  const offs = [bus.on("state", () => void run())];
  if (opts.onEvent !== false) offs.push(bus.on("event", t));
  if (opts.onDirective) offs.push(bus.on("directive", t));
  const timer = setInterval(() => void run(), opts.interval ?? 5000);
  void run();
  const stop = () => {
    disposed = true;
    clearInterval(timer);
    for (const o of offs) o();
  };
  return Object.assign(stop, { refresh: () => void run() });
}

/** Dispose function returned by useLive, with an immediate refresh(). */
export type LiveHandle = (() => void) & { refresh(): void };

/** Keyed list that keeps a selected id across refreshes. */
export function selectable<T>(items: T[], key: (t: T) => string, current: string | null): string | null {
  if (current && items.some((i) => key(i) === current)) return current;
  return items.length ? key(items[0]) : null;
}
