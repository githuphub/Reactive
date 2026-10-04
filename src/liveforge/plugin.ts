/**
 * Liveforge integration plugin (lane V3): connects Livecraft to the Liveforge server through `@liveforge/sdk`.
 *
 * - Service + config (`?lf=`, `VITE_LIVEFORGE_URL`, default http://localhost:8790; game `livecraft`), offline-safe.
 * - Signals from game events (signals.ts), agent tools for every named villager (tools.ts, build.ts),
 *   chat + voice (talk.ts), proximity barks, directives (directives.ts), raids (raid.ts), quests (quests.ts),
 *   the grief/amends chain (amends.ts), forge-anything (forge/).
 * - UI: Brain View (B), Demo panel + captions + status badge (`?demo`, or "Demo" in the pause menu).
 *
 * Console: `lf` (the service), `lfHub`.
 */
import type { GamePlugin } from '../game/plugins';
import { BrainView } from '../ui/brain/brain-view';
import { Captions } from '../ui/demo/captions';
import { DemoPanel, StatusBadge } from '../ui/demo/demo-panel';
import { village } from '../village';
import { Amends } from './amends';
import { wireBarks } from './barks';
import { LC_BLOCK_IDS } from './build';
import { readSettings } from './config';
import { worldSummary } from './context';
import { wireDirectives } from './directives';
import { setHub, type LfHub, playerTitle } from './hub';
import { npcName } from './ids';
import { initQuests } from './quests';
import { RaidRunner } from './raid';
import { localBark, localReply } from './rules';
import { scenarioButtons, utilityButtons } from './scenarios';
import { LiveforgeService, setLiveforge } from './service';
import { wireSignals } from './signals';
import { Talk } from './talk';
import { registerAllTools } from './tools';
import { voices } from './voice';
import { initForge } from './forge/forge';

const plugin: GamePlugin = {
  name: 'liveforge',
  order: 50,
  init(game) {
    const settings = readSettings(game.seedText);
    const lf = new LiveforgeService(settings);
    setLiveforge(lf);
    voices.enabled = false; // spoken villager lines are off by default (🔊 Voices in the Demo panel turns them on)

    // offline answers + block ids for local build plans
    lf.client.builder.setBlockIds(LC_BLOCK_IDS);
    lf.client.setFallback('npc.reply', localReply);
    lf.client.setFallback('npc.bark', localBark);

    const habits = wireSignals(game, lf);
    const brain = new BrainView({ visible: settings.demo });
    const captions = new Captions(true);
    const hub: LfHub = {
      game,
      lf,
      habits,
      nickname: null,
      caption: (text, seconds) => captions.show(text, seconds),
      chatLine: () => {},
    };
    setHub(hub);
    lf.client.brain.subscribe((e) => brain.add(e));
    const badge = new StatusBadge();
    const syncBadge = () => {
      badge.set(lf.status, lf.cassette);
      brain.setStatus(`${lf.status} · ${lf.cassette}`);
    };
    lf.on('status', syncBadge);
    lf.on('cassette', syncBadge);
    syncBadge();

    initQuests(game, lf);
    const talk = new Talk(game, lf);
    hub.chatLine = (npc, text) => talk.npcLine(npc, text);
    const raid = new RaidRunner(game, lf);
    const amends = new Amends(game, lf);
    const forge = initForge(game, lf);
    wireDirectives(game, lf, amends, (d) => forge.onReady(d));
    wireBarks(game, lf, () => talk.current !== null);

    // agents: tools for every named villager (again whenever the server comes back), run summaries, world context
    void village.ready.then(() => registerAllTools(game, lf));
    lf.on('online', () => void village.ready.then(() => registerAllTools(game, lf)));
    lf.client.agents.onDone((d) => {
      game.ui.toast(`${npcName(d.npc)}: ${d.summary}`, { kind: d.ok ? 'good' : 'warn', seconds: 4 });
    });
    let lastContext = '';
    setInterval(() => {
      if (!game.ready || !lf.online) return;
      const text = worldSummary(game, playerTitle());
      if (text === lastContext) return;
      lastContext = text;
      void lf.client.agents.setContext('*', text).catch(() => {});
    }, 10_000);

    // demo panel + keys
    const deps = { game, lf, talk, raid, amends, openForge: (p?: string) => forge.open(p), brain, captions };
    const panel = new DemoPanel(scenarioButtons(deps), utilityButtons(deps), { visible: settings.demo });
    game.input.onKey((e) => {
      if (!game.ready || game.ui.screens.isOpen) return false;
      if (e.code === 'KeyB' && !e.repeat) {
        brain.toggle();
        return true;
      }
      if (e.code === 'KeyF' && !e.repeat) {
        forge.open();
        return true;
      }
      return false;
    });
    // "Demo" entry in the pause menu
    game.ui.screens.onChange(() => {
      const top = game.ui.screens.top;
      if (top?.id !== 'pause') return;
      const p = top.el.querySelector('.lc-panel');
      if (!p || p.querySelector('.lcx-demo-entry')) return;
      const b = document.createElement('button');
      b.className = 'lc-btn lcx-demo-entry';
      b.textContent = 'Demo panel · Brain View';
      b.addEventListener('click', () => {
        panel.setVisible(!panel.isVisible);
        if (panel.isVisible && !brain.isVisible) brain.setVisible(true);
      });
      p.insertBefore(b, p.children[2] ?? null);
    });

    (window as unknown as { lf: LiveforgeService; lfHub: LfHub }).lf = lf;
    (window as unknown as { lfHub: LfHub }).lfHub = hub;
  },
};

export default plugin;
