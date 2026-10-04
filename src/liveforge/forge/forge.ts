/**
 * Forge anything → voxel items. The Forge screen (F, or the Demo button) takes a prompt (typed or hold-🎤) and an
 * optional base tool; `forge.item` returns a ForgedItem (rules instantly, Sonnet as the upgrade), which becomes a
 * Livecraft item: a 16×16 icon (rules pixel art from the palette, or the AI's pixel grid), an extruded voxel held
 * model, tool stats, an effect from the enum and a crafting recipe. It lands in the hotbar.
 * The Building tab drafts a blueprint item instead (`builder.plan`, see ../blueprint/).
 */
import { rulesForgedThing, type Directive, type ForgedItem, type ForgedThing } from '@liveforge/sdk';
import type { Game } from '../../game/game';
import { findItem, type ToolSpec } from '../../engine/items';
import type { Screen } from '../../ui/ui';
import { getHub } from '../hub';
import { getQuests } from '../quests';
import type { LiveforgeService } from '../service';
import { getMic } from '../voice';
import { blueprintCard } from '../blueprint/card';
import { BlueprintForge } from '../blueprint/draft';
import { allBlueprints, registerBlueprint, type LcBlueprint } from '../blueprint/registry';
import { wireEffects } from './effects';
import { putInHotbar } from './hotbar';
import { pixelsFromGrid, pixelsToCanvas, type ToolShape } from './pixel';
import { EFFECTS, allForged, forgedPixels, forgedSpec, registerForged, type ForgeEffect, type LcForged } from './registry';
import { getBuffs, type BuffEffect } from './buffs';
import { Creatures } from './creatures';
import { Decorations } from './decorations';
import { Vehicles } from './vehicles/vehicle';
import { getWearables } from './wearables';
import { allThings, initThings, onThingChanged, recipeKnown, registerThing, thingItemId, thingPreview, thingSpec, updateThing, useOf, type LcThing } from './things';

const SHAPES: ToolShape[] = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword', 'hammer', 'spear', 'staff', 'bow'];

const KIND: Record<ToolShape, ToolSpec['kind']> = { pickaxe: 'pickaxe', hammer: 'pickaxe', axe: 'axe', shovel: 'shovel', hoe: 'hoe', sword: 'sword', spear: 'sword', staff: 'sword', bow: 'sword' };

const STYLE: Record<string, { words: RegExp; effect: ForgeEffect; palette: [string, string, string, string]; prefix: string[] }> = {
  lightning: { words: /lightning|thunder|storm|spark|electric|volt|zap/i, effect: 'chain_lightning', palette: ['#ffe066', '#3a2b5a', '#ffffff', '#7fd8ff'], prefix: ['Stormcaller', 'Thunderbite', 'Sparkfang'] },
  fire: { words: /fire|flame|lava|ember|blaze|inferno|magma|sun/i, effect: 'fire_trail', palette: ['#d9481e', '#3b2414', '#ffb347', '#ffd04a'], prefix: ['Emberfall', 'Blazeheart', 'Cinderbite'] },
  ice: { words: /ice|frost|snow|cold|winter|glacier|freez/i, effect: 'frost_slow', palette: ['#9fd8ff', '#5a6b8c', '#ffffff', '#e0f6ff'], prefix: ['Frostbite', 'Rimeclaw', 'Wintersong'] },
  nature: { words: /heal|life|nature|leaf|bloom|flower|vine|grow|spring/i, effect: 'heal_aura', palette: ['#5fbf4a', '#6b4a2a', '#e8f5c8', '#a8ff9a'], prefix: ['Bloomward', 'Lifethorn', 'Greenheart'] },
  earth: { words: /vein|ore|miner|greed|gold|gem|crystal|diamond|earth|deep/i, effect: 'vein_mine', palette: ['#8fe3e0', '#6b3d1e', '#ffd700', '#ffcf40'], prefix: ['Veinseeker', 'Deepdelver', 'Gemhound'] },
  wind: { words: /wind|gust|push|boom|blast|shock|quake|force|bounce/i, effect: 'knockback_burst', palette: ['#c0c6d0', '#4a3520', '#ffffff', '#bfe3ff'], prefix: ['Galebreaker', 'Thunderclap', 'Skyshove'] },
};

