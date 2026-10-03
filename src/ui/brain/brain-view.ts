/**
 * Brain View: a collapsible panel (bottom-left) that shows what the game's AI is thinking, live.
 *
 * - Feed: every `BrainEntry` from `lf.brain.subscribe` (server WS + local offline entries).
 * - Grouping: by run / ask (`ref`), as a goal header with the actor's face, then the steps.
 * - Rows: 💭 thought · 🔧 tool call · ✅/❌ tool result · 📐 plan · 🏰 faction decision · 🎯 director · ✨ reaction,
 *   each with a model badge (SONNET, HAIKU, RULES, CACHE, REPLAY) and the latency.
 * - Behaviour: auto-scroll (📌 locks the scroll), pin a group to keep it on top, click a row to expand its JSON.
 * - Hidden in normal play unless `?demo` or toggled with B.
 */
import type { BrainEntry } from '@liveforge/sdk';
import { lfOverlay } from '../lf-styles';
import { faceIcon } from './faces';

interface Group {
  key: string;
  el: HTMLElement;
  head: HTMLElement;
  text: HTMLElement;
  rows: HTMLElement;
  pinned: boolean;
  last: number;
  hasGoal: boolean;
}

const MAX_GROUPS = 40;
const MAX_ROWS = 60;

const KIND_ICON: Record<string, string> = { goal: '🎯', thought: '💭', tool_call: '🔧', tool_result: '✅', plan: '📐', decision: '⚖️', line: '💬' };

/** Icon for an entry (source-aware: faction decisions 🏰, director 🎯, reactions ✨). */
function iconFor(e: BrainEntry): string {
  const data = (e.data ?? {}) as Record<string, unknown>;
  if (e.kind === 'tool_result') return data.ok === false || /\bfailed\b/.test(e.text) ? '❌' : data.progress ? '⏳' : '✅';
  if (e.source === 'factions' && (e.kind === 'decision' || e.kind === 'plan')) return e.kind === 'plan' ? '🗺️' : '🏰';
  if (e.source === 'factions' && e.kind === 'thought') return '🧠';
  if (e.source === 'director') return '🎯';
  if (e.source === 'reactions') return '✨';
  if (e.source === 'forge') return e.kind === 'plan' ? '⚒️' : '⚡';
  if (e.source === 'agents' && e.kind === 'decision') return '🏁';
  if (e.source === 'persona') return '💬';
  return KIND_ICON[e.kind] ?? '•';
}

const SOURCE_TITLE: Record<string, string> = {
  factions: 'Village mind', director: 'Director', reactions: 'Reactions', builder: 'Builder', forge: 'Forge', persona: 'Persona', agents: 'Agent',
};

export class BrainView {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;
  private readonly groups = new Map<string, Group>();
  private autoScroll = true;
  private collapsed = false;
  private visible: boolean;
  private readonly lockBtn: HTMLElement;

  constructor(opts: { visible: boolean }) {
    this.visible = opts.visible;
    this.el = document.createElement('div');
    this.el.className = 'lcx-brain';
    const head = document.createElement('div');
    head.className = 'lcx-brain-head';
    const title = document.createElement('span');
    title.className = 'lcx-brain-title';
    title.textContent = 'BRAIN VIEW';
    this.status = document.createElement('span');
    this.status.className = 'lcx-hint';
    const sp = document.createElement('span');
    sp.className = 'lcx-sp';
    this.lockBtn = this.button('📌', 'Lock scroll (stop auto-scroll)', () => {
      this.autoScroll = !this.autoScroll;
      this.lockBtn.classList.toggle('lcx-on', !this.autoScroll);
      if (this.autoScroll) this.scrollEnd();
    });
    const clear = this.button('⌫', 'Clear', () => this.clear());
    const fold = this.button('▁', 'Collapse', () => this.setCollapsed(!this.collapsed));
    const close = this.button('✕', 'Hide (B)', () => this.setVisible(false));
    head.append(title, this.status, sp, this.lockBtn, clear, fold, close);
    this.body = document.createElement('div');
    this.body.className = 'lcx-brain-body';
    this.body.addEventListener('wheel', (ev) => ev.stopPropagation());
    this.el.append(head, this.body);
    this.el.classList.toggle('lcx-hidden', !this.visible);
    lfOverlay().appendChild(this.el);
  }

