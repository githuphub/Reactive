// Blueprint v1 -> THREE.Group. Ported from Counterforge's blueprint builder (packages/pipeline/src/client/blueprint.ts)
// and generalised: named materials, attachment points (+ parts parented to them), LOD hint (segments, far-role
// dropping, impostor), full VFX recipes, Counterforge quick particles, per-part animation.
import * as THREE from "three";
import {
  BLUEPRINT_ROLES,
  clampBlueprint,
  clampVfx,
  partMaterial as resolvePartMaterial,
  type Blueprint,
  type BlueprintLimits,
  type BlueprintPart,
  type BlueprintRole,
  type BlueprintShape,
  type Material,
  type ParticleKind,
  type VfxRecipe,
} from "@liveforge/protocol";
import { buildVfx, type VfxObject } from "./vfx.js";
import { disposeObject, superDispose } from "./dispose.js";

export type Detail = "low" | "medium" | "high";

export interface BuildBlueprintOptions {
  /** Scale uniformly so the longest extent equals this many metres. Default: authored size (scale 1). */
  length?: number;
  /** Run protocol `clampBlueprint` first (recommended for anything from the network). Default true. */
  clamp?: boolean;
  /** Limits for the clamp (manifest clamps). */
  limits?: Partial<BlueprintLimits>;
  /** Geometry detail. Default: `bp.lod.detail`, else "medium". */
  detail?: Detail;
  /** Animate itself from the render loop (wall clock). Leave off if you call `animate(t)` yourself. Default false. */
  autoAnimate?: boolean;
  /** Meshes cast shadows. Default true. */
  castShadow?: boolean;
  /** Darken 0-1 (0 = normal; Counterforge's "cracked" look is ~0.45). */
  dim?: number;
  /** Build `bp.particles` and `bp.vfx` recipes. Default true. */
  vfx?: boolean;
  /** Build `bp.trail` as a live ribbon behind the "tip" attachment (swing trails). Default false (see `fx.trail`). */
  trail?: boolean;
  /** Accepted for compatibility with the K0 skeleton signature; the package imports three itself (peer dependency). */
  three?: unknown;
}

/** Quick-FX descriptors (Counterforge-compatible) for games that draw their own trails. */
export interface BlueprintFx {
  /** Tip position in the object's local space (scaled). */
  tip: THREE.Vector3;
  trail?: { color: number; width: number };
  particles?: { kind: ParticleKind; color: number; rate: number };
  palette: number[];
}

const H = Math.PI / 2;
const SEGMENTS: Record<Detail, { radial: number; sphereW: number; sphereH: number; torusT: number; torusR: number }> = {
  low: { radial: 6, sphereW: 8, sphereH: 6, torusT: 4, torusR: 12 },
  medium: { radial: 10, sphereW: 12, sphereH: 8, torusT: 6, torusR: 20 },
  high: { radial: 18, sphereW: 20, sphereH: 14, torusT: 10, torusR: 32 },
};

// ------------------------------------------------------------------------------------------------ geometry

