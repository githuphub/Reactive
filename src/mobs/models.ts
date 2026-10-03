/**
 * Original blocky box models for the mobs, with skins painted procedurally on canvases.
 * Sizes are in pixels (1/16 block); every model faces -Z with its feet at the origin.
 */
import { createBoxModel, shadeNoise, type BoxModel, type BoxPartSpec, type FaceName, type SkinPainter } from '../engine/box-model';

// -- painting helpers ----------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function faceSeed(face: FaceName, salt: number): number {
  return ['right', 'left', 'top', 'bottom', 'back', 'front'].indexOf(face) * 7919 + salt * 104729;
}

/** Flat base colour + noise + random blotches. */
function mottled(base: string, blotches: string[], count: number, salt: number, size = 2): SkinPainter {
  return (face, ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    const r = rng(faceSeed(face, salt));
    for (let i = 0; i < count * Math.max(1, (w * h) / 64); i++) {
      ctx.fillStyle = blotches[Math.floor(r() * blotches.length)];
      const s = 1 + Math.floor(r() * size);
      ctx.fillRect(Math.floor(r() * w), Math.floor(r() * h), s, s);
    }
    shadeNoise(ctx, w, h, salt + w * 3 + h, 0.06);
  };
}

function px(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w = 1, h = 1): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

// -- zombie --------------------------------------------------------------------------------------

const Z_SKIN = '#5f8f4a';
const Z_SKIN_DARK = '#46703a';
const Z_SHIRT = '#6e5a3c';
const Z_SHIRT_DARK = '#54442c';
const Z_PANTS = '#4b4763';

const zombieHead: SkinPainter = (face, ctx, w, h) => {
  mottled(Z_SKIN, [Z_SKIN_DARK, '#6fa055'], 3, 11)(face, ctx, w, h);
  if (face === 'top') mottled('#3f5a2e', ['#2f4422', '#4d6b38'], 6, 12)(face, ctx, w, h);
  if (face === 'front') {
    px(ctx, '#1a1f14', 1, 3, 2, 2);
    px(ctx, '#1a1f14', 5, 3, 2, 2);
    px(ctx, '#c8d070', 2, 4);
    px(ctx, '#c8d070', 5, 4);
    px(ctx, '#2a1c14', 2, 6, 4, 1);
    px(ctx, '#3a2a1e', 3, 7, 2, 1);
  } else if (face !== 'bottom') px(ctx, '#3f5a2e', 0, 0, w, 2);
};
const zombieBody: SkinPainter = (face, ctx, w, h) => {
  mottled(Z_SHIRT, [Z_SHIRT_DARK, '#7d6a4a'], 4, 21)(face, ctx, w, h);
  const r = rng(faceSeed(face, 22));
  // Torn holes showing skin.
  for (let i = 0; i < 3; i++) px(ctx, Z_SKIN_DARK, Math.floor(r() * (w - 2)), 2 + Math.floor(r() * (h - 4)), 2, 1 + Math.floor(r() * 2));
  px(ctx, '#3a2e1e', 0, h - 2, w, 1);
};
const zombieArm: SkinPainter = (face, ctx, w, h) => {
  mottled(Z_SKIN, [Z_SKIN_DARK], 3, 31)(face, ctx, w, h);
  if (face !== 'bottom') px(ctx, Z_SHIRT, 0, 0, w, 4);
  if (face !== 'top' && face !== 'bottom') px(ctx, Z_SHIRT_DARK, 0, 4, w, 1);
};
const zombieLeg: SkinPainter = (face, ctx, w, h) => {
  mottled(Z_PANTS, ['#3a374e', '#57536f'], 3, 41)(face, ctx, w, h);
  if (face !== 'top') px(ctx, '#2a2620', 0, h - 2, w, 2);
};
const shieldSkin: SkinPainter = (face, ctx, w, h) => {
  mottled('#7a5530', ['#6a4826', '#8a6238'], 4, 51)(face, ctx, w, h);
  ctx.strokeStyle = '#9a9aa4';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  px(ctx, '#b8b8c4', Math.floor(w / 2) - 1, Math.floor(h / 2) - 1, 2, 2);
};

