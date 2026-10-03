/**
 * Blocky villager and golem models with procedural, original skins.
 *
 * Villagers: big head with a long nose, a robe in their profession colour, short legs, folded
 * arms when idle (separate arms appear while working or emoting), per-profession hats, movable
 * brows for posture faces, an optional party hat and a hand slot for carried blocks or a sword.
 * The golem is a tall iron guardian with long arms, vines, and red eyes that light up when angry.
 */
import * as THREE from 'three';
import { createBoxModel, shadeNoise, type BoxModel, type BoxPartSpec, type FaceName, type SkinPainter } from '../../engine/box-model';

export type Profession = 'builder' | 'farmer' | 'smith' | 'librarian' | 'guard' | 'villager' | 'golem';
export type Expression = 'calm' | 'wary' | 'hostile' | 'festive' | 'sad';

export interface LookSpec {
  skin: string;
  hair: string;
  robe: string;
  trim: string;
  eyes?: string;
  beard?: boolean;
  glasses?: boolean;
}

/** A model plus the handles the NPC code animates. */
export interface NpcModel {
  model: BoxModel;
  /** Outer group (the entity's object3d); the model root sits inside so it can lie down. */
  wrapper: THREE.Group;
  /** Shows the separate arms (work/emote) instead of the folded pair. */
  setArmsFree(free: boolean): void;
  /** Carried block colour (null hides it). */
  setHeld(color: number | null): void;
  /** Shows the sword (guards). */
  setSword(drawn: boolean): void;
  setExpression(e: Expression): void;
  setPartyHat(on: boolean): void;
  /** Golem only: shows a held flower. */
  setFlower(on: boolean): void;
  readonly isGolem: boolean;
  dispose(): void;
}

const PX = 1 / 16;

function fillFace(ctx: CanvasRenderingContext2D, w: number, h: number, c: string, seed: number, k = 0.07): void {
  ctx.fillStyle = c;
  ctx.fillRect(0, 0, w, h);
  shadeNoise(ctx, w, h, seed, k);
}

function headPainter(look: LookSpec): SkinPainter {
  return (face: FaceName, ctx, w, h) => {
    fillFace(ctx, w, h, look.skin, 5, 0.05);
    ctx.fillStyle = look.hair;
    if (face === 'top') ctx.fillRect(0, 0, w, h);
    else if (face === 'back') ctx.fillRect(0, 0, w, Math.ceil(h * 0.55));
    else if (face === 'left' || face === 'right') {
      ctx.fillRect(0, 0, w, 2);
      ctx.fillRect(face === 'left' ? 0 : w - 3, 2, 3, 3);
    } else if (face === 'front') {
      ctx.fillRect(0, 0, w, 2);
      // Eyes.
      ctx.fillStyle = '#f4f1ea';
      ctx.fillRect(1, 4, 2, 1);
      ctx.fillRect(w - 3, 4, 2, 1);
      ctx.fillStyle = look.eyes ?? '#2c5a2a';
      ctx.fillRect(2, 4, 1, 1);
      ctx.fillRect(w - 3, 4, 1, 1);
      if (look.glasses) {
        ctx.fillStyle = '#2a2018';
        ctx.fillRect(0, 3, 4, 1);
        ctx.fillRect(w - 4, 3, 4, 1);
        ctx.fillRect(0, 5, 4, 1);
        ctx.fillRect(w - 4, 5, 4, 1);
      }
      if (look.beard) {
        ctx.fillStyle = look.hair;
        ctx.fillRect(1, h - 3, w - 2, 3);
        ctx.fillRect(0, h - 4, 1, 3);
        ctx.fillRect(w - 1, h - 4, 1, 3);
      } else {
        ctx.fillStyle = 'rgba(120,50,40,0.85)';
        ctx.fillRect((w >> 1) - 1, h - 2, 2, 1);
      }
    }
  };
}