const ELEMENT_STYLE: Record<string, string> = { lightning: 'lightning', fire: 'fire', ice: 'ice', nature: 'nature', physical: 'wind' };

const CATALYST: Record<ForgeEffect, string> = { chain_lightning: 'redstone', fire_trail: 'coal', vein_mine: 'diamond', knockback_burst: 'gunpowder', heal_aura: 'apple', frost_slow: 'ice' };
const BASE_BY_TIER = ['oak_planks', 'oak_planks', 'cobblestone', 'iron_ingot', 'diamond'];

let counter = 0;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'item';
const hex = (v: unknown, d: string) => (typeof v === 'string' && /^#?[0-9a-f]{3,8}$/i.test(v) ? (v.startsWith('#') ? v : `#${v}`).slice(0, 7) : d);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function shapeOf(family: string | undefined, prompt: string): ToolShape {
  const f = (family ?? '').toLowerCase();
  const fromFamily = SHAPES.find((s) => f.includes(s)) ?? (f.includes('crossbow') ? 'bow' : undefined);
  if (fromFamily) return fromFamily;
  return SHAPES.find((s) => new RegExp(`\\b${s}`, 'i').test(prompt)) ?? (/blade|sabre|saber|katana|dagger/i.test(prompt) ? 'sword' : /mace|maul/i.test(prompt) ? 'hammer' : /wand|rod/i.test(prompt) ? 'staff' : 'pickaxe');
}

function styleOf(prompt: string, element?: string, tags: readonly string[] = []): (typeof STYLE)[string] {
  const tagged = EFFECTS.find((e) => tags.includes(e));
  if (tagged) return Object.values(STYLE).find((s) => s.effect === tagged)!;
  const byWord = Object.values(STYLE).find((s) => s.words.test(prompt));
  if (byWord) return byWord;
  return STYLE[ELEMENT_STYLE[element ?? ''] ?? 'wind'];
}

function recipeFor(shape: ToolShape, effect: ForgeEffect | null, tier: number): LcForged['recipe'] {
  const key: Record<string, string> = { M: BASE_BY_TIER[Math.max(1, Math.min(4, tier))], S: 'stick', X: effect ? CATALYST[effect] : 'iron_ingot' };
  const pattern: Record<ToolShape, string[]> = {
    pickaxe: ['MXM', ' S ', ' S '], hammer: ['MXM', 'MSM', ' S '], axe: ['MX', 'MS', ' S'], shovel: ['X', 'M', 'S'],
    hoe: ['MX', ' S', ' S'], sword: ['X', 'M', 'S'], spear: ['  X', ' M ', 'S  '], staff: [' X ', ' S ', ' S '], bow: [' XS', 'M S', ' XS'],
  };
  const p = pattern[shape];
  for (const k of Object.keys(key)) if (!p.some((row) => row.includes(k))) delete key[k];
  return { pattern: p, key };
}

/** ForgedItem (server) → Livecraft spec. */
export function fromForged(item: ForgedItem, prompt: string, familyHint: string | undefined, source: string): LcForged {
  const shape = shapeOf(item.family ?? familyHint, `${prompt} ${item.name}`);
  const style = styleOf(`${prompt} ${item.name} ${item.flavor}`, item.element, item.tags ?? []);
  const effect = (EFFECTS.find((e) => (item.tags ?? []).includes(e)) ?? style.effect) as ForgeEffect;
  const bp = item.blueprint;
  const glow = hex(bp.particles?.color ?? bp.trail?.color ?? bp.palette[3], style.palette[3]);
  const mining = num(item.stats.mining, 8);
  const tier = mining >= 15 ? 4 : mining >= 9 ? 3 : mining >= 4 ? 2 : 1;
  const grid = (item as unknown as { pixels?: unknown }).pixels ?? (bp as unknown as { pixels?: unknown }).pixels;
  return {
    id: `forged_${slug(item.name)}_${++counter}`,
    name: item.name,
    flavor: item.flavor,
    shape,
    kind: KIND[shape],
    tier: Math.max(tier, 2),
    stats: { speed: num(item.stats.speed, 10), damage: num(item.stats.damage, 6), durability: num(item.stats.durability, 500), mining },
    effect,
    palette: [hex(bp.palette[0], style.palette[0]), hex(bp.palette[1], style.palette[1]), hex(bp.palette[2], style.palette[2]), glow],
    ...(Array.isArray(grid) ? { grid: (grid as unknown[]).map(String).slice(0, 16) } : {}),
    recipe: recipeFor(shape, effect, Math.max(tier, 2)),
    source,
    seed: [...item.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 17),
  };
}

