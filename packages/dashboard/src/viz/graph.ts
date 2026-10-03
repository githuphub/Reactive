// A small force-directed graph on canvas (rumour spread, NPC relationships). Positions persist across setData()
// so new edges animate in without the layout jumping. Recent edges carry travelling "pulses".
import { h } from "../ui/dom";

export interface GraphNode {
  id: string;
  label: string;
  color: string;
  /** Radius in px. */
  size?: number;
  /** Secondary text under the label. */
  sub?: string;
  /** Ring colour (e.g. faction). */
  ring?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  color: string;
  width?: number;
  dashed?: boolean;
  /** Draw an arrowhead at `to`. */
  arrow?: boolean;
  label?: string;
  /** Timestamp: edges newer than ~6 s get an animated pulse. */
  ts?: number;
}

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}

export class ForceGraph {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private tip: HTMLElement;
  private nodes = new Map<string, SimNode>();
  private edges: GraphEdge[] = [];
  private raf = 0;
  private alpha = 1;
  private hover: SimNode | null = null;
  private drag: SimNode | null = null;
  private ro: ResizeObserver;
  private w = 600;
  private hgt = 400;
  onSelect?: (id: string | null) => void;
  selected: string | null = null;

  constructor(height = 420) {
    this.canvas = h("canvas", { class: "fg-canvas" });
    this.tip = h("div", { class: "tc-tip" });
    this.el = h("div", { class: "fg", style: { height: `${height}px` } }, this.canvas, this.tip);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.canvas.addEventListener("mousemove", (e) => this.onMove(e));
    this.canvas.addEventListener("mousedown", (e) => {
      const n = this.pick(e);
      if (n) {
        this.drag = n;
        n.fixed = true;
      }
    });
    window.addEventListener("mouseup", this.onUp);
    this.canvas.addEventListener("click", (e) => {
      const n = this.pick(e);
      this.selected = n && this.selected !== n.id ? n.id : null;
      this.onSelect?.(this.selected);
      this.kick(0.2);
    });
    this.canvas.addEventListener("mouseleave", () => {
      this.hover = null;
      this.tip.style.opacity = "0";
    });
    this.loop();
  }

  private onUp = () => {
    if (this.drag) this.drag.fixed = false;
    this.drag = null;
  };

  setData(nodes: GraphNode[], edges: GraphEdge[]): void {
    const keep = new Set(nodes.map((n) => n.id));
    for (const id of [...this.nodes.keys()]) if (!keep.has(id)) this.nodes.delete(id);
    let added = false;
    for (const n of nodes) {
      const ex = this.nodes.get(n.id);
      if (ex) Object.assign(ex, n);
      else {
        added = true;
        // spawn next to a neighbour if one exists, else on a ring
        const nb = edges.find((e) => e.to === n.id && this.nodes.has(e.from)) ?? edges.find((e) => e.from === n.id && this.nodes.has(e.to));
        const anchor = nb ? this.nodes.get(nb.from === n.id ? nb.to : nb.from) : undefined;
        const a = Math.random() * Math.PI * 2;
        const rr = anchor ? 30 : Math.min(this.w, this.hgt) * 0.3;
        this.nodes.set(n.id, { ...n, x: (anchor?.x ?? this.w / 2) + Math.cos(a) * rr, y: (anchor?.y ?? this.hgt / 2) + Math.sin(a) * rr, vx: 0, vy: 0 });
      }
    }
    const changed = added || edges.length !== this.edges.length;
    this.edges = edges.filter((e) => this.nodes.has(e.from) && this.nodes.has(e.to));
    if (changed) this.kick(added ? 1 : 0.4);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener("mouseup", this.onUp);
  }

  private kick(a: number) {
    this.alpha = Math.max(this.alpha, a);
  }