function robePainter(look: LookSpec, prof: Profession): SkinPainter {
  return (face, ctx, w, h) => {
    fillFace(ctx, w, h, look.robe, 17, 0.08);
    if (face === 'top' || face === 'bottom') return;
    // Hem and collar.
    ctx.fillStyle = look.trim;
    ctx.fillRect(0, h - 2, w, 2);
    if (face === 'front' || face === 'back') ctx.fillRect(0, 0, w, 1);
    if (face === 'front') {
      // A placket down the middle.
      ctx.fillRect((w >> 1) - 1, 1, 2, h - 3);
      if (prof === 'builder' || prof === 'smith') {
        ctx.fillStyle = prof === 'smith' ? '#5a3c22' : '#6b4a2b';
        ctx.fillRect(1, 5, w - 2, h - 7);
        ctx.fillStyle = '#d4a93a';
        ctx.fillRect((w >> 1) - 1, 6, 2, 1);
      }
      if (prof === 'farmer') {
        ctx.fillStyle = '#e8dcc0';
        ctx.fillRect(1, 6, w - 2, h - 8);
      }
      if (prof === 'librarian') {
        ctx.fillStyle = '#f2ead8';
        ctx.fillRect(1, 0, w - 2, 2);
        ctx.fillStyle = '#c9a646';
        ctx.fillRect((w >> 1) - 1, 3, 2, 2);
      }
      if (prof === 'guard') {
        ctx.fillStyle = '#c9ccd2';
        ctx.fillRect(1, 1, w - 2, 7);
        ctx.fillStyle = '#9a9ea8';
        ctx.fillRect(1, 7, w - 2, 1);
        ctx.fillStyle = '#b8352e';
        ctx.fillRect(0, 9, w, 1);
      }
    }
    // A belt.
    if (prof !== 'guard') {
      ctx.fillStyle = 'rgba(40,25,15,0.85)';
      ctx.fillRect(0, Math.floor(h * 0.42), w, 1);
    }
  };
}

function armPainter(look: LookSpec): SkinPainter {
  return (face, ctx, w, h) => {
    fillFace(ctx, w, h, look.robe, 29, 0.08);
    ctx.fillStyle = look.trim;
    if (face !== 'top' && face !== 'bottom') ctx.fillRect(0, h - 4, w, 1);
    ctx.fillStyle = look.skin;
    if (face === 'bottom') ctx.fillRect(0, 0, w, h);
    else if (face !== 'top') ctx.fillRect(0, h - 3, w, 3);
  };
}

function foldedPainter(look: LookSpec): SkinPainter {
  return (face, ctx, w, h) => {
    fillFace(ctx, w, h, look.robe, 31, 0.08);
    if (face === 'front') {
      ctx.fillStyle = look.skin;
      ctx.fillRect((w >> 1) - 2, 0, 4, h);
      ctx.fillStyle = look.trim;
      ctx.fillRect(2, 0, 1, h);
      ctx.fillRect(w - 3, 0, 1, h);
    }
  };
}

function legPainter(look: LookSpec): SkinPainter {
  return (face, ctx, w, h) => {
    fillFace(ctx, w, h, '#4a3a2c', 41, 0.06);
    ctx.fillStyle = '#2e241b';
    if (face === 'bottom') ctx.fillRect(0, 0, w, h);
    else if (face !== 'top') ctx.fillRect(0, h - 2, w, 2);
    void look;
  };
}

function solid(color: string, seed = 3, k = 0.06): SkinPainter {
  return (_f, ctx, w, h) => fillFace(ctx, w, h, color, seed, k);
}