/** Offline rules forge (no server): the same mapping from prompt words. */
export function localForge(prompt: string, familyHint?: string): LcForged {
  const shape = shapeOf(familyHint, prompt);
  const style = styleOf(prompt);
  const seed = [...prompt].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 23);
  const name = `${style.prefix[Math.abs(seed) % style.prefix.length]} ${shape[0].toUpperCase()}${shape.slice(1)}`;
  const strong = /legend|ancient|god|epic|mythic|ultimate/i.test(prompt);
  return {
    id: `forged_${slug(name)}_${++counter}`,
    name,
    flavor: `Forged from "${prompt.slice(0, 80)}". It hums when you hold it.`,
    shape,
    kind: KIND[shape],
    tier: strong ? 4 : 3,
    stats: { speed: strong ? 16 : 12, damage: strong ? 12 : 8, durability: strong ? 1200 : 600, mining: strong ? 16 : 10 },
    effect: style.effect,
    palette: style.palette,
    recipe: recipeFor(shape, style.effect, strong ? 4 : 3),
    source: 'rules',
    seed,
  };
}

/** What the Forge screen makes: a voxel item, or a building blueprint. */
export type ForgeMode = 'item' | 'building';

/** The `lf_forge` save slot: forged items, then blueprints (older saves are a plain item array). */
type ForgeSave = LcForged[] | { items?: LcForged[]; blueprints?: LcBlueprint[]; things?: LcThing[] };

const CATEGORY_ICON: Record<string, string> = { weapon: '⚔', tool: '⛏', food: '🍖', creature: '🐾', wearable: '🎩', decoration: '🏺', material: '🧱', block: '🧊', vehicle: '🚂' };
const RARITY_COLOR: Record<string, string> = { common: '#cfcfcf', uncommon: '#6fdc6f', rare: '#5aa8ff', epic: '#c77dff', legendary: '#ffb829' };
const USE_HINT: Record<string, string> = {
  weapon: 'hit things with it', tool: 'mine with it', food: 'hold right-click to eat', creature: 'right-click a block to hatch it',
  wearable: 'right-click to wear it (F5 to see)', decoration: 'right-click to place · R rotates · left-click picks it up',
  material: 'a crafting material', block: 'right-click to place · left-click picks it up', vehicle: 'right-click to place · right-click / E to ride',
};

export class Forge {
  private screen: Screen | null = null;
  private input!: HTMLInputElement;
  private family!: HTMLSelectElement;
  private card!: HTMLElement;
  private status!: HTMLElement;
  private title!: HTMLElement;
  private go!: HTMLButtonElement;
  private readonly tabs: Partial<Record<ForgeMode, HTMLButtonElement>> = {};
  private mode: ForgeMode = 'item';
  private busy = false;
  private readonly blueprints: BlueprintForge;