function humanoid(skins: { head: SkinPainter; body: SkinPainter; arm: SkinPainter; leg: SkinPainter }, limb = 4): BoxPartSpec[] {
  const half = limb / 2;
  return [
    { name: 'body', size: [8, 12, 4], pivot: [0, 24, 0], skin: skins.body },
    { name: 'head', size: [8, 8, 8], pivot: [0, 24, 0], offset: [-4, 0, -4], skin: skins.head },
    { name: 'leftArm', size: [limb, 12, limb], pivot: [-4 - half, 22, 0], offset: [-half, -10, -half], skin: skins.arm },
    { name: 'rightArm', size: [limb, 12, limb], pivot: [4 + half, 22, 0], offset: [-half, -10, -half], skin: skins.arm },
    { name: 'leftLeg', size: [limb, 12, limb], pivot: [-2, 12, 0], skin: skins.leg },
    { name: 'rightLeg', size: [limb, 12, limb], pivot: [2, 12, 0], skin: skins.leg },
  ];
}

/** Zombie (or a half-size baby) with an optional wooden shield on the left arm. */
export function createZombieModel(opts: { baby?: boolean; shield?: boolean } = {}): BoxModel {
  const parts = humanoid({ head: zombieHead, body: zombieBody, arm: zombieArm, leg: zombieLeg });
  if (opts.shield) parts.push({ name: 'shield', parent: 'leftArm', size: [10, 1, 12], pivot: [-1, -9, 0], offset: [-5, -1, -6], skin: shieldSkin });
  return createBoxModel({ id: 'zombie', parts, scale: opts.baby ? 1 / 30 : 1 / 16 });
}

// -- skeleton ------------------------------------------------------------------------------------

const BONE = '#d9d4c2';
const BONE_DARK = '#9e9884';
const skelHead: SkinPainter = (face, ctx, w, h) => {
  mottled(BONE, [BONE_DARK, '#e8e4d6'], 2, 61)(face, ctx, w, h);
  if (face === 'front') {
    px(ctx, '#151515', 1, 3, 2, 2);
    px(ctx, '#151515', 5, 3, 2, 2);
    px(ctx, '#3a3a3a', 3, 5, 2, 1);
    for (let x = 1; x < 7; x += 2) px(ctx, '#2a2a2a', x, 7);
  }
};
const skelBody: SkinPainter = (face, ctx, w, h) => {
  ctx.clearRect(0, 0, w, h);
  if (face === 'top' || face === 'bottom') {
    px(ctx, BONE, 0, 0, w, h);
    return;
  }
  // Spine + ribs with gaps (alpha-tested).
  const mid = Math.floor(w / 2);
  px(ctx, BONE_DARK, mid - 1, 0, 2, h);
  for (let y = 1; y < 8; y += 2) px(ctx, BONE, 0, y, w, 1);
  px(ctx, BONE, 0, h - 3, w, 3);
};
const skelLimb: SkinPainter = (face, ctx, w, h) => {
  mottled(BONE, [BONE_DARK], 2, 71)(face, ctx, w, h);
  px(ctx, BONE_DARK, 0, Math.floor(h / 2), w, 1);
};
const bowSkin: SkinPainter = (face, ctx, w, h) => {
  mottled('#6a4826', ['#7a5530'], 2, 81)(face, ctx, w, h);
  if (face === 'right' || face === 'left') px(ctx, '#e6e6e6', 0, h - 1, w, 1);
};

/** Skeleton archer holding a bow in its left hand. */
export function createSkeletonModel(): BoxModel {
  const parts = humanoid({ head: skelHead, body: skelBody, arm: skelLimb, leg: skelLimb }, 2);
  parts.push({ name: 'bow', parent: 'leftArm', size: [1, 2, 14], pivot: [0, -10, 0], offset: [-0.5, -1, -7], skin: bowSkin });
  return createBoxModel({ id: 'skeleton', parts });
}

// -- creeper (our own design: a mossy, leaf-mottled stalker) ------------------------------------

const C_BASE = '#4f9a3c';
const C_SPOTS = ['#2f6b24', '#3d822f', '#7cc25e', '#a0d884'];
const creeperSkin = mottled(C_BASE, C_SPOTS, 7, 91, 2);
const creeperHead: SkinPainter = (face, ctx, w, h) => {
  creeperSkin(face, ctx, w, h);
  if (face === 'front') {
    // Slanted slit eyes and a jagged grin.
    px(ctx, '#0f1a0c', 1, 2, 2, 1);
    px(ctx, '#0f1a0c', 2, 3, 2, 1);
    px(ctx, '#0f1a0c', 5, 2, 2, 1);
    px(ctx, '#0f1a0c', 4, 3, 2, 1);
    for (let x = 1; x < 7; x++) px(ctx, '#0f1a0c', x, x % 2 ? 5 : 6);
    px(ctx, '#0f1a0c', 2, 6, 4, 1);
  }
};

