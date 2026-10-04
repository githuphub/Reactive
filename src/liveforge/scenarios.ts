/**
 * The presentation scenarios and the utilities behind the Demo panel. Each scenario stages its
 * preconditions (time, place, inventory, seeded play style via signals) and shows a caption.
 */
import type { Game } from '../game/game';
import { confirmResetMap } from '../game/reset';
import { getSpawnDirector } from '../mobs';
import { giveItem } from '../survival';
import type { DemoAction, DemoButton, DemoToggle } from '../ui/demo/demo-panel';
import { village } from '../village';
import type { Amends } from './amends';
import { getHub } from './hub';
import type { RaidRunner } from './raid';
import type { LiveforgeService } from './service';
import type { Talk } from './talk';
import { voices } from './voice';
import { worldDemoButtons } from './world/demo'; // lane WB

export interface ScenarioDeps {
  game: Game;
  lf: LiveforgeService;
  talk: Talk;
  raid: RaidRunner;
  amends: Amends;
  openForge(prefill?: string, mode?: 'item' | 'building'): void;
  brain: { toggle(): void; isVisible: boolean; clear(): void };
  captions: { enabled: boolean; setEnabled(on: boolean): void };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Closes the pause menu (and any screen) and grabs the mouse again. */
function resume(game: Game): void {
  game.ui.screens.closeAll();
  game.input.lock();
}

/** Faces the player towards a point. */
function face(game: Game, x: number, z: number): void {
  const p = game.player.position;
  game.player.yaw = Math.atan2(-(x - p.x), -(z - p.z));
  game.player.pitch = -0.05;
}

export function scenarioButtons(d: ScenarioDeps): DemoButton[] {
  const { game, lf } = d;
  return [
    {
      label: '🏠 Build me a house',
      hint: 'Bram plans with builder.plan, then builds',
      run: async () => {
        game.ui.screens.closeAll();
        game.setTime('noon');
        game.setWeather('clear');
        const plot = village.plots[0];
        const bram = village.npc('bram');
        if (!plot || !bram) return void game.ui.toast('Bram or his plot is missing');
        const cx = (plot.rect.x0 + plot.rect.x1) / 2, cz = (plot.rect.z0 + plot.rect.z1) / 2;
        let dx = plot.front.x - cx, dz = plot.front.z - cz;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        if (len < 2) [dx, dz] = [1, 0];
        void lf.client.agents.interrupt('bram', 'demo reset').catch(() => {});
        await bram.controller.cancel('demo');
        bram.teleport(plot.front.x + 0.5, plot.front.y, plot.front.z + 0.5);
        game.teleportPlayer(plot.front.x + 0.5 + dx * 4.5, null, plot.front.z + 0.5 + dz * 4.5);
        face(game, bram.position.x, bram.position.z);
        await sleep(150);
        // an agent-priority action keeps Bram here (his schedule pauses while agents drive him)
        void bram.controller.lookAt('player');
        void bram.controller.say('Ah, a visitor! Need something built?', { emote: 'wave' });
        getHub().caption('🏠 Ask Bram for a house: press Enter to send', 8);
        await sleep(600);
        d.talk.open(bram, 'Bram, build me a cosy house with a little tower');
      },
    },
    {
      label: '🌙 Night raid',
      hint: 'seeded pillaring + archery → counter-raid',
      run: async () => {
        resume(game);
        game.setGameMode('survival');
        for (let i = 0; i < 6; i++) {
          getHub().habits.add('pillaring', 'demo seed');
          lf.signal('build.pillared', { height: 6 + i });
        }
        for (let i = 0; i < 10; i++) {
          getHub().habits.add('bow_heavy', 'demo seed');
          lf.signal('combat.shot_bow', { target: 'zombie', hit: i % 3 !== 0, distance: 14 });
        }
        void lf.client.flush().catch(() => {});
        giveItem(game, 'bow', 1);
        giveItem(game, 'arrow', 48);
        giveItem(game, 'cobblestone', 64);
        giveItem(game, 'iron_sword', 1);
        getSpawnDirector(game).clear((m) => m.category === 'hostile' && !m.data.raid);
        game.setTime('dusk');
        getHub().caption('🌙 The village mind read your play style: pillaring + archery', 6);
        await sleep(1800);
        await d.raid.start({ night: Math.max(1, game.time.day + 1) });
      },
    },
    {
      label: "🔨 Grief Mara's house",
      hint: 'break a few blocks of her house',
      run: async () => {
        resume(game);
        game.setTime('noon');
        game.setGameMode('survival');
        const b = village.building('mara_house');
        if (!b) return void game.ui.toast("Mara's house is missing");
        const e = b.door ?? b.entrance;
        const cx = (b.bounds.min[0] + b.bounds.max[0]) / 2, cz = (b.bounds.min[2] + b.bounds.max[2]) / 2;
        let dx = e.x - cx, dz = e.z - cz;
        const len = Math.hypot(dx, dz) || 1;
        game.teleportPlayer(e.x + 0.5 + (dx / len) * 3, null, e.z + 0.5 + (dz / len) * 3);
        face(game, cx, cz);
        giveItem(game, 'iron_pickaxe', 1);
        const slot = game.inventory.slots.findIndex((s) => s?.item === 'iron_pickaxe');
        if (slot >= 0 && slot < 9) game.inventory.select(slot);
        getHub().caption("🔨 Break a few blocks of Mara's house… the village remembers.", 8);
      },
    },
    {
      label: '🤝 Make amends',
      hint: 'materials + the repair quest',
      run: () => {
        resume(game);
        d.amends.makeAmends();
      },
    },
    {
      label: '🧱 Bram, help me repair it',
      hint: 'agent goal: Bram co-builds the repair',
      run: async () => {
        resume(game);
        await d.amends.askBram();
      },
    },
    {
      label: '⚡ Forge anything',
      hint: '"a pickaxe made of lightning"',
      run: () => {
        game.ui.screens.closeAll();
        d.openForge('a pickaxe made of lightning', 'item');
      },
    },
    {
      label: '🏰 Forge a building',
      hint: 'builder.plan → a blueprint: R rotates, right-click builds',
      run: () => {
        game.ui.screens.closeAll();
        d.openForge('a wizard tower with a spiral staircase', 'building');
      },
    },
    // ---- lane WB: rumours, quest chains, makeovers, Hyper3D (src/liveforge/world/demo.ts) ----
    ...worldDemoButtons(game),
    // ---- end lane WB ----
  ];
}

export function utilityButtons(d: ScenarioDeps): (DemoToggle | DemoAction)[] {
  const { game, lf } = d;
  return [
    { label: '☀ Day / 🌙 Night', run: () => game.setTime(game.time.isNight ? 'noon' : 'midnight') },
    { label: 'Rain', get: () => game.weather.current !== 'clear', set: (on) => game.setWeather(on ? 'rain' : 'clear') },
    { label: 'Creative', get: () => game.player.mode === 'creative', set: (on) => game.setGameMode(on ? 'creative' : 'survival') },
    {
      label: '🎒 Give kit',
      run: () => {
        for (const [item, n] of [['iron_pickaxe', 1], ['iron_sword', 1], ['bow', 1], ['arrow', 32], ['oak_planks', 64], ['cobblestone', 64], ['glass', 16], ['torch', 16], ['bread', 8]] as const) giveItem(game, item, n);
        game.ui.toast('Kit added', { kind: 'good' });
      },
    },
    {
      label: '🗺 Reset map',
      run: () => confirmResetMap(game),
    },
    {
      label: '🧽 Reset memory',
      run: () => {
        const base = lf.settings.world.replace(/-r\d+$/, '');
        const next = `${base}-r${Date.now().toString(36).slice(-5)}`;
        lf.client.setPlayer(lf.settings.player, next);
        try {
          localStorage.setItem(`lc.lf.world.${game.seedText}`, next);
        } catch {
          /* no storage */
        }
        village.setPosture('calm');
        village.setPriceMult(1);
        getHub().nickname = null;
        d.brain.clear();
        game.ui.toast(`Village memory reset (new Liveforge world ${next})`, { kind: 'good', seconds: 4 });
      },
    },
    {
      label: '📊 Dashboard',
      run: () => {
        const url = lf.settings.dashboard;
        if (!url) return void game.ui.toast('No dashboard URL (Liveforge is off)');
        const w = Math.floor(screen.availWidth / 2);
        window.open(url, 'liveforge-dashboard', `left=${w},top=0,width=${w},height=${screen.availHeight}`);
      },
    },
    { label: '🧠 Brain View', get: () => d.brain.isVisible, set: () => d.brain.toggle() },
    { label: 'Captions', get: () => d.captions.enabled, set: (on) => d.captions.setEnabled(on) },
    { label: '🔊 Voices', get: () => voices.enabled, set: (on) => (voices.enabled = on) },
    { label: `📼 ${lf.cassette}`, run: () => game.ui.toast(`Liveforge ${lf.status} · cassette ${lf.cassette}`) },
  ];
}
