// Tiny DOM helpers: h() element builder, formatting, colour roles and inline icons. No framework.

type Child = Node | string | number | null | undefined | false | Child[];
type Props = {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  [k: string]: unknown;
};

/** h("div", {class: "x", onclick: fn}, "text", child) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (v === false) {
        if (k in el && !k.startsWith("on")) (el as unknown as Record<string, unknown>)[k] = false;
        continue;
      }
      if (k === "class") el.className = String(v);
      else if (k === "style") {
        if (typeof v === "string") el.setAttribute("style", v);
        else Object.assign(el.style, v);
      } else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replace the children of el. */
export function render(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: (SVGElement | null)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

// ---------------------------------------------------------------- formatting

export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h_ = Math.round(m / 60);
  if (h_ < 48) return `${h_}h ago`;
  return `${Math.round(h_ / 24)}d ago`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-GB");
  return String(Math.round(n * 100) / 100);
}

export function fmtUsd(n: number): string {
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtMs(n: number): string {
  if (!n) return "-";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

export const label = (s: string): string => s.replace(/^sim_/, "").replace(/[_-]/g, " ");

// ---------------------------------------------------------------- colour roles
// Fixed categorical order (validated dark-surface steps); each namespace always keeps its colour.

export const NS_COLORS: Record<string, string> = {
  movement: "#3987e5",
  combat: "#d95926",
  gear: "#199e70",
  economy: "#c98500",
  social: "#d55181",
  quest: "#3fa34d",
  world: "#9085e9",
  custom: "#e66767",
  lf: "#6b7385",
};

export function nsOf(type: string): string {
  const ns = type.split(".")[0];
  return ns in NS_COLORS ? ns : "custom";
}

export const SOURCE_COLORS: Record<string, string> = { rules: "#8a93a6", cache: "#3987e5", ai: "#ff7a2f", bake: "#199e70" };

/** -1..1 -> diverging colour (red / grey / blue). */
export function diverging(v: number): string {
  const t = Math.max(-1, Math.min(1, v));
  const mix = (a: number[], b: number[], k: number) => a.map((x, i) => Math.round(x + (b[i] - x) * k));
  const mid = [56, 56, 53];
  const pos = [57, 135, 229];
  const neg = [230, 103, 103];
  const c = t >= 0 ? mix(mid, pos, t) : mix(mid, neg, -t);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ---------------------------------------------------------------- icons (24px stroke icons)

const ICONS: Record<string, string> = {
  overview: "M3 12h4l3-8 4 16 3-8h4",
  stream: "M4 6h16M4 12h10M4 18h13",
  players: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 19v-1a4 4 0 0 0-3-3.8M16 3.2a3.5 3.5 0 0 1 0 6.6",
  npcs: "M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21c0-4 3.6-7 8-7s8 3 8 7M16.5 7.5h4M18.5 5.5v4",
  rumours: "M5 12a2 2 0 1 0 0-.01M12 5a2 2 0 1 0 0-.01M19 12a2 2 0 1 0 0-.01M12 19a2 2 0 1 0 0-.01M6.5 10.5l4-4M13.5 6.5l4 4M17.5 13.5l-4 4M6.5 13.5l4 4",
  factions: "M4 21V5l8-3 8 3v16M4 10h16M9 21v-6h6v6",
  director: "M3 17l5-6 4 4 8-10M14 5h6v6",
  gallery: "M12 2l9 5v10l-9 5-9-5V7l9-5zM12 12l9-5M12 12v10M12 12L3 7",
  review: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9",
  meters: "M12 13l4-4M3.5 17a9 9 0 1 1 17 0",
  manifest: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6zM14 3v6h6M8 13h8M8 17h5",
  simulate: "M6 4l14 8-14 8V4z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  pause: "M8 5v14M16 5v14",
  play: "M7 4l13 8-13 8V4z",
  check: "M5 12l5 5 9-11",
  x: "M6 6l12 12M18 6L6 18",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  upload: "M12 21V9M7 14l5-5 5 5M4 3h16",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
};

export function icon(name: string, size = 18): SVGSVGElement {
  const s = svg("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", class: "icon" });
  s.appendChild(svg("path", { d: ICONS[name] ?? ICONS.spark }));
  return s;
}

/** Download a JSON value as a file. */
export function downloadJson(name: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

/** Pretty JSON with light syntax colouring. */
export function jsonView(value: unknown): HTMLElement {
  const text = JSON.stringify(value, null, 2) ?? "null";
  const pre = h("pre", { class: "json" });
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) pre.appendChild(document.createTextNode(text.slice(last, m.index)));
    const cls = m[1] ? (m[2] ? "k" : "s") : m[3] ? "b" : "n";
    pre.appendChild(h("span", { class: `j-${cls}` }, m[1] ?? m[0]));
    if (m[2]) pre.appendChild(document.createTextNode(m[2]));
    last = re.lastIndex;
  }
  pre.appendChild(document.createTextNode(text.slice(last)));
  return pre;
}

export function toast(msg: string, kind: "ok" | "err" | "info" = "info"): void {
  let host = document.getElementById("toasts");
  if (!host) {
    host = h("div", { id: "toasts" });
    document.body.appendChild(host);
  }
  const t = h("div", { class: `toast toast-${kind}` }, msg);
  host.appendChild(t);
  setTimeout(() => t.classList.add("out"), 3200);
  setTimeout(() => t.remove(), 3700);
}