  constructor(private readonly game: Game, private readonly lf: LiveforgeService) {
    wireEffects(game);
    initThings(game);
    const buffs = getBuffs(game);
    getWearables(game);
    const creatures = new Creatures(game);
    const decor = new Decorations(game);
    const vehicles = new Vehicles(game);
    onThingChanged((t, replaced) => {
      if (!replaced) return;
      creatures.refresh(t);
      decor.refresh(t);
      vehicles.refresh(t);
    });
    game.events.on('playerAte', (e) => {
      const t = thingSpec(e.item);
      if (t && t.thing.effect !== 'none') {
        buffs.grant(t.thing.effect as BuffEffect, 30);
        game.ui.toast(`${t.thing.name}: ${t.thing.effect.replace(/_/g, ' ')} for 30 s`, { kind: 'good' });
      }
    });
    this.blueprints = new BlueprintForge(game, lf, {
      status: (s) => this.setStatus(s),
      card: (bp) => this.showCard(blueprintCard(bp)),
    });
    const save = (): ForgeSave => ({ items: allForged().map((s) => ({ ...s })), blueprints: allBlueprints().map((b) => ({ ...b })), things: allThings().map((t) => ({ ...t })) });
    game.save.register('lf_forge', save, (saved: ForgeSave) => {
      const items = Array.isArray(saved) ? saved : saved?.items ?? [];
      const blueprints = Array.isArray(saved) ? [] : saved?.blueprints ?? [];
      const things = Array.isArray(saved) ? [] : saved?.things ?? [];
      for (const t of things) {
        try {
          registerThing(t);
        } catch (err) {
          console.warn('[forge] saved thing skipped', err);
        }
      }
      for (const s of items) {
        counter = Math.max(counter, Number(/_(\d+)$/.exec(s.id)?.[1] ?? 0));
        registerForged(s, s.grid ? pixelsFromGrid(s.grid, [...s.palette]) : null);
      }
      for (const b of blueprints) registerBlueprint(b);
      // the inventory loaded before these items existed (unknown stacks were dropped): load it again
      const inv = game.save.get('inventory') as Parameters<Game['inventory']['deserialize']>[0] | undefined;
      if ((items.length || blueprints.length || things.length) && inv) game.inventory.deserialize(inv);
    });
  }

  /** Opens the Forge screen (optionally pre-filled, optionally in a mode). */
  open(prefill = '', mode?: ForgeMode): void {
    const first = !this.screen;
    if (!this.screen) this.screen = this.build();
    if (mode || first) this.setMode(mode ?? this.mode);
    if (prefill) this.input.value = prefill;
    if (!this.game.ui.screens.has('lf-forge')) this.game.ui.screens.open(this.screen);
    setTimeout(() => this.input.focus(), 30);
  }

  /** Item or Building: the title, placeholder, base-tool picker, button and hint follow. */
  setMode(mode: ForgeMode): void {
    if (mode !== this.mode && this.card) this.card.style.display = 'none';
    this.mode = mode;
    if (!this.screen) return;
    const building = mode === 'building';
    this.title.textContent = building ? '🏰 FORGE A BUILDING' : '⚒ FORGE ANYTHING';
    this.input.placeholder = building ? 'Describe a building… e.g. a wizard tower with a spiral staircase' : 'Describe anything… e.g. a fluffy chicken, a steam train, a lantern';
    this.family.style.display = 'none';
    this.go.textContent = building ? 'Draft' : 'Forge';
    for (const [m, b] of Object.entries(this.tabs)) b?.classList.toggle('on', m === mode);
    this.setStatus(building ? 'Enter — draft a blueprint · it goes to your hotbar · hold it: R rotates, right-click builds (free)' : 'Enter — forge · 🎤 hold — speak · the item goes to your hotbar');
  }

  /**
   * Forges anything from a prompt (`forge.thing`, no category forcing): the rules thing lands in the hotbar at once,
   * the AI version replaces it in place (same item id) when it arrives. Resolves with the thing record.
   */
  async forge(prompt: string, _family?: string): Promise<LcThing | null> {
    const text = prompt.trim().slice(0, 400);
    if (!text || this.busy) return null;
    this.busy = true;
    this.setStatus('⚒ Forging…');
    const t0 = performance.now();
    try {
      let rec: LcThing;
      try {
        const h = this.lf.ask('forge.thing', { prompt: text, context: { game: 'livecraft', world: 'voxel sandbox' } });
        const r = await h.instant;
        rec = this.recordOf(r.result as ForgedThing, text, r.source);
        const id = rec.id;
        h.onUpgrade((u) => {
          try {
            this.giveThing({ ...this.recordOf(u.result as ForgedThing, text, u.source), id }, true, performance.now() - t0);
          } catch (err) {
            console.warn('[forge] upgrade failed', err);
          }
        });
      } catch {
        rec = this.recordOf(rulesForgedThing({ prompt: text }), text, 'local');
      }
      this.giveThing(rec, false, performance.now() - t0);
      return rec;
    } finally {
      this.busy = false;
    }
  }

  private recordOf(thing: ForgedThing, prompt: string, source: string): LcThing {
    return { id: thingItemId(thing), kind: 'thing', thing, prompt, source, version: 0 };
  }

