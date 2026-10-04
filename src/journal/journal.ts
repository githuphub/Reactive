/**
 * The Journal (J): a book with five tabs.
 *
 * 1. **Who you are**: the Observer's profile text, top traits with evidence, stats and recent moments (`player.model`
 *    online; a local estimate from Game events offline). "✨ Ask the Observer" requests a fresh AI profile.
 * 2. **What they think of you**: each villager's face, attitude meter and remembered moments, their current look,
 *    the nicknames you were given, and Oakhollow's reputation / trust / posture.
 * 3. **Rumours**: what the village says about you, how hot it is, who knows it, and how the wording drifted.
 * 4. **Achievements**: unlocked (rarity colours) and locked hints.
 * 5. **Quests**: quest chains with their steps and the active quests' objectives.
 */
import type { Game } from '../game/game';
import type { Screen } from '../ui/ui';
import { faceIcon } from '../ui/brain/faces';
import { village } from '../village';
import { getHub, playerTitle } from '../liveforge/hub';
import { LF_NAMED } from '../liveforge/ids';
import { getQuests } from '../liveforge/quests';
import type { LiveforgeService } from '../liveforge/service';
import type { World } from '../liveforge/world';
import { RARITY_COLOR } from '../liveforge/world/styles';
import { npcLabel } from '../liveforge/world/stats';
import type { Memories } from './memories';
import { loadProfile, localProfile, type ProfileView } from './profile';
import { injectJournalStyles } from './styles';

export type JournalTab = 'who' | 'they' | 'rumours' | 'achievements' | 'quests';