function wedgeGeometry(): THREE.BufferGeometry {
  // Blade outline in XY (tip at +Y), sharp edges at z = 0, a ridge on each face (diamond cross-section).
  const o: [number, number][] = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.2], [0, 0.5], [-0.5, 0.2]];
  const F = [0, -0.05, 0.5];
  const B = [0, -0.05, -0.5];
  const pos: number[] = [];
  for (let i = 0; i < o.length; i++) {
    const a = o[i];
    const b = o[(i + 1) % o.length];
    pos.push(a[0], a[1], 0, b[0], b[1], 0, F[0], F[1], F[2]);
    pos.push(b[0], b[1], 0, a[0], a[1], 0, B[0], B[1], B[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function crescentGeometry(n: number): THREE.BufferGeometry {
  // Moon arc in XY bulging toward +Y, horns at y = -0.5, thickest in the middle; extruded along Z.
  const shape = new THREE.Shape();
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI;
    const x = 0.5 * Math.cos(t);
    const y = -0.5 + Math.sin(t);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  for (let i = n; i >= 0; i--) {
    const t = (i / n) * Math.PI;
    shape.lineTo(0.42 * Math.cos(t), -0.5 + 0.7 * Math.sin(t));
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, steps: 1 });
  g.translate(0, 0, -0.5);
  return g;
}

/**
 * A geometry for one primitive with the part's size baked in (see protocol `SHAPE_NOTES`), so mesh scale stays 1
 * and animations can use it.
 */
export function partGeometry(shape: BlueprintShape, size: readonly [number, number, number], detail: Detail = "medium"): THREE.BufferGeometry {
  const [x, y, z] = size;
  const s = SEGMENTS[detail];
  switch (shape) {
    case "box": return new THREE.BoxGeometry(x, y, z);
    case "wedge": return wedgeGeometry().scale(x, y, z);
    case "cylinder": return new THREE.CylinderGeometry(0.5, 0.5, 1, s.radial).scale(x, y, z);
    case "cone": return new THREE.ConeGeometry(0.5, 1, s.radial).scale(x, y, z);
    case "sphere": return new THREE.SphereGeometry(0.5, s.sphereW, s.sphereH).scale(x, y, z);
    case "octahedron": return new THREE.OctahedronGeometry(0.5).scale(x, y, z);
    case "icosahedron": return new THREE.IcosahedronGeometry(0.5, detail === "high" ? 1 : 0).scale(x, y, z);
    case "prism": return new THREE.CylinderGeometry(0.5, 0.5, 1, 3).rotateY(H).scale(x, y, z);
    case "crescent": return crescentGeometry(detail === "low" ? 8 : detail === "high" ? 18 : 12).scale(x, y, z);
    case "torus": {
      const tube = Math.min(z, x * 0.45) / 2;
      const R = Math.max(0.001, x / 2 - tube);
      return new THREE.TorusGeometry(R, Math.max(0.0005, tube), s.torusT, s.torusR).scale(1, y / Math.max(x, 1e-4), 1);
    }
    case "capsule": {
      const r = Math.max(0.0005, Math.min(x, z) / 2);
      const len = Math.max(0, y - 2 * r);
      return new THREE.CapsuleGeometry(r, len, 4, s.radial).scale(x / (2 * r), 1, z / (2 * r));
    }
    default: return new THREE.BoxGeometry(x, y, z);
  }
}

// ------------------------------------------------------------------------------------------------ materials

const METAL: ReadonlySet<BlueprintRole> = new Set<BlueprintRole>([
  "blade", "head", "guard", "pommel", "spike", "barrel", "rim", "ring", "plate", "helm", "visor", "pauldron", "gauntlet", "greave", "trim", "frame",
]);
const GEM: ReadonlySet<BlueprintRole> = new Set<BlueprintRole>(["gem", "orb", "shard", "rune", "crystal", "eye"]);

/** Builds the MeshStandardMaterial for a part (role-based defaults when metalness / roughness are omitted). */
export function makePartMaterial(m: Material, role: BlueprintRole, dim = 0): THREE.MeshStandardMaterial {
  const metal = METAL.has(role);
  const gem = GEM.has(role);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(m.color),
    metalness: m.metalness ?? (metal ? 0.35 : gem ? 0.1 : 0.05),
    roughness: m.roughness ?? (metal ? 0.35 : gem ? 0.2 : 0.7),
    flatShading: m.flatShading ?? true,
  });
  if (m.emissive) {
    mat.emissive.set(m.emissive);
    mat.emissiveIntensity = m.emissiveIntensity ?? 1;
  } else {
    // A faint self-glow of the part's own colour keeps blueprints readable in dark scenes.
    mat.emissive.set(m.color);
    mat.emissiveIntensity = 0.08;
  }
  if (m.opacity !== undefined && m.opacity < 1) {
    mat.transparent = true;
    mat.opacity = m.opacity;
    mat.depthWrite = m.opacity > 0.6;
  }
  if (dim > 0) {
    mat.color.multiplyScalar(1 - Math.min(1, dim));
    mat.emissiveIntensity *= Math.max(0.1, 1 - Math.min(1, dim) * 1.5);
  }
  return mat;
}