  private giveThing(rec: LcThing, upgrade: boolean, ms: number): void {
    if (upgrade && thingSpec(rec.id)) updateThing(rec);
    else registerThing(rec);
    const t = thingSpec(rec.id) ?? rec;
    this.game.save.markDirty('lf_forge');
    const th = t.thing;
    const use = useOf(t);
    if (!upgrade) putInHotbar(this.game, { item: t.id, count: 1 });
    const model = t.source === 'ai' ? (this.lf.cassette === 'REPLAY' ? 'replay' : 'sonnet') : t.source === 'cache' ? 'cache' : t.source === 'replay' ? 'replay' : 'rules';
    const statLine = Object.entries(th.stats).filter(([k, v]) => v && k !== 'stackSize').map(([k, v]) => `${k} ${v}`).join(' · ');
    this.lf.think({
      source: 'forge', actor: 'forge', kind: 'plan', model, ms: Math.round(ms),
      text: `${upgrade ? 'Refined' : 'Forged'} ${th.name} (${th.category}, ${th.rarity}): ${th.description}${statLine ? ` · ${statLine}` : ''}${th.vehicle ? ` · ${th.vehicle.mode} ${th.vehicle.speed} b/s` : ''}${th.creature ? ` · ${th.creature.behaviour}` : ''}`,
      data: { thing: th },
    });
    if (!upgrade) {
      this.lf.signal('item.forged', { item: t.id, name: th.name, category: th.category });
      try {
        getQuests().noteForged();
      } catch {
        /* quests not ready */
      }
    }
    getHub().caption(`${CATEGORY_ICON[use] ?? '⚒'} ${th.name} (${th.category}): ${USE_HINT[use] ?? 'in your hotbar'}`, 6);
    this.renderThingCard(t);
    this.setStatus(upgrade ? '✨ Refined by AI' : t.source === 'rules' || t.source === 'local' ? 'Forged (rules). The AI design may follow…' : 'Forged');
    if (upgrade) this.game.ui.toast(`✨ Refined by AI: ${th.name}`, { kind: 'good', seconds: 4 });
    else this.game.ui.toast(`Forged: ${th.name}`, { kind: 'good' });
  }

  private renderThingCard(t: LcThing): void {
    if (!this.card || this.mode !== 'item') return;
    const th = t.thing;
    const prev = thingPreview(t, 128);
    prev.style.width = prev.style.height = '128px';
    prev.style.imageRendering = 'pixelated';
    const info = document.createElement('div');
    const h = document.createElement('h3');
    h.textContent = th.name;
    const badge = document.createElement('div');
    badge.className = 'lcx-hint';
    badge.innerHTML = '';
    const cat = document.createElement('span');
    cat.textContent = `${CATEGORY_ICON[th.category] ?? '⚒'} ${th.category} · `;
    const rar = document.createElement('span');
    rar.textContent = th.rarity;
    rar.style.color = RARITY_COLOR[th.rarity] ?? '#ccc';
    rar.style.fontWeight = 'bold';
    const src = document.createElement('span');
    src.textContent = ` · ${t.source}${t.version ? ` v${t.version + 1}` : ''}`;
    badge.append(cat, rar, src);
    const desc = document.createElement('div');
    desc.className = 'lcx-flavor';
    desc.textContent = th.description || th.flavor;
    const fl = document.createElement('div');
    fl.className = 'lcx-hint';
    fl.textContent = th.flavor && th.flavor !== th.description ? `“${th.flavor}”` : '';
    const stats = document.createElement('div');
    stats.className = 'lcx-stats';
    const rows: [string, string][] = Object.entries(th.stats).filter(([k, v]) => v && !(k === 'stackSize' && v === 1)).map(([k, v]) => [k, String(Math.round(v * 10) / 10)]);
    if (th.effect !== 'none') rows.push(['effect', th.effect.replace(/_/g, ' ')]);
    if (th.creature) rows.push(['behaviour', `${th.creature.behaviour}${th.creature.lays ? ` · lays ${th.creature.lays}` : ''}`]);
    if (th.wearable) rows.push(['slot', th.wearable.slot]);
    if (th.vehicle) rows.push(['vehicle', `${th.vehicle.mode} · ${th.vehicle.speed} blocks/s · ${th.vehicle.seats} seat${th.vehicle.seats === 1 ? '' : 's'}`]);
    if (th.recipe) rows.push(['recipe', `${Object.values(th.recipe.key).join(', ')}${recipeKnown(t) ? '' : ' (not craftable here)'}`]);
    for (const [k, v] of rows) {
      const a = document.createElement('span');
      a.textContent = k;
      const b = document.createElement('span');
      b.textContent = v;
      stats.append(a, b);
    }
    const use = document.createElement('div');
    use.className = 'lcx-hint';
    use.textContent = `In your hotbar: ${USE_HINT[useOf(t)] ?? 'use it'}`;
    info.append(h, badge, desc, ...(fl.textContent ? [fl] : []), stats, use);
    this.showCard([prev, info]);
  }

