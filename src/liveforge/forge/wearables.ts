/**
 * Wearables: right-click while holding a wearable thing (or an armour piece) to put it on; it leaves the hotbar and
 * goes into its slot (head, chest, legs, feet, back), and whatever was worn there comes back to the inventory.
 * Sneak + right-click with an empty hand takes everything off. Right-clicking one piece of a forged armour set
 * puts on every piece of that set you carry.
 *
 * Worn models attach to the third-person player model (F5): head items on the head, chest items on the body,
 * leggings and boots split per leg so they swing with the walk, back items on the upper back. In first person a
 * small HUD strip shows what you wear, your armour points and active effects. Armour points cut damage (4 % each,
 * up to 80 %), worn effects and full-set bonuses become buffs. Saved in `lf_wear`.
 */
import * as THREE from 'three';
import type { ThingSlot } from '@liveforge/sdk';
import type { Game } from '../../game/game';
import type { BoxModel } from '../../engine/box-model';
import { getParticles, giveItem } from '../../survival';
import { getHub } from '../hub';
import { getBuffs, type BuffEffect } from './buffs';
import { allThings, onThingChanged, thingIcon, thingSpec, useOf, type LcThing } from './things';
import { expand, voxelGeometry, type Vox } from './voxel-model';

const SLOTS: ThingSlot[] = ['head', 'chest', 'legs', 'feet', 'back'];
const SLOT_GLYPH: Record<ThingSlot, string> = { head: '⛑', chest: '👕', legs: '👖', feet: '🥾', back: '🎒' };
const PX = 1 / 16;

/** The slot a wearable thing goes in. */
export function slotOf(t: LcThing): ThingSlot | null {
  if (useOf(t) !== 'wearable') return null;
  return t.thing.wearable?.slot ?? 'head';
}

function isWearable(t: LcThing | undefined): t is LcThing {
  return !!t && slotOf(t) !== null;
}

/** Equipment, player-model attachments, armour and set bonuses. */
export class Wearables {
  readonly worn: Partial<Record<ThingSlot, string>> = {};
  private model: BoxModel | null = null;
  private attached: THREE.Object3D[] = [];
  private builtKey = '';
  private readonly hud: HTMLElement;
  private hudKey = '';

  constructor(private readonly game: Game) {
    game.save.register('lf_wear', () => ({ ...this.worn }), (d: Partial<Record<ThingSlot, string>>) => {
      for (const s of SLOTS) if (d?.[s]) this.worn[s] = d[s];
    });
    const buffs = getBuffs(game);
    buffs.armor = () => this.armor();
    buffs.addProvider(() => this.effects());
    this.hud = document.createElement('div');
    this.hud.className = 'lcx-wear';
    this.hud.style.display = 'none';
    game.ui.mount('top-left', this.hud, { order: 40 });
    game.events.on('blockInteract', (e) => {
      if (isWearable(thingSpec(e.item?.item)) || (!e.item && e.sneaking && this.any())) e.handled = true;
    });
    game.events.on('entityInteract', (e) => {
      if (isWearable(thingSpec(e.item?.item))) e.handled = true;
    });
    onThingChanged(() => (this.builtKey = ''));
    game.addSystem({ name: 'forge-wearables', update: () => this.update() });
  }

  /** True when anything is worn. */
  any(): boolean {
    return SLOTS.some((s) => this.worn[s]);
  }

  /** Puts a wearable on (from the selected slot when `fromHand`). Returns the replaced item id. */
  wear(t: LcThing, fromHand = true): string | null {
    const slot = slotOf(t);
    if (!slot) return null;
    const game = this.game;
    const prev = this.worn[slot] ?? null;
    if (fromHand) {
      const sel = game.inventory.selectedStack;
      if (sel?.item === t.id) game.inventory.consumeSelected(1);
      else if (!game.inventory.remove(t.id, 1)) return null;
    }
    this.worn[slot] = t.id;
    if (prev) giveItem(game, prev, 1, { dropOverflow: true });
    this.builtKey = '';
    game.save.markDirty('lf_wear');
    game.save.markDirty('inventory');
    const p = game.player.position;
    getParticles(game).burst({ x: p.x, y: p.y + 1.2, z: p.z, count: 12, color: Object.values(t.thing.model.palette).slice(0, 3), speed: 1.2, up: 1, size: 0.07, life: 0.6, spread: 0.4 });
    return prev;
  }