// ------------------------------------------------------------------------------------------------ quick particles

const PARTICLE_MOTION: Record<ParticleKind, { speed: number; spread: number; size: number; spin: number }> = {
  embers: { speed: 0.5, spread: 0.25, size: 0.035, spin: 4 },
  frost: { speed: 0.18, spread: 0.35, size: 0.04, spin: 2 },
  sparks: { speed: 0.9, spread: 0.6, size: 0.025, spin: 9 },
  motes: { speed: 0.12, spread: 0.3, size: 0.03, spin: 1 },
  smoke: { speed: 0.22, spread: 0.2, size: 0.07, spin: 0.5 },
  bubbles: { speed: 0.3, spread: 0.25, size: 0.04, spin: 0 },
};

interface QuickEmitter { mesh: THREE.InstancedMesh; update: (t: number) => void }

/**
 * Counterforge quick particles: an InstancedMesh of tiny additive octahedra cycling around the business end (top
 * 40 % of the model), deterministic in t.
 */
function makeQuickEmitter(kind: ParticleKind, color: THREE.Color, rate: number, box: THREE.Box3, measure: number): QuickEmitter {
  const n = Math.max(6, Math.min(40, Math.round(rate * 1.2)));
  const period = n / Math.max(rate, 1);
  const motion = PARTICLE_MOTION[kind];
  const size = motion.size * measure;
  const geo = kind === "bubbles" ? new THREE.IcosahedronGeometry(0.5, 0) : new THREE.OctahedronGeometry(0.5);
  geo.scale(size, size, size);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: kind === "smoke" ? 0.45 : 0.9,
    blending: kind === "smoke" ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.name = "blueprintParticles";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.renderOrder = 2;
  const lo = new THREE.Vector3(box.min.x, box.min.y + (box.max.y - box.min.y) * 0.6, box.min.z);
  const span = new THREE.Vector3().subVectors(box.max, lo);
  const seeds = Array.from({ length: n }, (_, i) => {
    const h = (k: number) => {
      const v = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453;
      return v - Math.floor(v);
    };
    return { x: h(1), y: h(2), z: h(3), dx: h(4) - 0.5, dz: h(5) - 0.5, ph: i / n };
  });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const update = (t: number) => {
    for (let i = 0; i < n; i++) {
      const sd = seeds[i];
      const age = (((t / period + sd.ph) % 1) + 1) % 1;
      const travel = age * period * motion.speed * measure;
      p.set(lo.x + span.x * sd.x, lo.y + span.y * sd.y, lo.z + span.z * sd.z);
      p.x += sd.dx * motion.spread * measure * age;
      p.z += sd.dz * motion.spread * measure * age;
      p.y += kind === "frost" ? -travel * 0.5 : travel;
      if (kind === "bubbles") p.x += Math.sin(t * 6 + i) * 0.02 * measure;
      if (kind === "sparks") {
        p.x += Math.sin(t * 40 + i * 3) * 0.01 * measure;
        p.z += Math.cos(t * 37 + i) * 0.01 * measure;
      }
      const k = kind === "smoke" ? 0.6 + age * 1.6 : 1 - age * 0.7;
      s.setScalar(Math.max(0.001, k));
      e.set(t * motion.spin + i, t * motion.spin * 0.7, 0);
      q.setFromEuler(e);
      mesh.setMatrixAt(i, m.compose(p, q, s));
      mesh.setColorAt(i, c.copy(color).multiplyScalar(1 - age));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };
  update(0);
  return { mesh, update };
}

// ------------------------------------------------------------------------------------------------ object

interface Animated {
  pivot: THREE.Object3D;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  part: BlueprintPart;
  base: { pos: THREE.Vector3; rot: THREE.Euler; ei: number };
  phase0: number;
  axis: "x" | "y" | "z";
  amp: number;
}

/**
 * Local axis a "spin" turns about: rings and crescents about their normal (Z); a clearly flat part about its thin
 * axis; anything else about its length axis (Y).
 */
function spinAxis(part: BlueprintPart): "x" | "y" | "z" {
  if (part.shape === "torus" || part.shape === "crescent") return "z";
  const s = part.size;
  const order = [0, 1, 2].sort((a, b) => s[a] - s[b]);
  if (s[order[0]] < 0.5 * s[order[1]]) return (["x", "y", "z"] as const)[order[0]];
  return "y";
}

/**
 * A built blueprint: a THREE.Group with per-part animation, named attachment points, LOD and dispose.
 * Add it to your scene like any object; call `animate(t)` each frame (seconds) unless built with `autoAnimate`.
 */
export class BlueprintObject extends THREE.Group {
  /** The (clamped) blueprint this was built from. */
  readonly blueprint: Blueprint;
  /** Attachment points by name ("grip", "tip", "socket_back" ...), as empty Object3Ds in model space. */
  readonly attachments: Record<string, THREE.Object3D> = {};
  /** Uniform scale applied to reach `length` (1 when no length was requested). */
  readonly scaleFactor: number;
  /** Longest extent of the unscaled model (m). */
  readonly measure: number;
  /** Quick-FX descriptors. */
  readonly fx: BlueprintFx;
  /** VFX objects built from `bp.vfx` (already attached). */
  readonly effects: VfxObject[] = [];
  /** @internal */
  _animated: Animated[] = [];
  /** @internal */
  _quick: QuickEmitter | null = null;
  /** @internal */
  _content: THREE.Group;
  /** @internal */
  _impostor: THREE.Mesh | null = null;
  /** @internal */
  _floatCap = 0;
  private lodState = { far: false, dropped: false };
  private clock = 0;

  /** @internal use buildBlueprint */
  constructor(bp: Blueprint, content: THREE.Group, scaleFactor: number, measure: number, fx: BlueprintFx) {
    super();
    this.name = bp.name ? `blueprint:${bp.name}` : "blueprint";
    this.blueprint = bp;
    this._content = content;
    this.scaleFactor = scaleFactor;
    this.measure = measure;
    this.fx = fx;
    this.userData.liveforgeBlueprint = true;
    this.userData.palette = bp.palette;
  }

  /** This object (the K0 skeleton's `BuiltBlueprint.object`). */
  get object(): this {
    return this;
  }

  /** Advances the internal clock by `dt` seconds and animates (alternative to `animate(t)`). */
  update(dt: number): void {
    if (!Number.isFinite(dt)) return;
    this.clock += dt;
    this.animate(this.clock);
  }

  /** An attachment point by name (or the first of a kind: "grip", "tip", "vfx" ...). */
  attachment(nameOrKind: string): THREE.Object3D | undefined {
    if (this.attachments[nameOrKind]) return this.attachments[nameOrKind];
    return Object.values(this.attachments).find((o) => o.userData.attachmentKind === nameOrKind);
  }

  /** Advances part animations, quick particles and VFX to time `t` (seconds, any monotonic clock). */
  animate(t: number): void {
    if (!Number.isFinite(t)) return;
    for (const a of this._animated) {
      const { kind, speed, amount } = a.part.anim!;
      const ph = speed * t + a.phase0;
      switch (kind) {
        case "spin":
          a.mesh.rotation[a.axis] = speed * t;
          break;
        case "pulse": {
          const k = Math.sin(ph * 2);
          a.mesh.scale.setScalar(1 + amount * 0.35 * k);
          a.mat.emissiveIntensity = a.base.ei * (1 + amount * k);
          break;
        }
        case "float":
          a.pivot.position.y = a.base.pos.y + Math.min(a.amp, this._floatCap) * Math.sin(ph);
          a.mesh.rotation.y = t * 0.6;
          break;
        case "orbit":
          a.pivot.position.set(Math.cos(ph) * a.amp, a.base.pos.y + Math.sin(ph * 1.7) * 0.02 * this.measure, Math.sin(ph) * a.amp);
          a.mesh.rotation.y = speed * t * 1.5;
          break;
        case "flicker": {
          const n = 0.5 + 0.25 * Math.sin(t * speed * 1.7 + a.phase0) + 0.25 * Math.sin(t * speed * 2.93 + a.phase0 * 2);
          a.mat.emissiveIntensity = a.base.ei * (1 - amount * 0.6 + amount * 1.2 * n);
          a.mesh.scale.set(1, 1 + amount * 0.25 * (n - 0.5), 1);
          break;
        }
        case "wobble":
          a.pivot.rotation.set(a.base.rot.x + amount * 0.25 * Math.sin(ph * 0.8), a.base.rot.y, a.base.rot.z + amount * 0.6 * Math.sin(ph));
          break;
      }
    }
    this._quick?.update(t);
  }

  /**
   * Applies the blueprint's LOD hint for a viewer `distance` (m) or camera: hides `lod.dropRolesFar` parts beyond
   * half the impostor distance (default 15 m) and swaps to a single-colour box impostor beyond `lod.impostorDistance`.
   */
  updateLod(distanceOrCamera: number | THREE.Camera): void {
    let d: number;
    if (typeof distanceOrCamera === "number") d = distanceOrCamera;
    else {
      const wp = new THREE.Vector3();
      this.getWorldPosition(wp);
      d = distanceOrCamera.getWorldPosition(new THREE.Vector3()).distanceTo(wp);
    }
    const lod = this.blueprint.lod;
    const far = lod?.impostorDistance;
    const dropAt = far ? far * 0.5 : 15;
    const dropped = !!lod?.dropRolesFar?.length && d > dropAt;
    if (dropped !== this.lodState.dropped) {
      this.lodState.dropped = dropped;
      const roles = new Set<string>(lod?.dropRolesFar ?? []);
      this._content.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && roles.has(o.userData.role as string)) o.visible = !dropped;
      });
    }
    const isFar = far !== undefined && d > far;
    if (isFar !== this.lodState.far) {
      this.lodState.far = isFar;
      if (isFar && !this._impostor) {
        const box = new THREE.Box3().setFromObject(this._content);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        this.worldToLocal(center);
        const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(this.blueprint.palette[0]) });
        this._impostor = new THREE.Mesh(new THREE.BoxGeometry(size.x / this.scaleFactor, size.y / this.scaleFactor, size.z / this.scaleFactor), mat);
        this._impostor.position.copy(center);
        this._impostor.name = "impostor";
        this.add(this._impostor);
      }
      if (this._impostor) this._impostor.visible = isFar;
      this._content.visible = !isFar;
    }
  }

  /** Detaches and frees every geometry, material, instance buffer and VFX this object owns. */
  override dispose(): void {
    for (const fx of this.effects) fx.dispose();
    disposeObject(this);
    superDispose(this);
  }
}