/** The creeper: tall body, four stubby legs. */
export function createCreeperModel(): BoxModel {
  return createBoxModel({
    id: 'creeper',
    parts: [
      { name: 'body', size: [8, 12, 4], pivot: [0, 18, 0], skin: creeperSkin },
      { name: 'head', size: [8, 8, 8], pivot: [0, 18, 0], offset: [-4, 0, -4], skin: creeperHead },
      { name: 'legFL', size: [4, 6, 4], pivot: [-2, 6, -4], skin: creeperSkin },
      { name: 'legFR', size: [4, 6, 4], pivot: [2, 6, -4], skin: creeperSkin },
      { name: 'legBL', size: [4, 6, 4], pivot: [-2, 6, 4], skin: creeperSkin },
      { name: 'legBR', size: [4, 6, 4], pivot: [2, 6, 4], skin: creeperSkin },
    ],
  });
}

// -- spider --------------------------------------------------------------------------------------

const spiderSkin = mottled('#2e2622', ['#3e322c', '#1e1816', '#4a3c34'], 6, 101);
const spiderHead: SkinPainter = (face, ctx, w, h) => {
  spiderSkin(face, ctx, w, h);
  if (face === 'front') {
    for (const [x, y] of [[1, 3], [6, 3], [2, 2], [5, 2], [3, 4], [4, 4], [2, 5], [5, 5]] as const) px(ctx, '#ffb829', x, y);
    px(ctx, '#ffe39a', 3, 4);
    px(ctx, '#ffe39a', 4, 4);
  }
};
const spiderAbdomen: SkinPainter = (face, ctx, w, h) => {
  spiderSkin(face, ctx, w, h);
  if (face === 'top') {
    px(ctx, '#7a2e1e', Math.floor(w / 2) - 1, 2, 2, h - 4);
    px(ctx, '#7a2e1e', 2, Math.floor(h / 2), w - 4, 1);
  }
};

/** Eight-legged spider (wide and low; climbs walls). */
export function createSpiderModel(): BoxModel {
  const parts: BoxPartSpec[] = [
    { name: 'thorax', size: [6, 6, 6], pivot: [0, 9, 0], offset: [-3, -3, -3], skin: spiderSkin },
    { name: 'abdomen', size: [10, 8, 12], pivot: [0, 9, 3], offset: [-5, -3, 0], skin: spiderAbdomen },
    { name: 'head', size: [8, 8, 8], pivot: [0, 9, -3], offset: [-4, -4, -8], skin: spiderHead },
  ];
  const zs = [-2, -0.5, 1, 2.5];
  for (let i = 0; i < 4; i++) {
    parts.push({ name: `legL${i}`, size: [14, 2, 2], pivot: [-3, 9, zs[i]], offset: [-14, -1, -1], skin: spiderSkin });
    parts.push({ name: `legR${i}`, size: [14, 2, 2], pivot: [3, 9, zs[i]], offset: [0, -1, -1], skin: spiderSkin });
  }
  return createBoxModel({ id: 'spider', parts });
}

// -- pig -----------------------------------------------------------------------------------------

const PIG = '#e9a3a0';
const pigSkin = mottled(PIG, ['#dc8f8c', '#f2b6b3'], 3, 111);
const pigHead: SkinPainter = (face, ctx, w, h) => {
  pigSkin(face, ctx, w, h);
  if (face === 'front') {
    px(ctx, '#ffffff', 1, 2, 2, 1);
    px(ctx, '#1a1a1a', 1, 2);
    px(ctx, '#ffffff', 5, 2, 2, 1);
    px(ctx, '#1a1a1a', 6, 2);
  }
};
const snoutSkin: SkinPainter = (face, ctx, w, h) => {
  px(ctx, '#d9807e', 0, 0, w, h);
  if (face === 'front') {
    px(ctx, '#7a3a3a', 0, 1);
    px(ctx, '#7a3a3a', w - 1, 1);
  }
};

/** Pig: pink quadruped with a snout. */
export function createPigModel(): BoxModel {
  return createBoxModel({
    id: 'pig',
    parts: [
      { name: 'body', size: [10, 8, 16], pivot: [0, 10, 0], offset: [-5, -4, -8], skin: pigSkin },
      { name: 'head', size: [8, 8, 8], pivot: [0, 12, -8], offset: [-4, -4, -8], skin: pigHead },
      { name: 'snout', parent: 'head', size: [4, 3, 1], pivot: [0, 0, 0], offset: [-2, -3, -9], skin: snoutSkin },
      { name: 'legFL', size: [4, 6, 4], pivot: [-3, 6, -5], skin: pigSkin },
      { name: 'legFR', size: [4, 6, 4], pivot: [3, 6, -5], skin: pigSkin },
      { name: 'legBL', size: [4, 6, 4], pivot: [-3, 6, 5], skin: pigSkin },
      { name: 'legBR', size: [4, 6, 4], pivot: [3, 6, 5], skin: pigSkin },
    ],
  });
}

