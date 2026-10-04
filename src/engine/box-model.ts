/**
 * Blocky box models with procedural skins (player, mobs, villagers, golems).
 *
 * Sizes and pivots are in "pixels" (1/16 block). The model's origin is the centre of the feet,
 * front faces -Z (so `rotation.y = entity.yaw` works). Each part pivots at `pivot` (relative to its
 * parent's pivot), and its box is placed with `offset` (box min corner relative to the pivot;
 * default: centred on x/z and hanging down from the pivot, which suits limbs).
 */
import * as THREE from 'three';

export type FaceName = 'right' | 'left' | 'top' | 'bottom' | 'back' | 'front';

/** Paints one face of a part; the canvas is `w × h` pixels for that face. */
export type SkinPainter = (face: FaceName, ctx: CanvasRenderingContext2D, w: number, h: number) => void;

export interface BoxPartSpec {
  name: string;
  parent?: string;
  /** [width x, height y, depth z] in pixels. */
  size: [number, number, number];
  /** Pivot relative to the parent's pivot (or the feet origin), in pixels. */
  pivot: [number, number, number];
  /** Box min corner relative to the pivot. Default [-w/2, -h, -d/2]. */
  offset?: [number, number, number];
  /** A CSS colour or a painter. */
  skin: string | SkinPainter;
}

export interface BoxModelSpec {
  /** Cache key: textures are shared by all models with the same id. */
  id?: string;
  parts: BoxPartSpec[];
  /** Units per pixel. Default 1/16. */
  scale?: number;
}

export interface BoxModel {
  root: THREE.Group;
  /** Pivot groups by part name: rotate these to animate. */
  parts: Record<string, THREE.Group>;
  /** Multiplies all colours (0..1) for lighting. */
  setBrightness(b: number): void;
  /** Flashes red (hurt feedback) for `seconds`. */
  flash(seconds?: number): void;
  /** Call each frame if you use flash(). */
  tick(dt: number): void;
  dispose(): void;
}

// BoxGeometry face order: +x, -x, +y, -y, +z, -z.
const FACE_ORDER: FaceName[] = ['right', 'left', 'top', 'bottom', 'back', 'front'];
const textureCache = new Map<string, THREE.Texture>();

function faceSize(face: FaceName, [w, h, d]: [number, number, number]): [number, number] {
  if (face === 'right' || face === 'left') return [d, h];
  if (face === 'top' || face === 'bottom') return [w, d];
  return [w, h];
}

/** Builds a texture strip (6 faces side by side) for a part. */
export function partTexture(size: [number, number, number], skin: string | SkinPainter): { tex: THREE.Texture; cellW: number; cellH: number } {
  const cellW = Math.max(size[0], size[2], 1);
  const cellH = Math.max(size[1], size[2], 1);
  const canvas = document.createElement('canvas');
  canvas.width = cellW * 6;
  canvas.height = cellH;
  const ctx = canvas.getContext('2d')!;
  FACE_ORDER.forEach((face, i) => {
    const [fw, fh] = faceSize(face, size);
    ctx.save();
    ctx.translate(i * cellW, 0);
    ctx.beginPath();
    ctx.rect(0, 0, fw, fh);
    ctx.clip();
    if (typeof skin === 'string') {
      ctx.fillStyle = skin;
      ctx.fillRect(0, 0, fw, fh);
      shadeNoise(ctx, fw, fh, i * 31 + fw * 7 + fh);
    } else skin(face, ctx, fw, fh);
    ctx.restore();
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, cellW, cellH };
}

/** Light per-pixel variation so flat colours don't look plastic. */
export function shadeNoise(ctx: CanvasRenderingContext2D, w: number, h: number, seed = 1, strength = 0.08): void {
  let s = seed * 9301 + 49297;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      s = (s * 9301 + 49297) % 233280;
      const r = s / 233280;
      ctx.fillStyle = r < 0.5 ? `rgba(0,0,0,${(0.5 - r) * strength * 2})` : `rgba(255,255,255,${(r - 0.5) * strength * 2})`;
      ctx.fillRect(x, y, 1, 1);
    }
}