/**
 * protocol clampBlueprint, plus the fields it does not carry over yet: `vfx[]` (each clamped with clampVfx) and the
 * LOD hint's `dropRolesFar` / `impostorDistance`.
 */
function clampWithExtras(input: unknown, limits?: Partial<BlueprintLimits>): Blueprint | null {
  const bp = clampBlueprint(input, limits);
  if (!bp || typeof input !== "object" || input === null) return bp;
  const raw = input as { vfx?: unknown; lod?: { dropRolesFar?: unknown; impostorDistance?: unknown } };
  if (Array.isArray(raw.vfx) && !bp.vfx) {
    const vfx = raw.vfx.slice(0, 4).map((r) => clampVfx(r, bp.palette[0])).filter((r): r is VfxRecipe => !!r);
    if (vfx.length) bp.vfx = vfx;
  }
  if (bp.lod && raw.lod && typeof raw.lod === "object") {
    if (Array.isArray(raw.lod.dropRolesFar) && !bp.lod.dropRolesFar) {
      const roles = raw.lod.dropRolesFar.filter((r): r is BlueprintRole => typeof r === "string" && (BLUEPRINT_ROLES as readonly string[]).includes(r));
      if (roles.length) bp.lod.dropRolesFar = roles;
    }
    const d = raw.lod.impostorDistance;
    if (typeof d === "number" && Number.isFinite(d) && d > 0 && bp.lod.impostorDistance === undefined) bp.lod.impostorDistance = Math.min(500, d);
  }
  return bp;
}