function hatParts(prof: Profession, id: string): BoxPartSpec[] {
  switch (prof) {
    case 'builder':
      return [
        { name: 'hat', parent: 'head', size: [9, 2, 9], pivot: [0, 10, 0], offset: [-4.5, 0, -4.5], skin: solid('#e0b52e', 7) },
        { name: 'hatBrim', parent: 'head', size: [9, 1, 3], pivot: [0, 10, -4.5], offset: [-4.5, 0, -3], skin: solid('#c99a1f', 8) },
      ];
    case 'farmer':
      return [
        { name: 'hat', parent: 'head', size: [13, 1, 13], pivot: [0, 10, 0], offset: [-6.5, 0, -6.5], skin: solid('#d9c27a', 9, 0.12) },
        { name: 'hatTop', parent: 'head', size: [8, 3, 8], pivot: [0, 11, 0], offset: [-4, 0, -4], skin: solid('#cbb36a', 10, 0.12) },
        { name: 'hatBand', parent: 'head', size: [8.2, 1, 8.2], pivot: [0, 11, 0], offset: [-4.1, 0, -4.1], skin: solid('#8a3b2e', 11) },
      ];
    case 'smith':
      return [{ name: 'hat', parent: 'head', size: [8.6, 2, 8.6], pivot: [0, 8, 0], offset: [-4.3, 0, -4.3], skin: solid('#a8342c', 12) }];
    case 'librarian':
      return [{ name: 'hat', parent: 'head', size: [6, 2, 6], pivot: [0, 10, 0], offset: [-3, 0, -3], skin: solid('#3b2a5c', 13) }];
    case 'guard':
      return [
        { name: 'hat', parent: 'head', size: [9, 5, 9], pivot: [0, 6, 0], offset: [-4.5, 0, -4.5], skin: helmetPainter },
        { name: 'plume', parent: 'head', size: [1, 3, 5], pivot: [0, 11, 0], offset: [-0.5, 0, -2.5], skin: solid('#c0392b', 14) },
      ];
    default:
      void id;
      return [];
  }
}

const helmetPainter: SkinPainter = (face, ctx, w, h) => {
  fillFace(ctx, w, h, '#c6c9cf', 15, 0.1);
  if (face === 'front') {
    ctx.clearRect(1, h - 2, w - 2, 2);
    ctx.fillStyle = '#c6c9cf';
    ctx.fillRect((w >> 1), h - 2, 1, 2);
  }
};

/** Creates a villager model. `id` keys the texture cache (one per look). */
export function createVillagerModel(id: string, prof: Profession, look: LookSpec): NpcModel {
  const parts: BoxPartSpec[] = [
    { name: 'leftLeg', size: [3, 6, 3], pivot: [-2, 6, 0], skin: legPainter(look) },
    { name: 'rightLeg', size: [3, 6, 3], pivot: [2, 6, 0], skin: legPainter(look) },
    { name: 'body', size: [8, 14, 6], pivot: [0, 20, 0], skin: robePainter(look, prof) },
    { name: 'head', size: [8, 10, 8], pivot: [0, 20, 0], offset: [-4, 0, -4], skin: headPainter(look) },
    { name: 'nose', parent: 'head', size: [2, 4, 2], pivot: [0, 1, -4], offset: [-1, 0, -2], skin: solid(shadeHex(look.skin, 0.9), 4) },
    { name: 'browL', parent: 'head', size: [3, 1, 1], pivot: [-2, 7.2, -4], offset: [-1.5, -0.5, -0.6], skin: solid(look.hair, 2, 0.02) },
    { name: 'browR', parent: 'head', size: [3, 1, 1], pivot: [2, 7.2, -4], offset: [-1.5, -0.5, -0.6], skin: solid(look.hair, 2, 0.02) },
    { name: 'arms', size: [12, 4, 4], pivot: [0, 16, -3], offset: [-6, -2, -4], skin: foldedPainter(look) },
    { name: 'leftArm', size: [4, 11, 4], pivot: [-6, 19, 0], offset: [-2, -10, -2], skin: armPainter(look) },
    { name: 'rightArm', size: [4, 11, 4], pivot: [6, 19, 0], offset: [-2, -10, -2], skin: armPainter(look) },
    { name: 'partyHat', parent: 'head', size: [4, 6, 4], pivot: [1, 10, 0], offset: [-2, 0, -2], skin: partyPainter },
    ...hatParts(prof, id),
  ];
  const model = createBoxModel({ id: `villager_${id}`, parts });
  return wrap(model, false);
}

