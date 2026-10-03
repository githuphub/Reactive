/**
 * Agent tools for every named villager, mapped onto V2's `VillagerController`. Names and schemas follow the
 * manifest allow-list (`agents.tools` in examples/livecraft.liveforge.yaml); inputs also accept the field names the
 * rules planner uses (`item` for `block`, `target` for `post`, `to` ...). Outputs are short JSON summaries; a
 * failed action throws, so the model sees `ok: false` with the reason.
 */
import type { AgentTool, AgentToolContext } from '@liveforge/sdk';
import type { Game } from '../game/game';
import { village, type ActionResult, type VillagerController } from '../village';
import { runBuild } from './build';
import { LF_NAMED, npcOf } from './ids';
import type { LiveforgeService } from './service';
import { speakAs } from './voice';

type In = Record<string, unknown>;

const str = (v: unknown, d = '') => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? d : String(v));
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

/** Manifest post / target words → something the village resolves. */
export function mapTarget(t: string): string {
  const k = t.toLowerCase().trim();
  if (!k || k === 'me' || k === 'you' || k === 'the player' || k.startsWith('player')) return 'player';
  if (k.startsWith('home:')) {
    const who = npcOf(k.slice(5));
    const home = who?.def.home;
    return home ?? 'plaza';
  }
  if (/plot|site/.test(k)) return 'bram_plot';
  if (/square|plaza|centre|center/.test(k)) return 'plaza';
  if (/wall|gate/.test(k)) return 'gate';
  if (/tower/.test(k)) return 'tower';
  if (/yard|pile/.test(k)) return 'yard';
  if (/mara.*house|house.*mara/.test(k)) return 'mara_house';
  if (/farm|field|wheat/.test(k)) return 'farm';
  if (/well/.test(k)) return 'well';
  return k.replace(/\s+/g, '_');
}

function must(r: ActionResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (!r.ok) throw new Error(r.detail);
  return { ok: true, detail: r.detail, ...extra };
}

const OBJ = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });

/** The tool set for one villager. */
export function villagerTools(game: Game, lf: LiveforgeService, npcId: string): AgentTool[] {
  const ctl = (): VillagerController => {
    const c = village.controller(npcId);
    if (!c) throw new Error(`${npcId} is not in the village right now`);
    return c;
  };
  const opts = (c: AgentToolContext) => ({ signal: c.signal, onProgress: (p: { action: string; done: number; total: number; detail?: string }) => c.progress(`${p.action} ${p.done}/${p.total}${p.detail ? ` ${p.detail}` : ''}`) });
  const golem = npcId === 'iron_golem';

  return [
    {
      name: 'walk_to',
      description: "Walk to a place: a named spot (plaza/square, well, gate/walls, tower, farm, yard, bram_plot, mara_house, a building id), an NPC id, 'player', or x,y,z.",
      schema: OBJ({ target: { type: 'string', description: 'spot name, npc id or player' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, ['target']),
      run: async (i: In, c) => {
        const target = i.x !== undefined && i.z !== undefined ? { x: num(i.x, 0), y: num(i.y, game.player.position.y), z: num(i.z, 0) } : mapTarget(str(i.target, 'player'));
        return must(await ctl().walkTo(target, opts(c)));
      },
    },
    {
      name: 'look_at',
      description: 'Turn to look at someone or something.',
      schema: OBJ({ target: { type: 'string' } }, ['target']),
      run: async (i: In, c) => must(await ctl().lookAt(mapTarget(str(i.target, 'player')), opts(c))),
    },
    {
      name: 'mine',
      description: 'Mine blocks of one type nearby (they go into your bag).',
      schema: OBJ({ block: { type: 'string' }, count: { type: 'integer' } }, ['block', 'count']),
      run: async (i: In, c) => must(await ctl().gather(str(i.block ?? i.item, 'stone'), Math.min(16, num(i.count, 1)), { ...opts(c), fromWorld: true })),
    },
    {
      name: 'place',
      description: 'Place one block at x,y,z.',
      schema: OBJ({ block: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }, plan: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } }, []),
      run: async (i: In, c) => {
        if (i.x === undefined || i.z === undefined) throw new Error('place needs x, y, z (use build for whole structures)');
        return must(await ctl().place({ x: num(i.x, 0), y: num(i.y, 0), z: num(i.z, 0) }, str(i.block, 'oak_planks'), opts(c)));
      },
    },
    {
      name: 'gather',
      description: 'Gather a material (planks, cobblestone, bricks, logs, glass, wheat, stone ...) from the yard, the farm or the world.',
      schema: OBJ({ block: { type: 'string' }, count: { type: 'integer' } }, ['block', 'count']),
      run: async (i: In, c) => must(await ctl().gather(str(i.block ?? i.item, 'oak_planks'), Math.min(64, num(i.count, 8)), opts(c))),
    },
    {
      name: 'give',
      description: 'Give the player (or another villager) an item.',
      schema: OBJ({ item: { type: 'string' }, count: { type: 'integer' } }, ['item']),
      run: async (i: In, c) => must(await ctl().give(str(i.item, 'bread'), Math.min(64, num(i.count, 1)), mapTarget(str(i.to, 'player')), opts(c))),
    },
    {
      name: 'take',
      description: 'Take an item the player offers.',
      schema: OBJ({ item: { type: 'string' }, count: { type: 'integer' } }, ['item']),
      run: async (i: In, c) => must(await ctl().take(str(i.item, 'coins'), Math.min(64, num(i.count, 1)), mapTarget(str(i.from, 'player')), opts(c))),
    },
    {
      name: 'follow',
      description: "Follow someone (usually 'player') until told to stop.",
      schema: OBJ({ target: { type: 'string' } }, ['target']),
      run: async (i: In, c) => must(await ctl().follow(mapTarget(str(i.target, 'player')), { ...opts(c), distance: 3 })),
    },
    {
      name: 'say',
      description: 'Say a line out loud (speech bubble + voice). Keep it short.',
      schema: OBJ({ text: { type: 'string' } }, ['text']),
      run: async (i: In, c) => {
        const text = str(i.text).slice(0, 300);
        if (golem) return must(await ctl().emote('creak', opts(c)));
        speakAs(lf, npcId, text);
        return must(await ctl().say(text, opts(c)));
      },
    },
    {
      name: 'emote',
      description: 'Play an emote: wave, nod, shake, think, cheer, hammer, glare, stare, laugh, shrug, bow (golem: creak, stamp, offer_flower).',
      schema: OBJ({ name: { type: 'string' } }, ['name']),
      run: async (i: In, c) => must(await ctl().emote(str(i.name ?? i.emote, 'nod'), opts(c))),
    },
    {
      name: 'build',
      description: 'Plan a structure with builder.plan, then gather the materials and place it bottom-up on your plot (or at site). Returns what was built.',
      schema: OBJ({ prompt: { type: 'string' }, width: { type: 'integer' }, depth: { type: 'integer' }, height: { type: 'integer' } }, ['prompt']),
      run: async (i: In, c) => {
        const r = await runBuild(game, lf, npcId === 'bram' ? 'bram' : npcId, { prompt: str(i.prompt), site: str(i.site) || undefined, width: i.width as number, depth: i.depth as number, height: i.height as number }, c);
        if (!r.ok) throw new Error(r.detail ?? 'the build failed');
        return r;
      },
    },
    {
      name: 'trade',
      description: 'Open a trade with the player at a price multiplier (1 = normal).',
      schema: OBJ({ priceMultiplier: { type: 'number' } }, ['priceMultiplier']),
      run: async (i: In, c) => must(await ctl().trade({ ...opts(c), priceMultiplier: Math.max(0.5, Math.min(2.5, num(i.priceMultiplier, 1))) })),
    },
    {
      name: 'guard',
      description: 'Stand guard at a post (gate, square, well, farm, walls, tower, home:<npc>, player).',
      schema: OBJ({ post: { type: 'string' } }, ['post']),
      run: async (i: In, c) => must(await ctl().guard(mapTarget(str(i.post ?? i.target, 'gate')), opts(c))),
    },
    {
      name: 'wait',
      description: 'Wait a few seconds.',
      schema: OBJ({ seconds: { type: 'number' } }, ['seconds']),
      run: async (i: In, c) => must(await ctl().wait(Math.min(30, num(i.seconds, 2)), opts(c))),
    },
  ];
}

/** Registers the tools for every named villager (call on start and again whenever the server comes back). */
export async function registerAllTools(game: Game, lf: LiveforgeService): Promise<void> {
  for (const id of LF_NAMED) {
    try {
      await lf.client.agents.register(id, villagerTools(game, lf, id));
    } catch (err) {
      console.warn(`[liveforge] agents.register(${id}) failed`, err);
    }
  }
}