  private resize() {
    this.w = this.el.clientWidth || 600;
    this.hgt = this.el.clientHeight || 400;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.hgt * dpr;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.hgt}px`;
    this.kick(0.3);
  }

  private pos(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pick(e: MouseEvent): SimNode | null {
    const p = this.pos(e);
    let best: SimNode | null = null;
    let bd = Infinity;
    for (const n of this.nodes.values()) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < (n.size ?? 10) + 8 && d < bd) {
        best = n;
        bd = d;
      }
    }
    return best;
  }

  private onMove(e: MouseEvent) {
    const p = this.pos(e);
    if (this.drag) {
      this.drag.x = p.x;
      this.drag.y = p.y;
      this.kick(0.3);
    }
    this.hover = this.pick(e);
    this.canvas.style.cursor = this.hover ? "pointer" : "default";
    if (this.hover) {
      const deg = this.edges.filter((x) => x.from === this.hover!.id || x.to === this.hover!.id);
      this.tip.replaceChildren(h("b", null, this.hover.label), this.hover.sub ? h("div", null, this.hover.sub) : "", h("div", { class: "tc-tip-mark" }, `${deg.length} link${deg.length === 1 ? "" : "s"}`));
      this.tip.style.opacity = "1";
      this.tip.style.left = `${Math.min(this.w - 180, p.x + 14)}px`;
      this.tip.style.top = `${Math.max(0, p.y - 10)}px`;
    } else this.tip.style.opacity = "0";
  }

  private step() {
    const nodes = [...this.nodes.values()];
    const cx = this.w / 2;
    const cy = this.hgt / 2;
    const k = this.alpha;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 1;
        }
        const f = (2600 * k) / d2;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
    }
    const seen = new Set<string>();
    for (const e of this.edges) {
      const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = this.nodes.get(e.from)!;
      const b = this.nodes.get(e.to)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 110) * 0.02 * k;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.004 * k;
      n.vy += (cy - n.y) * 0.006 * k;
      if (n.fixed) {
        n.vx = n.vy = 0;
        continue;
      }
      n.vx *= 0.82;
      n.vy *= 0.82;
      n.x = Math.max(30, Math.min(this.w - 30, n.x + n.vx));
      n.y = Math.max(24, Math.min(this.hgt - 30, n.y + n.vy));
    }
    this.alpha = Math.max(0.02, this.alpha * 0.985);
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.el.isConnected) return;
    this.step();
    this.draw();
  };

  private draw() {
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.hgt);
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--text").trim() || "#e6e9f0";
    const muted = css.getPropertyValue("--muted").trim() || "#8a93a6";
    const panel = css.getPropertyValue("--panel").trim() || "#12151c";
    const focus = this.selected ?? this.hover?.id ?? null;
    const now = Date.now();
    // count parallel edges so they curve apart
    const pairCount = new Map<string, number>();
    for (const e of this.edges) {
      const a = this.nodes.get(e.from)!;
      const b = this.nodes.get(e.to)!;
      const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
      const idx = pairCount.get(key) ?? 0;
      pairCount.set(key, idx + 1);
      const dim = focus && e.from !== focus && e.to !== focus;
      ctx.globalAlpha = dim ? 0.12 : 0.85;
      ctx.strokeStyle = e.color;
      ctx.lineWidth = e.width ?? 1.6;
      ctx.setLineDash(e.dashed ? [5, 5] : []);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const bend = (idx - 0.5) * 18 + 8;
      const qx = mx - (dy / len) * bend;
      const qy = my + (dx / len) * bend;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(qx, qy, b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (e.arrow) {
        const rB = (b.size ?? 10) + 3;
        const t = 1 - rB / len;
        const px = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * qx + t * t * b.x;
        const py = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * qy + t * t * b.y;
        const ang = Math.atan2(b.y - qy, b.x - qx);
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - 8 * Math.cos(ang - 0.4), py - 8 * Math.sin(ang - 0.4));
        ctx.lineTo(px - 8 * Math.cos(ang + 0.4), py - 8 * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fill();
      }
      if (e.ts && now - e.ts < 6000) {
        const t = ((now - e.ts) % 1500) / 1500;
        const px = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * qx + t * t * b.x;
        const py = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * qy + t * t * b.y;
        ctx.globalAlpha = 1;
        ctx.fillStyle = e.color;
        ctx.shadowColor = e.color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      if (e.label && !dim && focus) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = muted;
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(e.label, qx, qy - 3);
      }
    }
    ctx.globalAlpha = 1;
    for (const n of this.nodes.values()) {
      const r = n.size ?? 10;
      const dim = focus && n.id !== focus && !this.edges.some((e) => (e.from === focus && e.to === n.id) || (e.to === focus && e.from === n.id));
      ctx.globalAlpha = dim ? 0.3 : 1;
      if (n.ring) {
        ctx.strokeStyle = n.ring;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = n.color;
      ctx.strokeStyle = panel;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.font = `${n.id === focus ? "600 " : ""}12px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(n.label, n.x, n.y + r + 15);
    }
    ctx.globalAlpha = 1;
  }
}