  /** Takes everything off (back into the inventory). */
  unwearAll(): void {
    for (const s of SLOTS) {
      const id = this.worn[s];
      if (!id) continue;
      delete this.worn[s];
      giveItem(this.game, id, 1, { dropOverflow: true });
    }
    this.builtKey = '';
    this.game.save.markDirty('lf_wear');
  }

  /** Total armour points worn. */
  armor(): number {
    let a = 0;
    for (const s of SLOTS) a += thingSpec(this.worn[s])?.thing.stats.armor ?? 0;
    return a;
  }

  /** Effects from worn things and complete armour sets. */
  effects(): BuffEffect[] {
    const out: BuffEffect[] = [];
    const worn = SLOTS.map((s) => thingSpec(this.worn[s])).filter((t): t is LcThing => !!t);
    for (const t of worn) if (t.thing.effect !== 'none') out.push(t.thing.effect);
    for (const set of new Set(worn.map((t) => t.set).filter((x) => !!x))) {
      if (set && set.pieces.every((id) => worn.some((t) => t.id === id))) out.push(set.effect);
    }
    return out;
  }

  /** Full sets currently worn (for the HUD). */
  fullSets(): string[] {
    const worn = SLOTS.map((s) => thingSpec(this.worn[s])).filter((t): t is LcThing => !!t);
    const names = new Set<string>();
    for (const t of worn) if (t.set && t.set.pieces.every((id) => worn.some((w) => w.id === id))) names.add(t.set.name);
    return [...names];
  }

  private update(): void {
    const game = this.game;
    const input = game.input;
    if (!game.ui.screens.isOpen && !game.player.frozen && input.wasButtonPressed(2)) {
      const t = thingSpec(game.inventory.selectedStack?.item);
      if (isWearable(t)) {
        const set = t.set;
        const pieces = set ? allThings().filter((x) => x.set?.id === set.id && x.id !== t.id && game.inventory.count(x.id) > 0) : [];
        this.wear(t);
        for (const x of pieces) this.wear(x, true);
        const what = set && pieces.length ? set.name : t.thing.name;
        game.ui.toast(`Wearing ${what} · armour ${this.armor()}${this.fullSets().length ? ` · set bonus: ${thingSpec(this.worn.chest ?? this.worn.head)?.set?.bonus ?? ''}` : ''}`, { kind: 'good', seconds: 3 });
        getHub().caption(`🛡 ${what}: press F5 to see it · sneak + right-click with an empty hand takes it off`, 5);
        game.interaction.onSwing?.();
      } else if (!game.inventory.selectedStack && game.player.sneaking && this.any()) {
        this.unwearAll();
        game.ui.toast('Took everything off', { seconds: 1.5 });
      }
    }
    this.syncModel();
    this.syncHud();
  }

  // -------------------------------------------------------------- third-person attachments

  private findPlayerModel(): BoxModel | null {
    if (this.model && this.model.root.parent === this.game.scene) return this.model;
    this.model = null;
    const p = this.game.player.position;
    for (const c of this.game.scene.children) {
      const m = c.userData.boxModel as BoxModel | undefined;
      if (m?.parts.leftArm && m.parts.head && m.parts.leftLeg && c.position.distanceTo(p) < 0.6) return (this.model = m);
    }
    return null;
  }

  private syncModel(): void {
    if (this.game.player.viewMode === 'first') return;
    const m = this.findPlayerModel();
    if (!m) return;
    const key = `${m.root.uuid}|${SLOTS.map((s) => {
      const t = thingSpec(this.worn[s]);
      return t ? `${t.id}:${t.version}` : '';
    }).join('|')}`;
    if (key === this.builtKey) return;
    this.builtKey = key;
    for (const o of this.attached) o.removeFromParent();
    this.attached = [];
    for (const s of SLOTS) {
      const t = thingSpec(this.worn[s]);
      if (t) this.attach(m, s, t);
    }
  }