/**
 * Builds a Blueprint v1 into a {@link BlueprintObject}. Held items: the grip is the origin and the item extends
 * along +Y. Clamps the input first by default, so any server / LLM / user blueprint is safe to pass.
 * Throws only when nothing usable is left (no parts).
 *
 * ```ts
 * const sword = buildBlueprint(item.blueprint, { length: 1.1 });
 * hand.add(sword);
 * renderer.setAnimationLoop((ms) => sword.animate(ms / 1000));
 * ```
 */
export function buildBlueprint(input: Blueprint | unknown, opts: BuildBlueprintOptions = {}): BlueprintObject {
  const bp = opts.clamp === false ? (input as Blueprint) : clampWithExtras(input, opts.limits);
  if (!bp || !Array.isArray(bp.parts) || bp.parts.length === 0) throw new Error("[liveforge] blueprint has no usable parts");
  const detail: Detail = opts.detail ?? bp.lod?.detail ?? "medium";
  const dim = opts.dim ?? 0;
  const castShadow = opts.castShadow ?? true;
  const content = new THREE.Group();
  content.name = "blueprintContent";
  const animated: Animated[] = [];

  // Attachment points first so parts can hang from them.
  const attachments: Record<string, THREE.Object3D> = {};
  for (const a of bp.attachments ?? []) {
    const o = new THREE.Object3D();
    o.name = `attach:${a.name}`;
    o.position.set(...a.position);
    if (a.rotation) o.rotation.set(...a.rotation);
    o.userData.attachmentKind = a.kind ?? "other";
    o.userData.attachmentName = a.name;
    content.add(o);
    attachments[a.name] = o;
  }

  bp.parts.forEach((part, index) => {
    const geo = partGeometry(part.shape, part.size, detail);
    const mat = makePartMaterial(resolvePartMaterial(bp, part), part.role, dim);
    const parent = (part.parent && attachments[part.parent]) || content;
    const copies: Array<{ pos: THREE.Vector3; rot: THREE.Euler }> = [
      { pos: new THREE.Vector3(...part.offset), rot: new THREE.Euler(...part.rotation) },
    ];
    const [ox, oy, oz] = part.offset;
    const [rx, ry, rz] = part.rotation;
    // Reflection across YZ (x) / XY (z): M R M = Rx(a) Ry(-b) Rz(-c) for x, Rx(-a) Ry(-b) Rz(c) for z.
    if (part.mirror === "x") copies.push({ pos: new THREE.Vector3(-ox, oy, oz), rot: new THREE.Euler(rx, -ry, -rz) });
    if (part.mirror === "z") copies.push({ pos: new THREE.Vector3(ox, oy, -oz), rot: new THREE.Euler(-rx, -ry, rz) });
    copies.forEach((c, ci) => {
      const pivot = new THREE.Object3D();
      pivot.position.copy(c.pos);
      pivot.rotation.copy(c.rot);
      const copyMat = ci === 0 ? mat : mat.clone();
      const mesh = new THREE.Mesh(geo, copyMat);
      mesh.name = `${part.id ?? part.role}_${index}${ci ? "_m" : ""}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = castShadow;
      mesh.userData.role = part.role;
      mesh.userData.partIndex = index;
      if (part.id) mesh.userData.partId = part.id;
      if (typeof part.material === "string") mesh.userData.materialName = part.material;
      copyMat.name = typeof part.material === "string" ? part.material : part.role;
      pivot.add(mesh);
      parent.add(pivot);
      if (part.anim && part.anim.speed > 0 && (part.anim.amount > 0 || part.anim.kind === "spin")) {
        const orbitR = Math.hypot(c.pos.x, c.pos.z);
        animated.push({
          pivot, mesh, mat: copyMat, part,
          base: { pos: c.pos.clone(), rot: c.rot.clone(), ei: copyMat.emissiveIntensity },
          phase0: part.anim.kind === "orbit" ? Math.atan2(c.pos.z, c.pos.x) : index * 0.6 + ci * 1.3,
          axis: spinAxis(part),
          amp: part.anim.kind === "orbit" ? (part.anim.amount > 0.01 ? part.anim.amount : orbitR) : part.anim.amount,
        });
      }
    });
  });

  // Measure the static pose, then scale to the requested length.
  content.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(content);
  const ext = box.getSize(new THREE.Vector3());
  const measure = Math.max(ext.x, ext.y, ext.z, 1e-3);
  const scale = opts.length && opts.length > 0 ? opts.length / measure : 1;
  const toHex = (c: string) => new THREE.Color(c).getHex();
  const tipAttach = Object.values(attachments).find((o) => o.userData.attachmentKind === "tip");
  const fx: BlueprintFx = {
    tip: tipAttach ? tipAttach.position.clone().multiplyScalar(scale) : new THREE.Vector3(0, Math.max(0, box.max.y) * scale, 0),
    palette: bp.palette.map(toHex),
  };
  if (bp.trail) fx.trail = { color: toHex(bp.trail.color), width: bp.trail.width * scale };
  if (bp.particles) fx.particles = { kind: bp.particles.kind, color: toHex(bp.particles.color), rate: bp.particles.rate };

  const root = new BlueprintObject(bp, content, scale, measure, fx);
  root.add(content);
  root.scale.setScalar(scale);
  Object.assign(root.attachments, attachments);
  root._animated = animated;
  root._floatCap = 0.12 * measure;

  // A "tip" attachment always exists (VFX / trails default to it).
  if (!root.attachments.tip) {
    const tip = new THREE.Object3D();
    tip.name = "attach:tip";
    tip.position.set(0, Math.max(0, box.max.y), 0);
    tip.userData.attachmentKind = "tip";
    tip.userData.attachmentName = "tip";
    tip.userData.implicit = true;
    content.add(tip);
    root.attachments.tip = tip;
  }

  if (opts.vfx !== false) {
    if (bp.particles && bp.particles.rate > 0) {
      root._quick = makeQuickEmitter(bp.particles.kind, new THREE.Color(bp.particles.color), bp.particles.rate, box, measure);
      if (dim > 0.3) root._quick.mesh.visible = false;
      content.add(root._quick.mesh);
    }
    for (const recipe of bp.vfx ?? []) {
      const fxObj = buildVfx(recipe, { attachments: root.attachments });
      (root.attachment(recipe.attach ?? "") ?? content).add(fxObj);
      root.effects.push(fxObj);
    }
    if (opts.trail && bp.trail) {
      const trail = buildVfx(
        { v: 1, emitters: [], trails: [{ width: bp.trail.width, lifetime: 0.25, colorRamp: [{ t: 0, color: bp.trail.color, alpha: 0.9 }, { t: 1, color: bp.trail.color, alpha: 0 }], blend: "additive", attach: "tip" }] },
        { attachments: root.attachments, clamp: false },
      );
      content.add(trail);
      root.effects.push(trail);
    }
  }

  if (opts.autoAnimate) {
    const clock = typeof performance !== "undefined" ? () => performance.now() / 1000 : () => Date.now() / 1000;
    const carrier = content.getObjectsByProperty("isMesh", true)[0] as THREE.Mesh | undefined;
    if (carrier) carrier.onBeforeRender = () => root.animate(clock());
  }

  root.updateMatrixWorld(true);
  return root;
}