  /** Shows a short status (e.g. "Online · REPLAY") in the header. */
  setStatus(text: string): void {
    this.status.textContent = text;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.classList.toggle('lcx-hidden', !v);
    if (v) this.scrollEnd();
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  setCollapsed(c: boolean): void {
    this.collapsed = c;
    this.el.classList.toggle('lcx-collapsed', c);
  }

  clear(): void {
    for (const g of this.groups.values()) g.el.remove();
    this.groups.clear();
  }

  /** Adds one entry (call from `lf.brain.subscribe`). */
  add(e: BrainEntry): void {
    const g = this.groupFor(e);
    if (e.kind === 'goal') {
      g.text.textContent = e.text;
      g.hasGoal = true;
    }
    const row = document.createElement('div');
    const data = (e.data ?? {}) as Record<string, unknown>;
    const failed = e.kind === 'tool_result' && (data.ok === false || /\bfailed\b/.test(e.text));
    row.className = `lcx-row lcx-${e.kind}${failed ? ' lcx-fail' : ''}`;
    const ico = document.createElement('span');
    ico.className = 'lcx-ico';
    ico.textContent = iconFor(e);
    const txt = document.createElement('span');
    txt.className = 'lcx-txt';
    this.fillText(txt, e);
    row.append(ico, txt);
    if (e.model) {
      const b = document.createElement('span');
      b.className = `lcx-badge lcx-b-${e.model}`;
      b.textContent = e.model.toUpperCase();
      row.appendChild(b);
    }
    if (typeof e.ms === 'number') {
      const ms = document.createElement('span');
      ms.className = 'lcx-ms';
      ms.textContent = e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)}s` : `${Math.round(e.ms)}ms`;
      row.appendChild(ms);
    }
    let json: HTMLElement | null = null;
    row.addEventListener('click', () => {
      if (json) {
        json.remove();
        json = null;
        return;
      }
      json = document.createElement('pre');
      json.className = 'lcx-json';
      json.textContent = JSON.stringify({ source: e.source, actor: e.actor, kind: e.kind, model: e.model, ms: e.ms, ref: e.ref, data: e.data }, null, 1).slice(0, 6000);
      row.after(json);
    });
    g.rows.appendChild(row);
    while (g.rows.childElementCount > MAX_ROWS) g.rows.firstElementChild?.remove();
    g.last = Date.now();
    // newest group to the bottom (pinned groups stay on top)
    if (!g.pinned && g.el !== this.body.lastElementChild) this.body.appendChild(g.el);
    this.trim();
    if (this.autoScroll) this.scrollEnd();
  }

  private fillText(el: HTMLElement, e: BrainEntry): void {
    const data = (e.data ?? {}) as Record<string, unknown>;
    if (e.kind === 'tool_call') {
      const tool = typeof data.tool === 'string' ? data.tool : e.text.split('(')[0];
      const input = data.input !== undefined ? JSON.stringify(data.input) : e.text.slice(tool.length);
      const code = document.createElement('code');
      code.textContent = `${tool}(${input.replace(/^\(|\)$/g, '').slice(0, 140)})`;
      el.appendChild(code);
      return;
    }
    if (e.kind === 'plan' && data.plan && typeof data.plan === 'object') {
      const plan = data.plan as { ops?: unknown[]; name?: string };
      const mats = (data.materials ?? {}) as Record<string, number>;
      const blocks = Object.values(mats).reduce((n, v) => n + (Number(v) || 0), 0);
      const top = Object.entries(mats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v} ${k}`).join(', ');
      el.textContent = `${e.text}${plan.ops ? ` · ${plan.ops.length} ops` : ''}${blocks ? ` · ${blocks} blocks` : ''}${top ? ` (${top})` : ''}`;
      return;
    }
    el.textContent = e.text;
  }

  private groupFor(e: BrainEntry): Group {
    const key = e.ref ?? `${e.source}:${e.actor}:${Math.floor(e.ts / 15000)}`;
    const hit = this.groups.get(key);
    if (hit) return hit;
    const el = document.createElement('div');
    el.className = 'lcx-group';
    const head = document.createElement('div');
    head.className = 'lcx-ghead';
    const face = faceIcon(e.actor || e.source);
    const text = document.createElement('span');
    text.className = 'lcx-gtext';
    const who = e.source === 'agents' ? e.actor : `${SOURCE_TITLE[e.source] ?? e.source}${e.actor && e.actor !== e.source ? ` · ${e.actor}` : ''}`;
    text.textContent = e.kind === 'goal' ? e.text : who;
    const pin = document.createElement('span');
    pin.className = 'lcx-pin';
    pin.textContent = '📌';
    pin.title = 'Pin this group on top';
    const rows = document.createElement('div');
    head.append(face, text, pin);
    el.append(head, rows);
    const g: Group = { key, el, head, text, rows, pinned: false, last: Date.now(), hasGoal: e.kind === 'goal' };
    if (e.kind !== 'goal' && e.source === 'agents') text.textContent = `${who}`;
    pin.addEventListener('click', (ev) => {
      ev.stopPropagation();
      g.pinned = !g.pinned;
      el.classList.toggle('lcx-pinned', g.pinned);
      if (g.pinned) this.body.prepend(el);
      else this.body.appendChild(el);
    });
    this.groups.set(key, g);
    this.body.appendChild(el);
    return g;
  }

  private trim(): void {
    if (this.groups.size <= MAX_GROUPS) return;
    const old = [...this.groups.values()].filter((g) => !g.pinned).sort((a, b) => a.last - b.last);
    for (const g of old.slice(0, this.groups.size - MAX_GROUPS)) {
      g.el.remove();
      this.groups.delete(g.key);
    }
  }

  private scrollEnd(): void {
    requestAnimationFrame(() => (this.body.scrollTop = this.body.scrollHeight));
  }

  private button(label: string, title: string, fn: () => void): HTMLElement {
    const b = document.createElement('button');
    b.className = 'lcx-ib';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      fn();
    });
    return b;
  }
}