  private attach(m: BoxModel, slot: ThingSlot, t: LcThing): void {
    const model = t.thing.model;
    const { voxels, size } = expand(model);
    const pivot = model.pivot ?? [size[0] / 2, 0, size[2] / 2];
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const words = `${t.thing.name} ${t.thing.tags.join(' ')}`.toLowerCase();
    // fit: head items about head size, body items about body size
    const limits: Record<ThingSlot, number> = { head: 12, chest: 14, legs: 12, feet: 10, back: 16 };
    const s = Math.min(1, limits[slot] / Math.max(size[0], size[1] * 0.9, size[2]));
    const mesh = (subset: Vox[] | undefined, origin: readonly [number, number, number]) => {
      const me = new THREE.Mesh(voxelGeometry(model, { unit: PX * s, origin, ...(subset ? { subset } : {}) }), mat);
      me.rotation.y = Math.PI; // models face +Z, the player model faces -Z
      return me;
    };
    const add = (parent: THREE.Object3D | undefined, obj: THREE.Object3D, x: number, y: number, z: number) => {
      if (!parent) return;
      obj.position.set(x * PX, y * PX, z * PX);
      parent.add(obj);
      this.attached.push(obj);
    };
    if (slot === 'head') {
      // helmets enclose the head (bottom at the neck), masks sit on the face, hats rest on top
      const enclosing = /helm|hood|mask|visor|goggle|glasses|monocle/.test(words) || size[1] >= 8;
      const face = /mask|visor|goggle|glasses|monocle/.test(words) && size[2] <= 2;
      add(m.parts.head, mesh(undefined, pivot), 0, face ? 4 : enclosing ? -0.5 : 8, face ? -4.6 : 0);
    } else if (slot === 'chest') add(m.parts.body, mesh(undefined, pivot), 0, -6, 0);
    else if (slot === 'back') add(m.parts.body, mesh(undefined, pivot), 0, -1, 2.6 + (size[2] * s) / 2);
    else {
      // legs and feet: split the model per leg so each half swings with its leg
      const left = voxels.filter((v) => v.x + 0.5 < pivot[0]);
      const right = voxels.filter((v) => v.x + 0.5 >= pivot[0]);
      const y = slot === 'feet' ? 0 : 12;
      // model +x faces the player's -x after the half turn: model left (x < pivot) ends on the player's right leg
      if (left.length) add(m.parts.rightLeg, mesh(left, pivot), -2, y - 12, 0);
      if (right.length) add(m.parts.leftLeg, mesh(right, pivot), 2, y - 12, 0);
    }
  }

  // -------------------------------------------------------------- HUD strip

  private syncHud(): void {
    const ids = SLOTS.map((s) => this.worn[s] ?? '');
    const buffs = getBuffs(this.game).list();
    const key = `${ids.join('|')}|${buffs.join(',')}|${allThings().length}`;
    if (key === this.hudKey) return;
    this.hudKey = key;
    this.hud.replaceChildren();
    const any = ids.some((x) => x) || buffs.length;
    this.hud.style.display = any ? '' : 'none';
    if (!any) return;
    for (const s of SLOTS) {
      const t = thingSpec(this.worn[s]);
      if (!t) continue;
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      c.getContext('2d')!.drawImage(thingIcon(t), 0, 0, 24, 24);
      c.title = `${SLOT_GLYPH[s]} ${t.thing.name}`;
      this.hud.appendChild(c);
    }
    const info = document.createElement('span');
    const armor = this.armor();
    const sets = this.fullSets();
    info.textContent = [armor ? `🛡 ${armor}` : '', sets.length ? `★ ${sets.join(', ')}` : '', buffs.length ? `✦ ${buffs.map((b) => b.replace(/_/g, ' ')).join(', ')}` : ''].filter(Boolean).join('  ');
    this.hud.appendChild(info);
  }
}

let wearables: Wearables | null = null;

/** The wearables service (created by the forge at init). */
export function getWearables(game: Game): Wearables {
  return (wearables ??= new Wearables(game));
}
