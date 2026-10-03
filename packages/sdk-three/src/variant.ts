// Variant v1 -> modifications on a developer asset (glTF scene, prefab group, or a BlueprintObject):
// material swaps, recolours, decals, scale, part toggles, bolted-on blueprints and VFX. Fully revertible.
import * as THREE from "three";
import type { Material, Variant } from "@liveforge/protocol";
import { buildBlueprint, type BlueprintObject } from "./blueprint.js";
import { buildVfx, type VfxObject } from "./vfx.js";

export interface ApplyVariantOptions {
  /** Textures for decal glyph names ("skull", "sun", faction emblems ...). Unknown glyphs draw a soft disc. */
  glyphs?: Record<string, THREE.Texture>;
  /** Custom node lookup for decal `on`, attachment `point` and VFX `attach` names. Default: see {@link findNode}. */
  resolveNode?: (root: THREE.Object3D, name: string) => THREE.Object3D | undefined;
  /** Colour match tolerance for hex `recolour.from` (0-1, sRGB distance). Default 0.08. */
  tolerance?: number;
}

/** Result of applyVariant: what was added, and `revert()` to undo everything. */
export interface VariantHandle {
  readonly object: THREE.Object3D;
  readonly variant: Variant;
  /** Bolted-on blueprints and decal meshes. */
  readonly added: THREE.Object3D[];
  /** VFX started by the variant. */
  readonly effects: VfxObject[];
  /** Restores materials, visibility and scale; removes and disposes added objects and effects. */
  revert(): void;
}

/**
 * Finds a node by name: a BlueprintObject attachment, an exact object / bone name, then `attach:<name>`.
 * Case-insensitive fallback.
 */
export function findNode(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  if (!name) return undefined;
  const bp = root as Partial<BlueprintObject>;
  if (bp.attachments && bp.attachments[name]) return bp.attachments[name];
  const exact = root.getObjectByName(name) ?? root.getObjectByName(`attach:${name}`);
  if (exact) return exact;
  const lower = name.toLowerCase();
  let hit: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!hit && o.name.toLowerCase() === lower) hit = o;
  });
  return hit;
}

function toStandard(m: Material, name: string): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name,
    color: new THREE.Color(m.color),
    metalness: m.metalness ?? 0.1,
    roughness: m.roughness ?? 0.6,
    flatShading: m.flatShading ?? false,
  });
  if (m.emissive) {
    mat.emissive.set(m.emissive);
    mat.emissiveIntensity = m.emissiveIntensity ?? 1;
  }
  if (m.opacity !== undefined && m.opacity < 1) {
    mat.transparent = true;
    mat.opacity = m.opacity;
  }
  return mat;
}

type ColorMat = THREE.Material & { color: THREE.Color };
const hasColor = (m: THREE.Material): m is ColorMat => (m as Partial<ColorMat>).color instanceof THREE.Color;
const ROLE_INDEX = { primary: 0, secondary: 1, trim: 2, accent: 3 } as const;

/**
 * Applies a Variant to an object you own. Returns a handle with `revert()`.
 *
 * ```ts
 * const res = await lf.ask("forge.look", { prompt: "frost-bitten", asset: "knight" }).final;
 * const look = applyVariant(knightScene, res.result.variant);
 * // later: look.revert();
 * ```
 */