const partyPainter: SkinPainter = (_face, ctx, w, h) => {
  const colors = ['#e74c3c', '#f1c40f', '#3498db', '#2ecc71'];
  for (let y = 0; y < h; y++) {
    ctx.fillStyle = colors[y % colors.length];
    ctx.fillRect(0, y, w, 1);
  }
};

/** Creates the iron golem model (1.25× scale). */
export function createGolemModel(): NpcModel {
  const iron: SkinPainter = (face, ctx, w, h) => {
    fillFace(ctx, w, h, '#cfcac0', 51, 0.12);
    // Cracks and rivets.
    ctx.fillStyle = 'rgba(80,72,64,0.6)';
    for (let i = 0; i < Math.max(1, (w * h) / 40); i++) {
      const x = (i * 37 + w * 3) % w, y = (i * 53 + h * 7) % h;
      ctx.fillRect(x, y, 1, 2);
    }
    // Vines.
    if (face !== 'bottom') {
      ctx.fillStyle = '#4f7d2e';
      for (let i = 0; i < Math.max(1, w / 3); i++) {
        const x = (i * 5 + 2) % w;
        const len = 2 + ((i * 7) % Math.max(2, h - 2));
        ctx.fillRect(x, 0, 1, Math.min(h, len));
      }
    }
  };
  const head: SkinPainter = (face, ctx, w, h) => {
    fillFace(ctx, w, h, '#d6d1c7', 61, 0.08);
    if (face === 'front') {
      ctx.fillStyle = '#3a3532';
      ctx.fillRect(1, 2, w - 2, 1);
      ctx.fillStyle = '#7a1d14';
      ctx.fillRect(2, 4, 1, 1);
      ctx.fillRect(w - 3, 4, 1, 1);
    }
  };
  const parts: BoxPartSpec[] = [
    { name: 'leftLeg', size: [6, 13, 5], pivot: [-4.5, 13, 0], skin: iron },
    { name: 'rightLeg', size: [6, 13, 5], pivot: [4.5, 13, 0], skin: iron },
    { name: 'body', size: [18, 12, 10], pivot: [0, 25, 0], skin: iron },
    { name: 'head', size: [8, 10, 8], pivot: [0, 25, -2], offset: [-4, 0, -6], skin: head },
    { name: 'nose', parent: 'head', size: [2, 4, 2], pivot: [0, 1, -6], offset: [-1, 0, -2], skin: solid('#bdb7ad', 62) },
    { name: 'browL', parent: 'head', size: [3, 1, 1], pivot: [-2, 7.2, -6], offset: [-1.5, -0.5, -0.6], skin: solid('#3a3532', 63, 0.02) },
    { name: 'browR', parent: 'head', size: [3, 1, 1], pivot: [2, 7.2, -6], offset: [-1.5, -0.5, -0.6], skin: solid('#3a3532', 63, 0.02) },
    { name: 'eyesAngry', parent: 'head', size: [6, 1, 0.5], pivot: [0, 5, -6], offset: [-3, 0, -0.6], skin: eyesPainter },
    { name: 'leftArm', size: [4, 23, 6], pivot: [-11, 24, 0], offset: [-2, -22, -3], skin: iron },
    { name: 'rightArm', size: [4, 23, 6], pivot: [11, 24, 0], offset: [-2, -22, -3], skin: iron },
    { name: 'flower', parent: 'rightArm', size: [2, 4, 2], pivot: [0, -22, -3], offset: [-1, -2, -2], skin: flowerPainter },
  ];
  const model = createBoxModel({ id: 'iron_golem', parts, scale: PX * 1.25 });
  return wrap(model, true);
}

const eyesPainter: SkinPainter = (_f, ctx, w, h) => {
  ctx.fillStyle = '#ff2a1a';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#3a3532';
  ctx.fillRect(2, 0, w - 4, h);
};