/** Creates a model instance. Materials are per instance (for lighting); textures are cached by spec id. */
export function createBoxModel(spec: BoxModelSpec): BoxModel {
  const scale = spec.scale ?? 1 / 16;
  const root = new THREE.Group();
  const parts: Record<string, THREE.Group> = {};
  const materials: THREE.MeshLambertMaterial[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const ownTextures: THREE.Texture[] = [];

  for (const p of spec.parts) {
    const key = spec.id ? `${spec.id}/${p.name}` : '';
    let tex = key ? textureCache.get(key) : undefined;
    const cellW = Math.max(p.size[0], p.size[2], 1);
    const cellH = Math.max(p.size[1], p.size[2], 1);
    if (!tex) {
      tex = partTexture(p.size, p.skin).tex;
      if (key) textureCache.set(key, tex);
      else ownTextures.push(tex);
    }
    const [w, h, d] = p.size;
    const geo = new THREE.BoxGeometry(w * scale, h * scale, d * scale);
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let f = 0; f < 6; f++) {
      const [fw, fh] = faceSize(FACE_ORDER[f], p.size);
      for (let v = 0; v < 4; v++) {
        const i = f * 4 + v;
        const u0 = uv.getX(i), v0 = uv.getY(i);
        uv.setXY(i, (f * cellW + u0 * fw) / (cellW * 6), 1 - ((1 - v0) * fh) / cellH);
      }
    }
    uv.needsUpdate = true;
    const off = p.offset ?? [-w / 2, -h, -d / 2];
    geo.translate((off[0] + w / 2) * scale, (off[1] + h / 2) * scale, (off[2] + d / 2) * scale);
    geometries.push(geo);
    const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: false, alphaTest: 0.5 });
    materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    const pivot = new THREE.Group();
    pivot.name = p.name;
    pivot.position.set(p.pivot[0] * scale, p.pivot[1] * scale, p.pivot[2] * scale);
    pivot.add(mesh);
    parts[p.name] = pivot;
  }
  for (const p of spec.parts) {
    const parent = p.parent ? parts[p.parent] : root;
    if (!parent) throw new Error(`Box model part "${p.name}" has unknown parent "${p.parent}"`);
    parent.add(parts[p.name]);
  }

  let brightness = 1;
  let flashT = 0;
  const apply = () => {
    for (const m of materials) {
      if (flashT > 0) m.color.setRGB(brightness * 1.4, brightness * 0.45, brightness * 0.45);
      else m.color.setScalar(brightness);
    }
  };
  const model: BoxModel = {
    root,
    parts,
    setBrightness(b) {
      brightness = b;
      apply();
    },
    flash(seconds = 0.3) {
      flashT = seconds;
      apply();
    },
    tick(dt) {
      if (flashT > 0) {
        flashT -= dt;
        if (flashT <= 0) apply();
      }
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of ownTextures) t.dispose();
    },
  };
  root.userData.boxModel = model;
  return model;
}

/**
 * Standard humanoid walk animation: swings arms/legs by walk phase. `amount` 0..1.
 * Expects parts named head, leftArm, rightArm, leftLeg, rightLeg (missing parts are skipped).
 */
export function animateHumanoid(model: BoxModel, phase: number, amount: number, headPitch = 0): void {
  const s = Math.sin(phase) * 0.9 * amount;
  const p = model.parts;
  if (p.leftLeg) p.leftLeg.rotation.x = s;
  if (p.rightLeg) p.rightLeg.rotation.x = -s;
  if (p.leftArm) p.leftArm.rotation.x = -s * 0.8;
  if (p.rightArm) p.rightArm.rotation.x = s * 0.8;
  if (p.head) p.head.rotation.x = headPitch;
}
