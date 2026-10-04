/**
 * Lane WB Demo panel buttons (added to liveforge/scenarios.ts in one delimited block). They resolve the WB systems
 * when clicked, because the journal plugin initialises after the liveforge plugin builds the panel.
 */
import type { Game } from '../../game/game';
import type { DemoButton } from '../../ui/demo/demo-panel';
import { village } from '../../village';
import { maybeWorld } from './index';

function face(game: Game, x: number, z: number): void {
  const p = game.player.position;
  game.player.yaw = Math.atan2(-(x - p.x), -(z - p.z));
  game.player.pitch = -0.05;
}

/** "📜 Start a rumour", "🔗 Quest chain", "🎩 Makeover", "🧊 Upgrade to 3D", "📖 Journal". */
export function worldDemoButtons(game: Game): DemoButton[] {
  const w = () => {
    const x = maybeWorld();
    if (!x) game.ui.toast('Journal / world systems are not ready yet', { kind: 'warn' });
    return x;
  };
  const resume = () => {
    game.ui.screens.closeAll();
    game.input.lock();
  };
  return [
    {
      label: '📜 Start a rumour',
      hint: 'Pip saw something… it spreads (and grows) to 3 villagers',
      run: () => {
        const x = w();
        if (!x) return;
        resume();
        // stand on the plaza, facing the board, so the gossip is on camera
        const l = village.layout;
        if (l) {
          game.setTime('noon');
          game.teleportPlayer(l.board.x + 2.5, null, l.board.z + 7.5);
          face(game, l.board.x + 2, l.board.z);
        }
        x.rumours.startDemoRumour();
      },
    },
    {
      label: '🔗 Quest chain',
      hint: "Mara's Trust: 3 chained quests, quest.offer with the story so far",
      run: () => {
        const x = w();
        if (!x) return;
        game.ui.screens.closeAll();
        x.chains.start('mara');
      },
    },
    {
      label: '🎩 Makeover',
      hint: 'forge.npc_look: Bram hard hat, Mara scarf, Rowan helmet',
      run: () => {
        const x = w();
        if (!x) return;
        resume();
        x.makeovers.trigger('bram', 'built_for_player', true);
        setTimeout(() => x.makeovers.trigger('mara', 'griefed', true), 1200);
        setTimeout(() => x.makeovers.trigger('captain_rowan', 'guarding', true), 2400);
      },
    },
    {
      label: '📖 Journal',
      hint: 'J: who you are, what they think, rumours, achievements, quests',
      run: () => {
        game.ui.screens.closeAll();
        w()?.openJournal('who');
      },
    },
    {
      label: '🧊 Upgrade to 3D',
      hint: 'Hyper3D mesh of the last forged thing (needs a key)',
      run: () => void w()?.mesh.upgradeLast(),
    },
  ];
}
