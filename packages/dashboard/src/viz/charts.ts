// Small chart primitives: a canvas time-series (crosshair + tooltip), an SVG sparkline, a semicircle gauge and a
// horizontal meter. Thin 2px lines, recessive grid, text in ink colours (never the series colour).
import { h, svg, clock } from "../ui/dom";

export interface SeriesPoint {
  ts: number;
  value: number;
}

export interface TimeChartOptions {
  color: string;
  min?: number;
  max?: number;
  height?: number;
  /** Value formatter for the tooltip / axis. */
  fmt?: (v: number) => string;
  /** Horizontal reference lines (e.g. thresholds). */
  refs?: { value: number; label: string }[];
  /** Point markers (e.g. Director decisions) drawn as ticks on the baseline. */
  marks?: { ts: number; label: string; color: string }[];
  emptyText?: string;
}

/** A responsive canvas line+area chart. Call update() with new points; it redraws on resize. */
export class TimeChart {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private tip: HTMLElement;
  private points: SeriesPoint[] = [];
  private hoverX: number | null = null;
  private ro: ResizeObserver;

  constructor(private opts: TimeChartOptions) {
    this.canvas = h("canvas", { class: "tc-canvas" });
    this.tip = h("div", { class: "tc-tip" });
    this.el = h("div", { class: "tc", style: { height: `${opts.height ?? 180}px` } }, this.canvas, this.tip);
    this.canvas.addEventListener("mousemove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw();
    });
    this.canvas.addEventListener("mouseleave", () => {
      this.hoverX = null;
      this.draw();
    });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
  }

  update(points: SeriesPoint[], marks?: TimeChartOptions["marks"]): void {
    this.points = [...points].sort((a, b) => a.ts - b.ts);
    if (marks) this.opts.marks = marks;
    this.draw();
  }

  dispose(): void {
    this.ro.disconnect();
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.el.clientWidth;
    const hgt = this.el.clientHeight;
    if (!w || !hgt) return;
    this.canvas.width = w * dpr;
    this.canvas.height = hgt * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hgt}px`;
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue("--grid").trim() || "#232838";
    const muted = css.getPropertyValue("--muted").trim() || "#8a93a6";
    const pad = { l: 34, r: 10, t: 10, b: 20 };
    const iw = w - pad.l - pad.r;
    const ih = hgt - pad.t - pad.b;
    const min = this.opts.min ?? Math.min(0, ...this.points.map((p) => p.value));
    const max = this.opts.max ?? Math.max(1, ...this.points.map((p) => p.value));
    const fmt = this.opts.fmt ?? ((v: number) => v.toFixed(2));
    const y = (v: number) => pad.t + ih - ((v - min) / (max - min || 1)) * ih;
    // grid
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = muted;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = min + ((max - min) * i) / 4;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(w - pad.r, yy);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(fmt(v), pad.l - 6, yy + 4);
    }
    if (this.points.length < 2) {
      ctx.textAlign = "center";
      ctx.fillText(this.opts.emptyText ?? "Waiting for data…", pad.l + iw / 2, pad.t + ih / 2);
      this.tip.style.opacity = "0";
      return;
    }
    const t0 = this.points[0].ts;
    const t1 = this.points[this.points.length - 1].ts;
    const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * iw;
    // time labels
    ctx.textAlign = "left";
    ctx.fillText(clock(t0), pad.l, hgt - 5);
    ctx.textAlign = "right";
    ctx.fillText(clock(t1), w - pad.r, hgt - 5);
    // refs
    for (const r of this.opts.refs ?? []) {
      const yy = Math.round(y(r.value)) + 0.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = muted;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(w - pad.r, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = "right";
      ctx.fillText(r.label, w - pad.r - 2, yy - 4);
    }
    // area
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
    grad.addColorStop(0, `${this.opts.color}55`);
    grad.addColorStop(1, `${this.opts.color}00`);
    ctx.beginPath();
    ctx.moveTo(x(this.points[0].ts), y(min));
    for (const p of this.points) ctx.lineTo(x(p.ts), y(p.value));
    ctx.lineTo(x(t1), y(min));
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    // line
    ctx.beginPath();
    this.points.forEach((p, i) => (i ? ctx.lineTo(x(p.ts), y(p.value)) : ctx.moveTo(x(p.ts), y(p.value))));
    ctx.strokeStyle = this.opts.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
    // marks
    for (const m of this.opts.marks ?? []) {
      if (m.ts < t0 || m.ts > t1) continue;
      const xx = x(m.ts);
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.moveTo(xx, pad.t + ih - 1);
      ctx.lineTo(xx - 4, pad.t + ih + 6);
      ctx.lineTo(xx + 4, pad.t + ih + 6);
      ctx.closePath();
      ctx.fill();
    }
    // crosshair
    if (this.hoverX !== null && this.hoverX >= pad.l && this.hoverX <= w - pad.r) {
      const tt = t0 + ((this.hoverX - pad.l) / iw) * (t1 - t0);
      let best = this.points[0];
      for (const p of this.points) if (Math.abs(p.ts - tt) < Math.abs(best.ts - tt)) best = p;
      const bx = x(best.ts);
      const by = y(best.value);
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx + 0.5, pad.t);
      ctx.lineTo(bx + 0.5, pad.t + ih);
      ctx.stroke();
      ctx.fillStyle = this.opts.color;
      ctx.strokeStyle = css.getPropertyValue("--panel").trim() || "#12151c";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const near = (this.opts.marks ?? []).filter((m) => Math.abs(x(m.ts) - bx) < 8).map((m) => m.label);
      this.tip.replaceChildren(h("b", null, fmt(best.value)), h("span", null, ` · ${clock(best.ts)}`), ...near.slice(0, 2).map((n) => h("div", { class: "tc-tip-mark" }, n)));
      this.tip.style.opacity = "1";
      this.tip.style.left = `${Math.min(w - 180, Math.max(0, bx + 10))}px`;
      this.tip.style.top = `${Math.max(0, by - 36)}px`;
    } else {
      this.tip.style.opacity = "0";
    }
  }
}

/** Inline SVG sparkline (no axes). */
export function sparkline(values: number[], color: string, w = 120, hgt = 32, min?: number, max?: number): SVGSVGElement {
  const s = svg("svg", { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, class: "spark" });
  if (values.length < 2) return s;
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 4) + 2).toFixed(1)},${(hgt - 3 - ((v - lo) / (hi - lo || 1)) * (hgt - 6)).toFixed(1)}`);
  s.appendChild(svg("polyline", { points: pts.join(" "), fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  const last = pts[pts.length - 1].split(",");
  s.appendChild(svg("circle", { cx: last[0], cy: last[1], r: 3, fill: color }));
  return s;
}

/** Semicircle gauge 0..1 with optional clamp band. */
export function gauge(value: number, opts: { color: string; label: string; band?: [number, number]; size?: number }): HTMLElement {
  const size = opts.size ?? 160;
  const r = size / 2 - 12;
  const cx = size / 2;
  const cy = size / 2 + 4;
  const pt = (v: number) => {
    const a = Math.PI * (1 - v);
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  };
  const arc = (a: number, b: number) => {
    const [x0, y0] = pt(a);
    const [x1, y1] = pt(b);
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  const v = Math.max(0, Math.min(1, value));
  const s = svg("svg", { width: size, height: size / 2 + 16, viewBox: `0 0 ${size} ${size / 2 + 16}`, class: "gauge" });
  s.appendChild(svg("path", { d: arc(0, 1), stroke: "var(--grid)", "stroke-width": 10, fill: "none", "stroke-linecap": "round" }));
  if (opts.band) s.appendChild(svg("path", { d: arc(opts.band[0], opts.band[1]), stroke: "var(--line-strong)", "stroke-width": 10, fill: "none" }));
  if (v > 0.001) s.appendChild(svg("path", { d: arc(0, v), stroke: opts.color, "stroke-width": 10, fill: "none", "stroke-linecap": "round" }));
  const [nx, ny] = pt(v);
  s.appendChild(svg("circle", { cx: nx, cy: ny, r: 7, fill: opts.color, stroke: "var(--panel)", "stroke-width": 3 }));
  return h("div", { class: "gauge-wrap" }, s, h("div", { class: "gauge-val" }, v.toFixed(2)), h("div", { class: "gauge-label" }, opts.label));
}

/** Horizontal meter bar. `value` 0..1. */
export function meter(value: number, color: string, opts: { title?: string; height?: number } = {}): HTMLElement {
  const v = Math.max(0, Math.min(1, value));
  return h(
    "div",
    { class: "meter", title: opts.title ?? "", style: { height: `${opts.height ?? 8}px` } },
    h("div", { class: "meter-fill", style: { width: `${(v * 100).toFixed(1)}%`, background: color } }),
  );
}
