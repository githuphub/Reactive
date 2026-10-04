/**
 * Forge a building: `builder.plan` turns a prompt into a Voxel DSL plan (the instant template at once, the AI plan as
 * the upgrade), which is expanded with Livecraft block ids into a blueprint item in the hotbar. The upgrade replaces
 * the plan of the same item. Offline, the SDK's local template planner answers.
 */
import type { AskResponse, VoxelVec } from '@liveforge/sdk';
import type { Game } from '../../game/game';
import { LC_ALIASES, LC_BLOCK_IDS } from '../build';
import type { LiveforgeService } from '../service';
import { getHub } from '../hub';
import { putInHotbar } from '../forge/hotbar';
import { blueprintId, mainColors, registerBlueprint, type LcBlueprint } from './registry';

/** Hooks back into the Forge screen. */
export interface DraftUi {
  status(text: string): void;
  card(bp: LcBlueprint): void;
}

const TOWER = /\b(tower|turret|lighthouse|spire|watchtower|belfry|minaret|obelisk|column|pillar)\b/i;
const GRAND = /\b(castle|fortress|palace|cathedral|temple|citadel|keep|manor|mansion|arena|colosseum|pyramid|ziggurat)\b/i;

/**
 * Site [x, y, z] for a prompt: generous (24³) for grand buildings; towers stay slim and tall so the rules template
 * isn't a 24-wide drum; everything else gets a roomy house plot.
 */
export function siteFor(prompt: string): VoxelVec {
  if (GRAND.test(prompt)) return [24, 24, 24];
  if (TOWER.test(prompt)) return [11, 24, 11];
  return [16, 20, 16];
}

const CONTEXT = `Livecraft, a Minecraft-style voxel world. The player places this blueprint on open ground and it builds itself; y = 0 is the floor layer on top of the ground, the front (door) faces north. Use only Livecraft block ids: ${LC_BLOCK_IDS.join(', ')}.`.slice(0, 2000);

const isLocal = (r: AskResponse<'builder.plan'>) => r.ms === 0 && /local fallback|fallback answer|server unreachable|bake pack|cached answer/.test(r.why ?? '');

export class BlueprintForge {
  private busy = false;

  constructor(private readonly game: Game, private readonly lf: LiveforgeService, private readonly ui: DraftUi) {}

  /** Drafts a blueprint from a prompt; resolves with the spec in the hotbar (the AI refinement may follow). */
  async draft(prompt: string): Promise<LcBlueprint | null> {
    const text = prompt.trim().slice(0, 600);
    if (!text || this.busy) return null;
    this.busy = true;
    this.ui.status('📐 Drafting the blueprint…');
    const site = siteFor(text);
    const t0 = performance.now();
    try {
      const h = this.lf.client.builder.plan(
        { prompt: text, site: { size: site, ground: 'grass' }, context: CONTEXT },
        this.lf.status === 'offline' ? { timeoutMs: 1200 } : {},
      );
      let first: AskResponse<'builder.plan'>;
      try {
        first = await h.instant;
      } catch (err) {
        this.ui.status(`No plan: ${(err as Error).message}`);
        return null;
      }
      const source = isLocal(first) ? 'rules' : first.source;
      const bp = this.make(text, site, first, source, 0);
      if (!bp) {
        this.ui.status('The plan came out empty: try another description');
        return null;
      }
      this.give(bp, false, performance.now() - t0);
      h.onUpgrade((u) => {
        const cur = this.make(text, site, u, u.source, bp.version + 1);
        if (!cur) return;
        this.give(cur, true, performance.now() - t0);
        this.game.ui.toast('📐 Blueprint refined by AI', { kind: 'good', seconds: 4 });
      });
      return bp;
    } finally {
      this.busy = false;
    }
  }

  private make(prompt: string, site: VoxelVec, r: AskResponse<'builder.plan'>, source: string, version: number): LcBlueprint | null {
    const plan = r.result?.plan;
    if (!plan) return null;
    const ex = this.lf.client.builder.expand(plan, { site, blockIds: LC_BLOCK_IDS, aliases: LC_ALIASES, fallback: 'oak_planks' });
    if (!ex.blocks.some((b) => b.block !== 'air')) return null;
    const name = (plan.name ?? '').trim().slice(0, 48) || prompt.slice(0, 48);
    return {
      id: blueprintId(prompt),
      name,
      prompt,
      summary: r.result.summary || `${name}: ${ex.blocks.length} blocks`,
      plan,
      blocks: ex.blocks,
      materials: ex.materials,
      site: [site[0], site[1], site[2]],
      colors: mainColors(ex.materials),
      source,
      version,
    };
  }

  private give(bp: LcBlueprint, refined: boolean, ms: number): void {
    registerBlueprint(bp);
    this.game.save.markDirty('lf_forge');
    const stack = { item: bp.id, count: 1, data: { name: bp.name, tags: ['blueprint'], colors: bp.colors.slice(0, 2) } };
    const held = this.game.inventory.slots.findIndex((s) => s?.item === bp.id);
    if (refined && held >= 0) this.game.inventory.set(held, stack);
    else putInHotbar(this.game, stack, bp.id);
    const blocks = bp.blocks.filter((b) => b.block !== 'air').length;
    const top = Object.entries(bp.materials).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${v} ${k}`).join(', ');
    const model = bp.source === 'ai' ? (this.lf.cassette === 'REPLAY' ? 'replay' : 'sonnet') : bp.source === 'cache' ? 'cache' : 'rules';
    this.lf.think({
      source: 'forge', actor: 'forge', kind: 'plan', model, ms: Math.round(ms),
      text: `${refined ? 'Refined blueprint' : 'Blueprint'} ${bp.name}: ${blocks} blocks (${top})${bp.summary ? ` · ${bp.summary}` : ''}`.slice(0, 1000),
      data: { prompt: bp.prompt, plan: bp.plan, materials: bp.materials, site: bp.site },
    });
    this.lf.signal('item.forged', { item: bp.id, name: bp.name });
    getHub().caption(`📐 Blueprint: ${bp.name} (${blocks} blocks) — hold it, R rotates, right-click builds`, 6);
    this.ui.card(bp);
    this.ui.status(refined ? '✨ Refined by the AI architect' : bp.source === 'rules' ? 'Drafted (rules template). The AI design may follow…' : 'Drafted');
    if (!refined) this.game.ui.toast(`Blueprint: ${bp.name}`, { kind: 'good' });
  }
}