  /** `forge.ready` directive: an async forge result or a mesh job finished. */
  onReady(d: Directive): void {
    const a = d.args as { item?: ForgedItem; state?: string; url?: string };
    if (a.item) {
      const spec = fromForged(a.item, a.item.name, a.item.family, 'ai');
      this.give(spec, null, 0);
    } else if (a.state === 'done') this.game.ui.toast('Forge: a 3D model finished (see the dashboard)', { kind: 'good' });
  }

  private upgrade(prev: LcForged, item: ForgedItem, prompt: string, family: string | undefined, ms: number): void {
    const spec = fromForged(item, prompt, family, 'ai');
    this.give(spec, prev, ms);
    this.game.ui.toast(`✨ The forge refined it: ${spec.name}`, { kind: 'good', seconds: 4 });
  }

  private give(spec: LcForged, replace: LcForged | null, ms: number): void {
    registerForged(spec, spec.grid ? pixelsFromGrid(spec.grid, [...spec.palette]) : null);
    this.game.save.markDirty('lf_forge');
    const stack = { item: spec.id, count: 1, data: { name: spec.name, tags: ['forged', ...(spec.effect ? [spec.effect] : [])], colors: [spec.palette[0], spec.palette[3]], effect: spec.effect } };
    putInHotbar(this.game, stack, replace?.id);
    const model = spec.source === 'ai' ? (this.lf.cassette === 'REPLAY' ? 'replay' : 'sonnet') : spec.source === 'cache' ? 'cache' : 'rules';
    this.lf.think({
      source: 'forge', actor: 'forge', kind: 'plan', model, ms: Math.round(ms),
      text: `${replace ? 'Upgraded' : 'Forged'} ${spec.name} (${spec.shape}): ${spec.effect ?? 'no effect'} · tier ${spec.tier} · dmg ${spec.stats.damage} · speed ${spec.stats.speed} · dur ${spec.stats.durability}`,
      data: { spec },
    });
    this.lf.signal('item.forged', { item: spec.id, name: spec.name, ...(spec.effect ? { effect: spec.effect } : {}) });
    try {
      getQuests().noteForged();
    } catch {
      /* quests not ready */
    }
    getHub().caption(`⚡ ${spec.name}: ${spec.effect?.replace(/_/g, ' ') ?? 'forged'} — in your hotbar`, 6);
    this.renderCard(spec);
    this.setStatus(replace ? '✨ Refined by the AI forge' : spec.source === 'rules' ? 'Forged (rules). The AI design may follow…' : 'Forged');
    if (!replace) this.game.ui.toast(`Forged: ${spec.name}`, { kind: 'good' });
  }

  private setStatus(s: string): void {
    if (this.status) this.status.textContent = s;
  }

  private showCard(children: HTMLElement[]): void {
    if (!this.card) return;
    this.card.replaceChildren(...children);
    this.card.style.display = '';
  }