// -- cow -----------------------------------------------------------------------------------------

const cowSkin: SkinPainter = (face, ctx, w, h) => {
  mottled('#5a3d2a', ['#4a3222', '#6a4a34'], 3, 121)(face, ctx, w, h);
  const r = rng(faceSeed(face, 122));
  for (let i = 0; i < Math.max(1, Math.floor((w * h) / 70)); i++) {
    const cx = Math.floor(r() * w), cy = Math.floor(r() * h), rad = 1.5 + r() * 2.5;
    ctx.fillStyle = '#ebe6dc';
    for (let y = -3; y <= 3; y++) for (let x = -4; x <= 4; x++) if (x * x * 0.6 + y * y < rad * rad) ctx.fillRect(cx + x, cy + y, 1, 1);
  }
};
const cowHead: SkinPainter = (face, ctx, w, h) => {
  mottled('#5a3d2a', ['#4a3222'], 2, 131)(face, ctx, w, h);
  if (face === 'front') {
    px(ctx, '#ebe6dc', 3, 0, 2, 4);
    px(ctx, '#ffffff', 1, 2, 1, 1);
    px(ctx, '#111111', 1, 3);
    px(ctx, '#ffffff', 6, 2, 1, 1);
    px(ctx, '#111111', 6, 3);
  }
};
const cowSnout: SkinPainter = (face, ctx, w, h) => {
  px(ctx, '#c9a48a', 0, 0, w, h);
  if (face === 'front') {
    px(ctx, '#5a3a2a', 1, 1);
    px(ctx, '#5a3a2a', w - 2, 1);
  }
};
const hornSkin = '#d8d0b8';
const cowLeg: SkinPainter = (face, ctx, w, h) => {
  cowSkin(face, ctx, w, h);
  px(ctx, '#2a2018', 0, h - 2, w, 2);
};

/** Cow: tall quadruped with patches and horns. */
export function createCowModel(): BoxModel {
  return createBoxModel({
    id: 'cow',
    parts: [
      { name: 'body', size: [12, 10, 18], pivot: [0, 17, 0], offset: [-6, -5, -9], skin: cowSkin },
      { name: 'head', size: [8, 8, 6], pivot: [0, 20, -9], offset: [-4, -4, -6], skin: cowHead },
      { name: 'snout', parent: 'head', size: [6, 3, 1], pivot: [0, 0, -6], offset: [-3, -4, -1], skin: cowSnout },
      { name: 'hornL', parent: 'head', size: [1, 3, 1], pivot: [-4.5, 4, -3], offset: [-0.5, 0, -0.5], skin: hornSkin },
      { name: 'hornR', parent: 'head', size: [1, 3, 1], pivot: [4.5, 4, -3], offset: [-0.5, 0, -0.5], skin: hornSkin },
      { name: 'legFL', size: [4, 12, 4], pivot: [-4, 12, -6], skin: cowLeg },
      { name: 'legFR', size: [4, 12, 4], pivot: [4, 12, -6], skin: cowLeg },
      { name: 'legBL', size: [4, 12, 4], pivot: [-4, 12, 7], skin: cowLeg },
      { name: 'legBR', size: [4, 12, 4], pivot: [4, 12, 7], skin: cowLeg },
    ],
  });
}

/** Swings four legs (legFL/legFR/legBL/legBR) diagonally, like a trotting quadruped. */
export function animateQuadruped(model: BoxModel, phase: number, amount: number): void {
  const s = Math.sin(phase) * 0.8 * amount;
  const p = model.parts;
  if (p.legFL) p.legFL.rotation.x = s;
  if (p.legBR) p.legBR.rotation.x = s;
  if (p.legFR) p.legFR.rotation.x = -s;
  if (p.legBL) p.legBL.rotation.x = -s;
}

/** Spider leg cycle: alternating legs lift and sweep. */
export function animateSpider(model: BoxModel, phase: number, amount: number): void {
  const p = model.parts;
  for (let i = 0; i < 4; i++) {
    const s = Math.sin(phase + (i % 2 ? Math.PI : 0)) * amount;
    const spread = (i - 1.5) * 0.35;
    const l = p[`legL${i}`], r = p[`legR${i}`];
    if (l) {
      l.rotation.z = 0.6 + Math.max(0, s) * 0.3;
      l.rotation.y = spread + s * 0.35;
    }
    if (r) {
      r.rotation.z = -0.6 - Math.max(0, -s) * 0.3;
      r.rotation.y = -spread - s * 0.35;
    }
  }
}