const TABS: { id: JournalTab; label: string }[] = [
  { id: 'who', label: '🧭 Who you are' },
  { id: 'they', label: '💬 What they think' },
  { id: 'rumours', label: '📜 Rumours' },
  { id: 'achievements', label: '🏆 Achievements' },
  { id: 'quests', label: '🔗 Quests' },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function badge(text: string, cls: string): HTMLElement {
  return el('span', `wbj-badge wbj-${cls}`, text);
}

function face(id: string, px = 44): HTMLCanvasElement {
  const c = faceIcon(id);
  c.style.width = c.style.height = `${px}px`;
  return c;
}

export class Journal {
  private tab: JournalTab = 'who';
  private readonly screen: Screen;
  private readonly tabsEl: HTMLElement;
  private readonly left: HTMLElement;
  private readonly right: HTMLElement;
  private readonly tabButtons = new Map<JournalTab, HTMLButtonElement>();
  private profile: ProfileView | null = null;
  private profileBusy = false;

  constructor(private readonly game: Game, private readonly lf: LiveforgeService, private readonly world: World, private readonly memories: Memories) {
    injectJournalStyles();
    const root = el('div', 'wbj-root');
    const book = el('div', 'wbj-book');
    this.tabsEl = el('div', 'wbj-tabs');
    for (const t of TABS) {
      const b = el('button', 'wbj-tab', t.label);
      b.addEventListener('click', () => this.show(t.id));
      this.tabButtons.set(t.id, b);
      this.tabsEl.appendChild(b);
    }
    const close = el('button', 'wbj-close', '✕ close (J)');
    close.addEventListener('click', () => this.close());
    const pages = el('div', 'wbj-pages');
    this.left = el('div', 'wbj-page');
    this.right = el('div', 'wbj-page');
    pages.append(this.left, this.right);
    book.append(this.tabsEl, close, pages);
    root.appendChild(book);
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) this.close();
    });
    this.screen = {
      id: 'wb-journal',
      el: root,
      pausesGame: true,
      onOpen: () => this.render(),
      onKey: (e) => {
        if (e.code === 'KeyJ') {
          this.close();
          return true;
        }
        const n = Number(e.key);
        if (n >= 1 && n <= TABS.length) {
          this.show(TABS[n - 1].id);
          return true;
        }
        return false;
      },
    };
    game.input.onKey((e) => {
      if (e.code !== 'KeyJ' || e.repeat || !game.ready || game.ui.screens.isOpen) return false;
      this.open();
      return true;
    });
    world.rumours.book.onChange(() => {
      if (this.isOpen && this.tab === 'rumours') this.render();
    });
  }

  get isOpen(): boolean {
    return this.game.ui.screens.has('wb-journal');
  }

  /** Opens the journal (optionally on a tab) and refreshes server data. */
  open(tab?: JournalTab | string): void {
    if (tab && TABS.some((t) => t.id === tab)) this.tab = tab as JournalTab;
    if (!this.isOpen) {
      this.game.ui.screens.open(this.screen);
      this.refreshServer();
    } else this.render();
  }

  close(): void {
    if (!this.isOpen) return;
    this.game.ui.screens.close(this.screen);
    this.game.input.lock();
  }

  show(tab: JournalTab): void {
    this.tab = tab;
    this.render();
  }

  private refreshServer(): void {
    void this.memories.refresh().then(() => {
      if (this.isOpen && this.tab === 'they') this.render();
    });
    this.world.rumours.refresh();
    this.loadProfile(false);
  }

  private loadProfile(fresh: boolean): void {
    this.profileBusy = fresh;
    loadProfile(this.lf, this.world.stats, fresh, (v) => {
      this.profile = v;
      if (v.model !== 'rules' || !fresh) this.profileBusy = false;
      if (this.isOpen && this.tab === 'who') this.render();
    });
    if (fresh) setTimeout(() => {
      if (!this.profileBusy) return;
      this.profileBusy = false;
      if (this.isOpen && this.tab === 'who') this.render();
    }, 30_000);
  }

  private render(): void {
    for (const [id, b] of this.tabButtons) b.classList.toggle('wbj-on', id === this.tab);
    const ach = this.tabButtons.get('achievements');
    if (ach) ach.innerHTML = `🏆 Achievements <small>${this.world.achievements.list().length}</small>`;
    const rum = this.tabButtons.get('rumours');
    if (rum) rum.innerHTML = `📜 Rumours <small>${this.world.rumours.book.list().filter((r) => r.aboutPlayer).length}</small>`;
    const ls = this.left.scrollTop, rs = this.right.scrollTop;
    this.left.replaceChildren();
    this.right.replaceChildren();
    try {
      if (this.tab === 'who') this.renderWho();
      else if (this.tab === 'they') this.renderThey();
      else if (this.tab === 'rumours') this.renderRumours();
      else if (this.tab === 'achievements') this.renderAchievements();
      else this.renderQuests();
    } catch (err) {
      console.error('[journal] render failed', err);
      this.left.appendChild(el('p', 'wbj-muted', `(this page is smudged: ${(err as Error).message})`));
    }
    this.left.scrollTop = ls;
    this.right.scrollTop = rs;
  }

  // ------------------------------------------------------------------------------------------ who you are

  private renderWho(): void {
    const v = this.profile ?? localProfile(this.world.stats);
    const h = el('h2', undefined, `The Journal of ${playerTitle()}`);
    h.appendChild(badge(v.source === 'server' ? 'OBSERVER' : 'LOCAL ESTIMATE', v.source));
    this.left.appendChild(h);
    const nick = this.memories.allNicknames();
    if (nick.length) {
      const p = el('div');
      p.appendChild(el('span', 'wbj-muted', 'Known as '));
      for (const n of nick.slice(0, 4)) p.appendChild(el('span', 'wbj-nick', `“${n.name}”`));
      this.left.appendChild(p);
    }
    const prof = el('div', 'wbj-profile', v.text);
    prof.appendChild(badge(v.model.toUpperCase(), v.model));
    this.left.appendChild(prof);
    const row = el('div');
    const btn = el('button', 'wbj-btn', this.profileBusy ? '✨ The Observer is writing…' : '✨ Ask the Observer for a fresh profile');
    btn.disabled = this.profileBusy || !this.lf.online;
    btn.addEventListener('click', () => {
      this.loadProfile(true);
      this.render();
    });
    row.appendChild(btn);
    if (!this.lf.online) row.appendChild(el('span', 'wbj-muted', '  (offline: local estimate from what you did)'));
    this.left.appendChild(row);

    this.left.appendChild(el('h3', undefined, 'Traits'));
    if (!v.traits.length) this.left.appendChild(el('p', 'wbj-muted', 'Nothing stands out yet. Go and do something memorable.'));
    for (const t of v.traits) {
      const d = el('div', 'wbj-trait');
      const hd = el('div', 'wbj-trait-h');
      hd.append(el('span', undefined, t.name.replace(/_/g, ' ')), el('span', undefined, `${Math.round(t.score * 100)}%`));
      const bar = el('div', 'wbj-bar');
      const fill = el('i');
      fill.style.width = `${Math.round(t.score * 100)}%`;
      bar.appendChild(fill);
      d.append(hd, bar);
      if (t.evidence) d.appendChild(el('div', 'wbj-ev', `“${t.evidence}”`));
      this.left.appendChild(d);
    }

    this.right.appendChild(el('h2', undefined, 'By the numbers'));
    const grid = el('div', 'wbj-stats');
    for (const s of v.stats) {
      const r = el('div');
      r.append(el('span', undefined, s.label), el('b', undefined, s.value));
      grid.appendChild(r);
    }
    this.right.appendChild(grid);
    this.right.appendChild(el('h3', undefined, 'Recent moments'));
    const ul = el('ul', 'wbj-list');
    if (!v.moments.length) ul.appendChild(el('li', 'wbj-muted', 'No moments yet.'));
    for (const m of v.moments) {
      const li = el('li', undefined, m.text);
      li.appendChild(el('span', 'wbj-when', ago(m.ts)));
      ul.appendChild(li);
    }
    this.right.appendChild(ul);
  }

  // ------------------------------------------------------------------------------------------ what they think

  private renderThey(): void {
    this.left.appendChild(el('h2', undefined, 'What Oakhollow thinks'));
    const rep = el('div', 'wbj-rep');
    const st = this.memories.standing;
    const repValue = st?.reputation?.value ?? st?.trust ?? this.memories.localReputation();
    const label = st?.reputation?.standing ?? attitudeLabel(repValue);
    const head = el('div');
    head.append(el('b', undefined, `Reputation: ${label}`), badge(st && this.lf.online ? 'LIVEFORGE' : 'LOCAL', st && this.lf.online ? 'server' : 'local'));
    rep.append(head, this.meter(repValue));
    const facts: string[] = [];
    if (st?.trust != null) facts.push(`village trust ${fmt(st.trust)}`);
    facts.push(`posture ${st?.posture ?? village.posture}`);
    facts.push(`prices ×${(st?.priceMult ?? village.priceMult).toFixed(2)}`);
    if (st?.mood != null) facts.push(`mood ${st.mood > 0.2 ? 'jubilant' : st.mood < -0.2 ? 'grim' : 'steady'}`);
    rep.appendChild(el('div', 'wbj-muted', facts.join(' · ')));
    this.left.appendChild(rep);
    const nick = this.memories.allNicknames();
    this.left.appendChild(el('h3', undefined, 'Names they call you'));
    if (!nick.length) this.left.appendChild(el('p', 'wbj-muted', 'No nickname yet. Do something worth naming.'));
    for (const n of nick) {
      const p = el('div');
      p.appendChild(el('span', 'wbj-nick', `“${n.name}”`));
      if (n.because) p.appendChild(el('span', 'wbj-muted', ` for ${n.because}`));
      this.left.appendChild(p);
    }
    const ids = LF_NAMED.filter((id) => village.npc(id));
    ids.forEach((id, i) => (i < 2 ? this.left : this.right).appendChild(this.npcCard(id)));
  }

  private npcCard(id: string): HTMLElement {
    const card = el('div', 'wbj-npc');
    card.appendChild(face(id));
    const body = el('div');
    const h = el('div', 'wbj-npc-h');
    const npc = village.npc(id);
    h.append(el('b', undefined, npcLabel(id)), el('span', undefined, npc?.def.role ?? ''));
    const att = this.memories.attitudeOf(id);
    const a = el('div', 'wbj-att', `${attitudeLabel(att.value)} (${fmt(att.value)})`);
    a.appendChild(badge(att.source === 'server' ? 'LIVEFORGE' : 'LOCAL', att.source));
    body.append(h, this.meter(att.value), a);
    const look = this.world.makeovers.lookOf(id);
    if (look) body.appendChild(el('div', 'wbj-look', `✨ wearing ${look.summary.replace(/^.*?→ /, '')}`));
    const mem = this.memories.of(id);
    const ul = el('ul', 'wbj-mem');
    if (!mem.length) ul.appendChild(el('li', 'wbj-muted', 'Has no memories of you yet.'));
    for (const m of mem.slice(0, 4)) {
      const li = el('li', m.sentiment < -0.04 ? 'wbj-neg' : m.sentiment > 0.04 ? 'wbj-pos' : '', `${icon(m.kind)} ${m.text}`);
      li.appendChild(el('span', 'wbj-when', ago(m.ts)));
      ul.appendChild(li);
    }
    body.appendChild(ul);
    card.appendChild(body);
    return card;
  }

  private meter(v: number): HTMLElement {
    const m = el('div', 'wbj-meter');
    const i = el('i');
    i.style.left = `${Math.round(((Math.max(-1, Math.min(1, v)) + 1) / 2) * 100)}%`;
    m.appendChild(i);
    return m;
  }

  // ------------------------------------------------------------------------------------------ rumours

  private renderRumours(): void {
    const all = this.world.rumours.book.list();
    this.left.appendChild(el('h2', undefined, 'What they whisper'));
    if (!all.length) this.left.appendChild(el('p', 'wbj-muted', 'No rumours about you… yet. The notice board on the plaza shows them as they form.'));
    all.slice(0, 8).forEach((r, i) => {
      const n = el('div', 'wbj-rumour');
      n.style.setProperty('--tilt', `${((i % 3) - 1) * 0.6}deg`);
      n.appendChild(el('q', undefined, r.content));
      if (r.history[0]) n.appendChild(el('span', 'wbj-was', `was: “${r.history[r.history.length - 1]}”`));
      const f = el('div', 'wbj-faces');
      f.appendChild(document.createTextNode('known by '));
      for (const k of r.knownBy.slice(0, 6)) {
        const c = face(k, 18);
        c.title = npcLabel(k);
        f.appendChild(c);
      }
      f.appendChild(document.createTextNode(` · heat ${Math.round(r.heat * 100)}% · truth ${Math.round(r.truthfulness * 100)}%${r.mutations ? ` · retold ${r.mutations}×` : ''}`));
      f.appendChild(badge(r.source === 'server' ? 'LIVEFORGE' : 'LOCAL', r.source === 'server' ? 'server' : 'local'));
      n.appendChild(f);
      this.left.appendChild(n);
    });
    const top = all.find((r) => r.edges.length) ?? all[0];
    this.right.appendChild(el('h2', undefined, 'How it spread'));
    if (!top) {
      this.right.appendChild(el('p', 'wbj-muted', 'Watch villagers walk over to each other and whisper: 💬 flies between their heads and the story changes a little each time.'));
      return;
    }
    this.right.appendChild(el('p', undefined, `“${top.content}”`));
    const ul = el('ul', 'wbj-list');
    ul.appendChild(el('li', undefined, `${top.origin ? npcLabel(top.origin) : 'Someone'} started it`));
    for (const e of top.edges) {
      const li = el('li', undefined, `${e.from ? npcLabel(e.from) : '?'} → ${npcLabel(e.to)}`);
      li.appendChild(el('span', 'wbj-when', ago(e.ts)));
      ul.appendChild(li);
    }
    this.right.appendChild(ul);
    if (top.history.length) {
      this.right.appendChild(el('h3', undefined, 'How the story drifted'));
      const hl = el('ul', 'wbj-list');
      for (const w of [...top.history].reverse()) hl.appendChild(el('li', undefined, `“${w}”`));
      hl.appendChild(el('li', undefined, `now: “${top.content}”`));
      this.right.appendChild(hl);
    }
  }

  // ------------------------------------------------------------------------------------------ achievements

  private renderAchievements(): void {
    const un = this.world.achievements.list();
    this.left.appendChild(el('h2', undefined, `Achievements (${un.length})`));
    if (!un.length) this.left.appendChild(el('p', 'wbj-muted', 'None yet. Some are generated just for you by Liveforge.'));
    for (const a of un) {
      const d = el('div', 'wbj-ach');
      d.style.setProperty('--rar', RARITY_COLOR[a.rarity] ?? RARITY_COLOR.common);
      d.appendChild(el('div', 'wbj-ico', a.icon));
      const t = el('div');
      const b = el('b', undefined, a.title);
      b.appendChild(badge(a.rarity.toUpperCase(), a.personal ? 'sonnet' : 'local'));
      t.append(b, el('small', undefined, `${a.description} · ${ago(a.at)}`));
      d.appendChild(t);
      this.left.appendChild(d);
    }
    const locked = this.world.achievements.locked();
    this.right.appendChild(el('h2', undefined, `Still to find (${locked.length})`));
    for (const a of locked) {
      const d = el('div', 'wbj-ach wbj-locked');
      d.appendChild(el('div', 'wbj-ico', a.icon));
      const t = el('div');
      t.append(el('b', undefined, '???'), el('small', undefined, `Hint: ${a.hint}`));
      d.appendChild(t);
      this.right.appendChild(d);
    }
  }

  // ------------------------------------------------------------------------------------------ quests

  private renderQuests(): void {
    const chains = this.world.chains.list();
    this.left.appendChild(el('h2', undefined, 'Quest chains'));
    if (!chains.length) this.left.appendChild(el('p', 'wbj-muted', "Finish a villager's quest and their story continues: each next quest builds on the last."));
    for (const c of chains) {
      const d = el('div', 'wbj-chain');
      const doneN = c.quests.filter((q) => q.status === 'done').length;
      const h = el('div');
      h.append(face(c.giver, 20), document.createTextNode(' '), el('b', undefined, `${c.title} ${doneN}/${c.of}`));
      if (c.done) h.appendChild(badge('COMPLETE', 'server'));
      d.appendChild(h);
      const steps = el('div', 'wbj-steps');
      for (let i = 0; i < c.of; i++) {
        const q = c.quests[i];
        steps.appendChild(el('div', `wbj-step${q ? ` wbj-${q.status}` : ''}`, q ? `${i + 1}. ${q.title}` : `${i + 1}. ???`));
      }
      d.appendChild(steps);
      this.left.appendChild(d);
    }
    const btn = el('button', 'wbj-btn', "🔗 Ask Mara what she needs");
    btn.addEventListener('click', () => {
      this.close();
      this.world.chains.start('mara');
    });
    this.left.appendChild(btn);

    this.right.appendChild(el('h2', undefined, 'Active quests'));
    let active: ReturnType<ReturnType<typeof getQuests>['activeList']> = [];
    try {
      active = getQuests().activeList();
    } catch {
      /* quests not ready */
    }
    if (!active.length) this.right.appendChild(el('p', 'wbj-muted', 'No active quests. Talk to the villagers.'));
    for (const a of active) {
      const d = el('div', 'wbj-chain');
      const c = this.world.chains.chainOf(a.quest.id);
      d.appendChild(el('b', undefined, c ? `${c.title} · ${a.quest.title}` : a.quest.title));
      d.appendChild(el('div', 'wbj-muted', `from ${npcLabel(a.giver)} · ${a.quest.summary}`));
      for (const o of a.quest.objectives) {
        const done = a.done.includes(o.id);
        const pct = Math.round((done ? 1 : a.progress[o.id] ?? 0) * 100);
        d.appendChild(el('div', `wbj-obj${done ? ' wbj-done' : ''}`, `${done ? '✔' : '•'} ${o.description}${!done && pct ? ` (${pct}%)` : ''}`));
      }
      this.right.appendChild(d);
    }
    const nick = getHub().nickname;
    if (nick) this.right.appendChild(el('p', 'wbj-muted', `Quest givers now address you as “${nick}”.`));
  }
}

function attitudeLabel(v: number): string {
  if (v <= -0.6) return 'Hostile';
  if (v <= -0.2) return 'Wary';
  if (v < 0.2) return 'Neutral';
  if (v < 0.6) return 'Friendly';
  return 'Devoted';
}

function fmt(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}

function icon(kind: string): string {
  return ({ conversation: '💬', witnessed: '👁', rumour: '🗞', gift: '🎁', harm: '💢', trade: '🪙', other: '•' } as Record<string, string>)[kind] ?? '•';
}