  private renderCard(spec: LcForged): void {
    if (!this.card) return;
    this.showCard([]);
    const px = forgedPixels(spec.id);
    if (px) this.card.appendChild(pixelsToCanvas(px));
    const info = document.createElement('div');
    const h = document.createElement('h3');
    h.textContent = spec.name;
    const fl = document.createElement('div');
    fl.className = 'lcx-flavor';
    fl.textContent = spec.flavor;
    const stats = document.createElement('div');
    stats.className = 'lcx-stats';
    const def = findItem(spec.id)?.tool;
    for (const [k, v] of [['type', `${spec.shape} (${spec.kind})`], ['tier', String(spec.tier)], ['speed', `${spec.stats.speed}${def ? ` → ×${def.speed.toFixed(1)}` : ''}`], ['damage', String(def?.damage ?? spec.stats.damage)], ['durability', String(def?.durability ?? spec.stats.durability)], ['effect', spec.effect?.replace(/_/g, ' ') ?? '—'], ['source', spec.source]] as const) {
      const a = document.createElement('span');
      a.textContent = k;
      const b = document.createElement('span');
      b.textContent = v;
      stats.append(a, b);
    }
    const rec = document.createElement('div');
    rec.className = 'lcx-recipe';
    const rows = spec.recipe.pattern.map((r) => r.padEnd(3, ' '));
    for (const row of [...rows, '   ', '   '].slice(0, 3)) for (const ch of row.slice(0, 3)) {
      const c = document.createElement('span');
      const item = spec.recipe.key[ch];
      c.textContent = item ? item.split('_').map((w) => w[0]).join('').toUpperCase() : '';
      c.title = item ?? '';
      rec.appendChild(c);
    }
    const recLabel = document.createElement('div');
    recLabel.className = 'lcx-hint';
    recLabel.textContent = `Recipe: ${Object.entries(spec.recipe.key).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    info.append(h, fl, stats, rec, recLabel);
    this.card.appendChild(info);
  }

  private build(): Screen {
    const root = document.createElement('div');
    const box = document.createElement('div');
    box.className = 'lcx-forge';
    this.title = document.createElement('h2');
    this.title.textContent = '⚒ FORGE ANYTHING';
    const tabs = document.createElement('div');
    tabs.className = 'lcx-tabs';
    for (const [m, label] of [['item', '⚒ Item'], ['building', '🏰 Building']] as const) {
      const b = document.createElement('button');
      b.className = 'lcx-tab';
      b.textContent = label;
      b.addEventListener('click', () => {
        this.setMode(m);
        this.input.focus();
      });
      this.tabs[m] = b;
      tabs.appendChild(b);
    }
    const row = document.createElement('div');
    row.className = 'lcx-chat-row';
    this.input = document.createElement('input');
    this.input.placeholder = 'Describe anything… e.g. a fluffy chicken, a steam train, a lantern';
    this.input.maxLength = 400;
    this.family = document.createElement('select');
    for (const f of ['auto', ...SHAPES]) {
      const o = document.createElement('option');
      o.value = f === 'auto' ? '' : f;
      o.textContent = f;
      this.family.appendChild(o);
    }
    const go = (this.go = document.createElement('button'));
    go.textContent = 'Forge';
    const mic = document.createElement('button');
    mic.textContent = '🎤';
    mic.title = 'Hold to speak';
    row.append(this.input, go, mic);
    this.status = document.createElement('div');
    this.status.className = 'lcx-hint';
    this.status.textContent = 'Enter — forge · 🎤 hold — speak · the item goes to your hotbar';
    this.card = document.createElement('div');
    this.card.className = 'lcx-card';
    this.card.style.display = 'none';
    box.append(this.title, tabs, row, this.status, this.card);
    root.appendChild(box);
    const doForge = () => void (this.mode === 'building' ? this.blueprints.draft(this.input.value) : this.forge(this.input.value, this.family.value || undefined));
    go.addEventListener('click', doForge);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doForge();
      }
      if (e.key !== 'Escape') e.stopPropagation();
    });
    mic.addEventListener('mousedown', () => {
      const m = getMic(this.lf);
      if (!m) return this.setStatus('No microphone / speech recognition here');
      this.setStatus('🎙 Listening…');
      m.start().catch((err: Error) => this.setStatus(`Mic unavailable: ${err.message}`));
    });
    mic.addEventListener('mouseup', async () => {
      const m = getMic(this.lf);
      if (!m) return;
      const said = (await m.stop().catch(() => '')).trim();
      if (!said) return this.setStatus('Didn’t catch that');
      this.input.value = said;
      doForge();
    });
    return { id: 'lf-forge', el: root, pausesGame: true, onKey: (e) => e.code !== 'Escape' };
  }
}

let forge: Forge | null = null;

/** @internal */
export function initForge(game: Game, lf: LiveforgeService): Forge {
  forge = new Forge(game, lf);
  return forge;
}

/** The forge (after plugin init). */
export function getForge(): Forge | null {
  return forge;
}

export { forgedSpec };
