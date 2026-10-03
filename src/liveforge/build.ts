/**
 * The `build` agent tool and the statue: `builder.plan` (instant template → shown at once; the AI plan replaces it
 * if it arrives before building starts) → `expandVoxelPlan` with Livecraft's block ids → the villager's
 * `buildPlan` at Bram's plot (or a site), with progress reported back to the agent loop and a ghost preview.
 */
import type { AgentToolContext, AskResponse, VoxelPlan, VoxelVec } from '@liveforge/sdk';
import type { Game } from '../game/game';
import { BLOCK_IDS } from '../engine/blocks';
import { village } from '../village';
import { PlanGhost } from './ghost';
import type { LiveforgeService } from './service';

/** Livecraft block ids for plan expansion (no air / liquids). */
export const LC_BLOCK_IDS: readonly string[] = BLOCK_IDS.filter((n) => n && n !== 'air' && n !== 'water' && n !== 'lava');

/** Extra words → block ids for AI plans (on top of the protocol defaults). */
export const LC_ALIASES: Record<string, string> = {
  thatch: 'hay_bale', hay: 'hay_bale', straw: 'hay_bale', lantern: 'glow_lamp', lamp: 'glow_lamp', path: 'dirt_path',
  wool: 'white_wool', wood: 'oak_planks', planks: 'oak_planks', log: 'oak_log', logs: 'oak_log', brick: 'bricks',
  stone_brick: 'stone_bricks', cobble: 'cobblestone', roof_tiles: 'bricks', shingles: 'spruce_planks', window: 'glass',
  glass_pane: 'glass', fence: 'oak_log', slab: 'oak_planks', stairs: 'oak_planks', stone_stairs: 'cobblestone',
  oak_stairs: 'oak_planks', dark_oak_planks: 'spruce_planks', dark_oak_log: 'spruce_log', marble: 'white_wool', granite: 'stone',
};

let buildCount = 0;

export interface BuildInput {
  prompt?: string;
  site?: string;
  width?: number;
  depth?: number;
  height?: number;
}

/** Result summary the agent sees (short JSON). */
export interface BuildSummary {
  ok: boolean;
  name: string;
  placed: number;
  total: number;
  skipped?: number;
  source: string;
  materials: string;
  detail?: string;
}

const isLocal = (r: AskResponse<'builder.plan'>) => r.ms === 0 && /local fallback|fallback answer|server unreachable|bake pack|cached answer/.test(r.why ?? '');

const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