const flowerPainter: SkinPainter = (face, ctx, w, h) => {
  ctx.fillStyle = face === 'bottom' ? '#3c7a2a' : '#d6332b';
  ctx.fillRect(0, 0, w, h);
  if (face !== 'top') {
    ctx.fillStyle = '#3c7a2a';
    ctx.fillRect(0, h - 2, w, 2);
  }
};

function shadeHex(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

function wrap(model: BoxModel, isGolem: boolean): NpcModel {
  const wrapper = new THREE.Group();
  wrapper.add(model.root);
  wrapper.userData.boxModel = model;
  const p = model.parts;
  const scale = isGolem ? PX * 1.25 : PX;
  // Hand slot: a small carried block, and a sword.
  const handParent = p.rightArm;
  const heldMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const held = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), heldMat);
  held.position.set(0, (isGolem ? -22 : -11) * scale, -3 * scale);
  held.visible = false;
  handParent.add(held);
  const swordMat = new THREE.MeshLambertMaterial({ color: 0xd8dbe0 });
  const swordGeo = new THREE.BoxGeometry(1.2 * scale, 12 * scale, 2.2 * scale);
  swordGeo.translate(0, 6 * scale, 0);
  const sword = new THREE.Mesh(swordGeo, swordMat);
  const hiltGeo = new THREE.BoxGeometry(5 * scale, 1.2 * scale, 1.5 * scale);
  const hilt = new THREE.Mesh(hiltGeo, new THREE.MeshLambertMaterial({ color: 0x6b4a2b }));
  sword.add(hilt);
  sword.position.set(0, -10 * scale, -2.5 * scale);
  sword.rotation.x = -Math.PI / 2;
  sword.visible = false;
  handParent.add(sword);

  if (p.partyHat) p.partyHat.visible = false;
  if (p.eyesAngry) p.eyesAngry.visible = false;
  if (p.flower) p.flower.visible = false;
  let armsFree = isGolem;
  const applyArms = () => {
    if (p.arms) p.arms.visible = !armsFree;
    p.leftArm.visible = armsFree;
    p.rightArm.visible = armsFree;
  };
  applyArms();

  return {
    model,
    wrapper,
    isGolem,
    setArmsFree(free) {
      if (isGolem || free === armsFree) return;
      armsFree = free;
      applyArms();
    },
    setHeld(color) {
      held.visible = color !== null;
      if (color !== null) heldMat.color.setHex(color);
    },
    setSword(drawn) {
      sword.visible = drawn;
    },
    setExpression(e) {
      const l = p.browL, r = p.browR;
      if (!l || !r) return;
      l.position.y = r.position.y = 7.2 * scale;
      l.rotation.z = r.rotation.z = 0;
      if (e === 'hostile') {
        l.rotation.z = -0.45;
        r.rotation.z = 0.45;
        l.position.y = r.position.y = 6.7 * scale;
      } else if (e === 'wary') {
        l.rotation.z = 0.25;
        r.rotation.z = 0.25;
        l.position.y = r.position.y = 7.7 * scale;
      } else if (e === 'sad') {
        l.rotation.z = 0.35;
        r.rotation.z = -0.35;
      } else if (e === 'festive') {
        l.position.y = r.position.y = 7.8 * scale;
      }
      if (p.eyesAngry) p.eyesAngry.visible = e === 'hostile';
    },
    setPartyHat(on) {
      if (p.partyHat) p.partyHat.visible = on;
      for (const n of ['hat', 'hatBrim', 'hatTop', 'hatBand', 'plume']) if (p[n]) p[n].visible = !on;
    },
    setFlower(on) {
      if (p.flower) p.flower.visible = on;
    },
    dispose() {
      model.dispose();
      held.geometry.dispose();
      heldMat.dispose();
      swordGeo.dispose();
      swordMat.dispose();
      hiltGeo.dispose();
    },
  };
}