export function applyVariant(object: THREE.Object3D, variant: Variant, opts: ApplyVariantOptions = {}): VariantHandle {
  const resolve = (name: string) => (opts.resolveNode ? opts.resolveNode(object, name) : findNode(object, name));
  const tol = opts.tolerance ?? 0.08;
  const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const originalVisible = new Map<THREE.Object3D, boolean>();
  const originalScale = object.scale.clone();
  const created: THREE.Material[] = [];
  const added: THREE.Object3D[] = [];
  const effects: VfxObject[] = [];

  const meshes: THREE.Mesh[] = [];
  object.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.userData.liveforgeVariantAdded) meshes.push(o as THREE.Mesh);
  });
  const remember = (mesh: THREE.Mesh) => {
    if (!originalMaterials.has(mesh)) originalMaterials.set(mesh, mesh.material);
  };
  const matsOf = (mesh: THREE.Mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
  const setMats = (mesh: THREE.Mesh, mats: THREE.Material[]) => {
    mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
  };

  // 1. material swaps (by material name or mesh name; "*" = all)
  for (const swap of variant.materialSwaps ?? []) {
    const mat = toStandard(swap.material, swap.slot);
    created.push(mat);
    for (const mesh of meshes) {
      const mats = matsOf(mesh);
      const all = swap.slot === "*";
      const meshHit = mesh.name === swap.slot;
      if (!all && !meshHit && !mats.some((m) => m.name === swap.slot)) continue;
      remember(mesh);
      setMats(mesh, mats.map((m) => (all || meshHit || m.name === swap.slot ? mat : m)));
    }
  }

  // 2. recolour (exact colour within tolerance, or palette role)
  if (variant.recolour?.length) {
    const palette = (object.userData.palette as string[] | undefined)?.map((h) => new THREE.Color(h));
    const ranked = rankColors(meshes);
    const clones = new Map<THREE.Material, THREE.Material>();
    for (const rule of variant.recolour) {
      const to = new THREE.Color(rule.to);
      let target: THREE.Color | undefined;
      if (rule.from in ROLE_INDEX) {
        const i = ROLE_INDEX[rule.from as keyof typeof ROLE_INDEX];
        target = palette?.[i] ?? ranked[i];
      } else {
        target = new THREE.Color(rule.from);
      }
      if (!target) continue;
      for (const mesh of meshes) {
        const mats = matsOf(mesh);
        let changed = false;
        const next = mats.map((m) => {
          if (!hasColor(m) || colorDistance(m.color, target!) > tol) return m;
          changed = true;
          let c = clones.get(m);
          if (!c) {
            c = m.clone();
            created.push(c);
            clones.set(m, c);
            (c as ColorMat).color.copy(to);
          }
          return c;
        });
        if (changed) {
          remember(mesh);
          setMats(mesh, next);
        }
      }
    }
  }

  // 3. part toggles (node name, blueprint part id or role)
  for (const [key, on] of Object.entries(variant.partToggles ?? {})) {
    object.traverse((o) => {
      if (o.name === key || o.userData.partId === key || o.userData.role === key) {
        if (!originalVisible.has(o)) originalVisible.set(o, o.visible);
        o.visible = on;
      }
    });
  }

  // 4. scale (0.5-2)
  if (variant.scale !== undefined) {
    const s = Array.isArray(variant.scale) ? variant.scale : [variant.scale, variant.scale, variant.scale];
    const c = (v: number) => Math.min(2, Math.max(0.5, Number.isFinite(v) ? v : 1));
    object.scale.multiply(new THREE.Vector3(c(s[0]), c(s[1]), c(s[2])));
  }

  // 5. decals
  for (const d of variant.decals ?? []) {
    const tex = opts.glyphs?.[d.glyph];
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(d.color ?? "#ffffff"),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      side: THREE.DoubleSide,
      ...(tex ? { map: tex } : { alphaMap: discTexture() }),
    });
    created.push(mat);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.size, d.size), mat);
    mesh.name = `decal:${d.glyph}`;
    mesh.userData.liveforgeVariantAdded = true;
    if (d.position) mesh.position.set(...d.position);
    (resolve(d.on ?? "") ?? object).add(mesh);
    added.push(mesh);
  }

  // 6. bolted-on blueprints
  for (const a of variant.attachments ?? []) {
    try {
      const bp = buildBlueprint(a.blueprint);
      bp.userData.liveforgeVariantAdded = true;
      (resolve(a.point) ?? object).add(bp);
      added.push(bp);
    } catch (err) {
      console.warn("[liveforge] variant attachment skipped:", err);
    }
  }

  // 7. VFX
  for (const recipe of variant.vfx ?? []) {
    const fx = buildVfx(recipe);
    fx.userData.liveforgeVariantAdded = true;
    (resolve(recipe.attach ?? "") ?? object).add(fx);
    effects.push(fx);
  }

  let reverted = false;
  return {
    object,
    variant,
    added,
    effects,
    revert() {
      if (reverted) return;
      reverted = true;
      for (const [mesh, mat] of originalMaterials) mesh.material = mat;
      for (const [o, v] of originalVisible) o.visible = v;
      object.scale.copy(originalScale);
      for (const fx of effects) fx.dispose();
      for (const o of added) {
        if ((o as BlueprintObject).dispose && (o as BlueprintObject).blueprint) (o as BlueprintObject).dispose();
        else {
          o.removeFromParent();
          (o as THREE.Mesh).geometry?.dispose();
        }
      }
      for (const m of created) m.dispose();
    },
  };
}

function colorDistance(a: THREE.Color, b: THREE.Color): number {
  const ah = a.clone().convertLinearToSRGB();
  const bh = b.clone().convertLinearToSRGB();
  return Math.hypot(ah.r - bh.r, ah.g - bh.g, ah.b - bh.b) / Math.sqrt(3);
}

/** Distinct material colours ranked by how many meshes use them (primary first). */
function rankColors(meshes: THREE.Mesh[]): THREE.Color[] {
  const counts = new Map<string, { c: THREE.Color; n: number }>();
  for (const mesh of meshes) {
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!hasColor(m)) continue;
      const k = m.color.getHexString();
      const e = counts.get(k);
      if (e) e.n++;
      else counts.set(k, { c: m.color.clone(), n: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map((e) => e.c);
}

let disc: THREE.DataTexture | null = null;
function discTexture(): THREE.DataTexture {
  if (disc) return disc;
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot((x + 0.5) / n * 2 - 1, (y + 0.5) / n * 2 - 1);
      const v = Math.round(255 * Math.max(0, Math.min(1, (1 - r) * 4)));
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  disc = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  disc.needsUpdate = true;
  return disc;
}