const topMaterials = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${v} ${k}`).join(', ');

/**
 * Runs a build for an NPC (default Bram) from a prompt. Used by the agent `build` tool and the demo.
 * Never throws: failures come back as `{ok: false, detail}`.
 */
export async function runBuild(game: Game, lf: LiveforgeService, npcId: string, input: BuildInput, tctx?: Partial<AgentToolContext>): Promise<BuildSummary> {
  const prompt = String(input.prompt ?? '').trim().slice(0, 600) || 'a cosy house';
  const ctl = village.controller(npcId);
  if (!ctl) return { ok: false, name: prompt, placed: 0, total: 0, source: 'none', materials: '', detail: `no villager ${npcId}` };
  if (/\b(repair|fix|mend|rebuild|restore|patch)\b/i.test(prompt)) return repairBuild(lf, npcId, prompt, tctx);
  const plot = village.plots[0];
  let origin: { x: number; y: number; z: number } | null = plot?.origin ?? null;
  let size: VoxelVec = plot ? [plot.size[0], plot.size[1], plot.size[2]] : [14, 16, 10];
  if (input.site && !/^(plot|bram_plot|my plot|here)$/i.test(input.site)) {
    const p = village.resolveTarget(input.site, ctl.npc)?.pos();
    if (p) {
      origin = { x: Math.floor(p.x) - Math.floor(size[0] / 2), y: Math.floor(p.y), z: Math.floor(p.z) - Math.floor(size[2] / 2) };
      size = [12, 14, 10];
    }
  }
  if (!origin) return { ok: false, name: prompt, placed: 0, total: 0, source: 'none', materials: '', detail: 'no build site' };
  size = [clampInt(input.width, 5, size[0], size[0]), clampInt(input.height, 5, size[1], size[1]), clampInt(input.depth, 5, size[2], size[2])];

  const started = performance.now();
  const handle = lf.ask('builder.plan', { prompt, site: { size, ground: 'dirt' }, npc: 'bram', context: 'Bram builds on his plot in Oakhollow, west of the plaza.' });
  let first: AskResponse<'builder.plan'>;
  try {
    first = await handle.instant;
  } catch (err) {
    return { ok: false, name: prompt, placed: 0, total: 0, source: 'none', materials: '', detail: `no plan: ${(err as Error).message}` };
  }
  let plan: VoxelPlan = first.result.plan;
  let source: string = isLocal(first) ? 'rules' : first.source;
  let materials = first.result.materials;
  if (isLocal(first)) {
    lf.think({ source: 'builder', actor: npcId, kind: 'plan', text: `${plan.name}: ${first.result.summary}`, model: 'rules', ms: Math.round(performance.now() - started), ref: tctx?.runId, data: { plan, materials, template: first.result.template } });
  }
  tctx?.progress?.(`plan ready: ${plan.name} (${source})`);

  // Walk to the site while the AI plan may still arrive; take it if it lands before the first block.
  let building = false;
  handle.onUpgrade((r) => {
    if (building || !r.result?.plan) return;
    plan = r.result.plan;
    materials = r.result.materials;
    source = r.source;
    tctx?.progress?.(`AI plan arrived: ${plan.name}`);
  });
  await ctl.walkTo(plot && origin === plot.origin ? 'bram_plot' : origin, { signal: tctx?.signal });
  if (!handle.settled && lf.online) {
    void ctl.emote('think', { seconds: 2 });
    const deadline = started + 15_000;
    while (!handle.settled && performance.now() < deadline && !tctx?.signal?.aborted) await sleep(250);
  }
  if (tctx?.signal?.aborted) return { ok: false, name: plan.name, placed: 0, total: 0, source, materials: '', detail: 'interrupted' };
  building = true;

  const expanded = lf.client.builder.expand(plan, { site: size, origin: [origin.x, origin.y, origin.z], blockIds: LC_BLOCK_IDS, aliases: LC_ALIASES, fallback: 'oak_planks' });
  if (!expanded.blocks.length) return { ok: false, name: plan.name, placed: 0, total: 0, source, materials: '', detail: 'the plan expanded to 0 blocks' };
  const ghost = new PlanGhost(game, expanded.blocks);
  lf.think({ source: 'builder', actor: npcId, kind: 'decision', text: `Building "${plan.name}" (${source}): ${expanded.blocks.length} blocks, bottom-up`, model: source === 'ai' ? 'sonnet' : source === 'replay' ? 'replay' : source === 'cache' ? 'cache' : 'rules', ref: tctx?.runId, data: { materials: expanded.materials, bounds: expanded.bounds, warnings: expanded.warnings.slice(0, 8) } });
  const id = `bram_build_${++buildCount}`;
  try {
    const res = await ctl.buildPlan(expanded, {
      blocksPerSecond: 6,
      signal: tctx?.signal,
      onProgress: (p) => tctx?.progress?.(`${p.action}: ${p.done}/${p.total}${p.detail ? ` ${p.detail}` : ''}`),
      registerAs: { id, owner: 'bram', kind: 'house', name: plan.name },
    });
    const d = (res.data ?? {}) as { placed?: number; skipped?: number; total?: number };
    return { ok: res.ok, name: plan.name, placed: d.placed ?? 0, total: d.total ?? expanded.blocks.length, ...(d.skipped ? { skipped: d.skipped } : {}), source, materials: topMaterials(expanded.materials ?? materials), detail: res.detail };
  } finally {
    ghost.dispose();
  }
}

/** Which damaged building a repair prompt means (Mara's house unless another building is named). */
function repairTarget(prompt: string): string | null {
  const state = village.state();
  const damaged = state.buildings.filter((b) => b.damaged > 0).sort((a, b) => b.damaged - a.damaged);
  const p = prompt.toLowerCase();
  const named = damaged.find((b) => p.includes(b.owner) || p.includes(b.id.replace(/_/g, ' ')) || p.includes(b.kind.replace(/_/g, ' ')));
  return named?.id ?? damaged[0]?.id ?? null;
}

/** Co-build: the villager puts back every missing block of a damaged building (bottom-up). */
async function repairBuild(lf: LiveforgeService, npcId: string, prompt: string, tctx?: Partial<AgentToolContext>): Promise<BuildSummary> {
  const id = repairTarget(prompt);
  const ctl = village.controller(npcId);
  if (!id || !ctl) return { ok: true, name: 'repair', placed: 0, total: 0, source: 'rules', materials: '', detail: 'nothing is broken right now' };
  const plan = village.repairPlan(id);
  const mats: Record<string, number> = {};
  for (const b of plan.blocks) mats[b.block] = (mats[b.block] ?? 0) + 1;
  lf.think({ source: 'builder', actor: npcId, kind: 'plan', text: `Repair ${id}: ${plan.blocks.length} missing blocks, bottom-up`, model: 'rules', ref: tctx?.runId, data: { materials: mats, plan: { name: `repair ${id}`, ops: [] } } });
  const res = await ctl.buildPlan({ blocks: plan.blocks }, { blocksPerSecond: 5, signal: tctx?.signal, onProgress: (p) => tctx?.progress?.(`${p.action}: ${p.done}/${p.total}`) });
  const d = (res.data ?? {}) as { placed?: number; total?: number };
  return { ok: res.ok, name: `repair ${id}`, placed: d.placed ?? 0, total: d.total ?? plan.blocks.length, source: 'rules', materials: topMaterials(mats), detail: `${res.detail} (${prompt.slice(0, 60)})` };
}

/** Statue colours [shirt, trousers, skin, hair] as real Livecraft block ids (the player's outfit). */
export function outfitPalette(): string[] {
  return ['green_wool', 'blue_wool', 'birch_planks', 'spruce_planks'];
}

/**
 * The village raises a statue of the player on the plaza: `builder.plan` "statue of <name>" with the outfit colours,
 * then the village places it block by block (Bram narrates).
 */
export async function raiseStatue(game: Game, lf: LiveforgeService, who: string, prompt?: string): Promise<boolean> {
  const spot = village.statueSpot;
  if (!spot) return false;
  const size: VoxelVec = [Math.max(5, spot.size[0]), Math.max(9, spot.size[1]), Math.max(5, spot.size[2])];
  const started = performance.now();
  const h = lf.ask('builder.plan', { prompt: (prompt ?? `a statue of ${who} in their outfit colours, on a stone plinth`).slice(0, 600), site: { size }, palette: outfitPalette(), npc: 'bram', style: 'statue' }, { upgrade: false });
  let r: AskResponse<'builder.plan'>;
  try {
    r = await h.instant;
  } catch {
    return false;
  }
  if (isLocal(r)) lf.think({ source: 'builder', actor: 'bram', kind: 'plan', text: `${r.result.plan.name}: ${r.result.summary}`, model: 'rules', ms: Math.round(performance.now() - started), data: { plan: r.result.plan, materials: r.result.materials } });
  const ex = lf.client.builder.expand(r.result.plan, { site: size, blockIds: LC_BLOCK_IDS, aliases: LC_ALIASES, fallback: 'stone_bricks' });
  if (!ex.blocks.length) return false;
  const bram = village.controller('bram');
  void bram?.walkTo('plaza').then(() => bram.say(`For ${who}, who mended what was broken.`, { emote: 'cheer' }));
  const o = spot.origin;
  const ghost = new PlanGhost(game, ex.blocks.map((b) => ({ ...b, x: b.x + o.x, y: b.y + o.y, z: b.z + o.z })));
  try {
    const res = await village.spawnStatue(ex, undefined, { blocksPerSecond: 30, name: `Statue of ${who}` });
    return res.ok;
  } finally {
    ghost.dispose();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
