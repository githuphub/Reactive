/**
 * Villager interaction menu (look at a villager + E or right click): Talk, Trade, Ask to follow.
 */
import { el, type Screen } from '../../ui/ui';
import type { Npc } from '../npc/npc';
import type { Village } from '../village';
import { injectVillageStyles } from './styles';

export class InteractMenu {
  private screen: Screen | null = null;

  constructor(private readonly v: Village) {
    injectVillageStyles();
  }

  get isOpen(): boolean {
    return this.screen !== null;
  }

  open(npc: Npc): void {
    this.close();
    const game = this.v.game;
    const root = el('div');
    const panel = el('div', 'lc-panel lcv-menu');
    panel.appendChild(el('h2', undefined, npc.def.name));
    panel.appendChild(el('div', 'lcv-sub', `${npc.def.role}${npc.injured ? ' · injured' : ''} · ${npc.controller.activity}`));
    const actions: { label: string; run: () => void }[] = [];
    actions.push({ label: 'Talk', run: () => this.v.talk(npc) });
    if (npc.def.trader) actions.push({ label: 'Trade', run: () => void npc.controller.trade() });
    const following = npc.controller.currentMode === 'follow';
    actions.push({
      label: following ? 'Stop following me' : 'Ask to follow',
      run: () => {
        if (following) void npc.controller.stopFollow().then(() => void npc.controller.say('Right, I\'ll be about.', { priority: 'schedule' }));
        else if (npc.isGolem || this.v.posture !== 'hostile') {
          void npc.controller.follow('player', { distance: 3 });
          void npc.controller.say(npc.isGolem ? 'creaks and follows' : pick(['Lead the way!', 'Right behind you.', 'Where are we off to?']), { emote: npc.isGolem ? undefined : 'nod' });
        } else void npc.controller.say('Not after what you did.', { emote: 'glare' });
      },
    });
    actions.push({ label: 'Close', run: () => {} });
    actions.forEach((a, i) => {
      const b = el('button', 'lc-btn');
      b.textContent = a.label;
      const k = el('kbd', undefined, String(i + 1));
      b.appendChild(k);
      b.addEventListener('click', () => {
        this.close();
        a.run();
      });
      panel.appendChild(b);
    });
    root.appendChild(panel);
    const screen: Screen = {
      id: 'villager-menu',
      el: root,
      pausesGame: false,
      onKey: (e) => {
        const n = Number(e.key);
        if (n >= 1 && n <= actions.length) {
          this.close();
          actions[n - 1].run();
          return true;
        }
        if (e.code === 'KeyE') {
          this.close();
          return true;
        }
        return false;
      },
      onClose: () => (this.screen = null),
    };
    this.screen = screen;
    game.ui.screens.open(screen);
    npc.lookAtTarget(game.player, 5);
    if (!npc.moving) npc.face(game.player.position.x, game.player.position.z);
  }

  close(): void {
    if (this.screen) this.v.game.ui.screens.close(this.screen);
    this.screen = null;
  }
}

function pick<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}
