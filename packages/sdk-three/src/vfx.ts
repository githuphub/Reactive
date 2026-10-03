// VFX recipe v1 -> THREE.Group: CPU-simulated point-sprite emitters (one draw call each), camera-facing ribbon
// trails, auras (sphere / ring / column / ground decal) and point lights. Engine-neutral recipe: protocol vfx.ts.
import * as THREE from "three";
import { clampVfx, type ColorStop, type Emitter, type SizeKey, type Trail, type VfxRecipe } from "@liveforge/protocol";
import { disposeObject, superDispose } from "./dispose.js";

export interface BuildVfxOptions {
  /** Run protocol `clampVfx` first (recommended for network input). Default true. */
  clamp?: boolean;
  /** Tick from the render loop automatically. Default true. Set false and call `update(dt)` yourself if you prefer. */
  autoUpdate?: boolean;
  /** Attachment points to resolve trail `attach` names against (a BlueprintObject's `attachments`). */
  attachments?: Record<string, THREE.Object3D>;
  /** Particle count / rate multiplier 0.1-2 (quality setting). Default 1. */
  quality?: number;
  /** Start playing immediately. Default true. */
  autoplay?: boolean;
  /** Called once when a finite effect (with `duration`) has finished and its particles died. */
  onFinished?: (fx: VfxObject) => void;
  /** Remove and dispose the effect when it finishes. Default false. */
  disposeOnFinish?: boolean;
  /** Seed for the particle RNG (deterministic effects). */
  seed?: number;
}

const SPRITE_INDEX: Record<string, number> = {
  spark: 3, ember: 0, smoke: 0, mote: 0, shard: 2, bubble: 1, ring: 1, glyph: 5, flame: 4, snow: 6, leaf: 4,
};

const VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
attribute float aSpin;
uniform float uScale;
varying vec4 vColor;
varying float vSpin;
void main() {
  vColor = aColor;
  vSpin = aSpin;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / max(0.05, -mv.z);
}`;

const FRAG = /* glsl */ `
uniform int uSprite;
varying vec4 vColor;
varying float vSpin;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float c = cos(vSpin), s = sin(vSpin);
  p = mat2(c, -s, s, c) * p;
  float r = length(p);
  float a;
  if (uSprite == 1) {            // ring / bubble
    a = smoothstep(1.0, 0.82, r) * smoothstep(0.45, 0.7, r);
  } else if (uSprite == 2) {     // shard: diamond
    a = 1.0 - smoothstep(0.85, 1.0, abs(p.x) * 1.6 + abs(p.y));
  } else if (uSprite == 3) {     // spark: 4-point star
    float st = max(1.0 - abs(p.x) * 5.0, 1.0 - abs(p.y) * 5.0);
    a = clamp(st, 0.0, 1.0) * (1.0 - smoothstep(0.2, 1.0, r)) + (1.0 - smoothstep(0.0, 0.35, r));
  } else if (uSprite == 4) {     // flame / leaf: teardrop
    float d = length(vec2(p.x * 1.7, p.y + 0.25 * (1.0 - p.y)));
    a = 1.0 - smoothstep(0.6, 0.95, d);
  } else if (uSprite == 5) {     // glyph: square rune
    vec2 q = abs(p);
    a = step(max(q.x, q.y), 0.8) * (1.0 - step(max(q.x, q.y), 0.55) * step(min(q.x, q.y), 0.4));
  } else if (uSprite == 6) {     // snow: 6-arm flake
    float ang = atan(p.y, p.x);
    float arm = abs(cos(ang * 3.0));
    a = (1.0 - smoothstep(0.0, 1.0, r)) * (0.35 + 0.65 * smoothstep(0.6, 1.0, arm));
  } else {                       // soft round (ember, mote, smoke)
    a = 1.0 - smoothstep(0.0, 1.0, r);
    a *= a;
  }
  float alpha = vColor.a * a;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

type Rng = () => number;
function mulberry(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RampLin { t: number; r: number; g: number; b: number; a: number }
function linRamp(stops: ColorStop[]): RampLin[] {
  const c = new THREE.Color();
  return stops.map((s) => {
    c.set(s.color);
    return { t: s.t, r: c.r, g: c.g, b: c.b, a: s.alpha ?? 1 };
  });
}
function sampleRamp(r: RampLin[], t: number, out: [number, number, number, number]): void {
  if (t <= r[0].t || r.length === 1) {
    out[0] = r[0].r; out[1] = r[0].g; out[2] = r[0].b; out[3] = r[0].a;
    return;
  }
  for (let i = 1; i < r.length; i++) {
    if (t <= r[i].t) {
      const a = r[i - 1];
      const b = r[i];
      const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      out[0] = a.r + (b.r - a.r) * k; out[1] = a.g + (b.g - a.g) * k; out[2] = a.b + (b.b - a.b) * k; out[3] = a.a + (b.a - a.a) * k;
      return;
    }
  }
  const l = r[r.length - 1];
  out[0] = l.r; out[1] = l.g; out[2] = l.b; out[3] = l.a;
}
function sampleCurve(c: SizeKey[], t: number): number {
  if (t <= c[0].t || c.length === 1) return c[0].size;
  for (let i = 1; i < c.length; i++) {
    if (t <= c[i].t) {
      const k = (t - c[i - 1].t) / Math.max(1e-6, c[i].t - c[i - 1].t);
      return c[i - 1].size + (c[i].size - c[i - 1].size) * k;
    }
  }
  return c[c.length - 1].size;
}

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _rgba: [number, number, number, number] = [0, 0, 0, 0];

/** One emitter: a fixed pool of particles drawn as one THREE.Points. */
class ParticleEmitter {
  readonly points: THREE.Points;
  private readonly max: number;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly spin: Float32Array;
  private readonly spinRate: Float32Array;
  private alive = 0;
  private acc = 0;
  private readonly ramp: RampLin[];
  private readonly dir: THREE.Vector3;
  readonly material: THREE.ShaderMaterial;

  constructor(readonly e: Emitter, private readonly rng: Rng, private readonly quality: number, private readonly owner: THREE.Object3D) {
    this.max = Math.max(1, Math.round(e.maxParticles * quality));
    this.pos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.age = new Float32Array(this.max);
    this.life = new Float32Array(this.max);
    this.col = new Float32Array(this.max * 4);
    this.size = new Float32Array(this.max);
    this.spin = new Float32Array(this.max);
    this.spinRate = new Float32Array(this.max);
    this.ramp = linRamp(e.colorRamp);
    this.dir = new THREE.Vector3(...e.velocity.dir);
    if (this.dir.lengthSq() < 1e-8) this.dir.set(0, 1, 0);
    this.dir.normalize();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aSpin", new THREE.BufferAttribute(this.spin, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uScale: { value: 400 }, uSprite: { value: SPRITE_INDEX[e.sprite] ?? 0 } },
      transparent: true,
      depthWrite: false,
      blending: e.blend === "alpha" ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.name = `emitter:${e.sprite}`;
    if (!e.local) {
      // World-space particles: positions are stored in world coordinates, so the Points ignore their parents.
      this.points.matrixAutoUpdate = false;
      this.points.matrixWorldAutoUpdate = false;
      this.points.matrixWorld.identity();
    }
  }

  get count(): number {
    return this.alive;
  }

  spawn(n: number): void {
    const e = this.e;
    const world = !e.local;
    const m = this.owner.matrixWorld;
    for (let k = 0; k < n && this.alive < this.max; k++) {
      const i = this.alive++;
      this.samplePosition(_v);
      if (e.offset) _v.add(_d.set(...e.offset));
      const spread = e.shape === "cone" ? Math.min(1, (e.angle ?? 25) / 90) : e.velocity.spread;
      this.randomUnit(_u);
      _d.copy(this.dir).lerp(_u, spread);
      if (_d.lengthSq() < 1e-8) _d.copy(this.dir);
      _d.normalize();
      const [s0, s1] = e.velocity.speed;
      _d.multiplyScalar(s0 + (s1 - s0) * this.rng());
      if (world) {
        _v.applyMatrix4(m);
        const sp = _d.length(); // transformDirection normalises: keep the sampled speed
        _d.transformDirection(m).multiplyScalar(sp);
      }
      this.pos[i * 3] = _v.x; this.pos[i * 3 + 1] = _v.y; this.pos[i * 3 + 2] = _v.z;
      this.vel[i * 3] = _d.x; this.vel[i * 3 + 1] = _d.y; this.vel[i * 3 + 2] = _d.z;
      const [l0, l1] = e.lifetime;
      this.life[i] = Math.max(0.05, l0 + (l1 - l0) * this.rng());
      this.age[i] = 0;
      this.spin[i] = this.rng() * Math.PI * 2;
      this.spinRate[i] = (e.spin ?? 0) * (0.6 + this.rng() * 0.8);
    }
  }

  private samplePosition(out: THREE.Vector3): void {
    const e = this.e;
    const r = e.radius ?? 0.2;
    switch (e.shape) {
      case "sphere": {
        this.randomUnit(out).multiplyScalar(r * Math.cbrt(this.rng()));
        break;
      }
      case "box": {
        const [x, y, z] = e.extents ?? [0.4, 0.4, 0.4];
        out.set((this.rng() - 0.5) * x, (this.rng() - 0.5) * y, (this.rng() - 0.5) * z);
        break;
      }
      case "ring": {
        const a = this.rng() * Math.PI * 2;
        out.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        break;
      }
      case "line": {
        const len = e.extents?.[0] ?? r * 2;
        out.set((this.rng() - 0.5) * len, 0, 0);
        break;
      }
      case "cone": {
        const a = this.rng() * Math.PI * 2;
        const rr = (e.radius ?? 0.05) * Math.sqrt(this.rng());
        out.set(Math.cos(a) * rr, 0, Math.sin(a) * rr);
        break;
      }
      default:
        out.set(0, 0, 0);
    }
  }

  private randomUnit(out: THREE.Vector3): THREE.Vector3 {
    const z = this.rng() * 2 - 1;
    const a = this.rng() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    return out.set(s * Math.cos(a), z, s * Math.sin(a));
  }

  update(dt: number, emitting: boolean): void {
    const e = this.e;
    if (emitting && e.rate > 0) {
      this.acc += e.rate * this.quality * dt;
      const n = Math.floor(this.acc);
      if (n > 0) {
        this.acc -= n;
        this.spawn(n);
      }
    }
    const g = e.gravity ?? 0;
    const drag = Math.max(0, 1 - (e.drag ?? 0) * dt);
    for (let i = 0; i < this.alive; ) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.kill(i);
        continue;
      }
      const i3 = i * 3;
      this.vel[i3 + 1] -= g * dt;
      this.vel[i3] *= drag; this.vel[i3 + 1] *= drag; this.vel[i3 + 2] *= drag;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.spin[i] += this.spinRate[i] * dt;
      const t = this.age[i] / this.life[i];
      sampleRamp(this.ramp, t, _rgba);
      this.col[i * 4] = _rgba[0]; this.col[i * 4 + 1] = _rgba[1]; this.col[i * 4 + 2] = _rgba[2]; this.col[i * 4 + 3] = _rgba[3];
      this.size[i] = sampleCurve(e.sizeCurve, t);
      i++;
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, this.alive);
    for (const name of ["position", "aColor", "aSize", "aSpin"]) (geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
  }

  private kill(i: number): void {
    const last = --this.alive;
    if (i === last) return;
    for (let k = 0; k < 3; k++) {
      this.pos[i * 3 + k] = this.pos[last * 3 + k];
      this.vel[i * 3 + k] = this.vel[last * 3 + k];
    }
    for (let k = 0; k < 4; k++) this.col[i * 4 + k] = this.col[last * 4 + k];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.size[i] = this.size[last];
    this.spin[i] = this.spin[last];
    this.spinRate[i] = this.spinRate[last];
  }

  clear(): void {
    this.alive = 0;
    this.acc = 0;
    this.points.geometry.setDrawRange(0, 0);
  }
}

/** A camera-facing ribbon that follows an object (swing / projectile trails). World space. */
class TrailRibbon {
  readonly mesh: THREE.Mesh;
  private readonly maxPts = 48;
  private readonly pts: Array<{ p: THREE.Vector3; t: number }> = [];
  private readonly posArr: Float32Array;
  private readonly colArr: Float32Array;
  private readonly ramp: RampLin[];
  private time = 0;
  cameraPos = new THREE.Vector3(0, 2, 6);

  constructor(readonly trail: Trail, readonly follow: THREE.Object3D) {
    this.posArr = new Float32Array(this.maxPts * 2 * 3);
    this.colArr = new Float32Array(this.maxPts * 2 * 4);
    this.ramp = linRamp(trail.colorRamp);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("color", new THREE.BufferAttribute(this.colArr, 4).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < this.maxPts - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: trail.blend === "alpha" ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "trail";
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.matrixWorld.identity();
    this.mesh.renderOrder = 3;
  }

  update(dt: number, emitting: boolean): void {
    this.time += dt;
    const life = Math.max(0.02, this.trail.lifetime);
    if (emitting) {
      const p = this.follow.getWorldPosition(new THREE.Vector3());
      const head = this.pts[0];
      if (!head || head.p.distanceToSquared(p) > 1e-6) this.pts.unshift({ p, t: this.time });
      else head.t = this.time;
    }
    while (this.pts.length > this.maxPts || (this.pts.length && this.time - this.pts[this.pts.length - 1].t > life)) this.pts.pop();
    const n = this.pts.length;
    const geo = this.mesh.geometry;
    if (n < 2) {
      geo.setDrawRange(0, 0);
      return;
    }
    const side = new THREE.Vector3();
    const seg = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const cur = this.pts[i].p;
      const nb = this.pts[Math.min(n - 1, i + 1)].p;
      const pv = this.pts[Math.max(0, i - 1)].p;
      seg.subVectors(pv, nb);
      if (seg.lengthSq() < 1e-10) seg.set(0, 1, 0);
      toCam.subVectors(this.cameraPos, cur);
      side.crossVectors(seg, toCam).normalize();
      const age = Math.min(1, (this.time - this.pts[i].t) / life);
      const w = this.trail.width * 0.5 * (1 - age * 0.7);
      this.posArr.set([cur.x + side.x * w, cur.y + side.y * w, cur.z + side.z * w, cur.x - side.x * w, cur.y - side.y * w, cur.z - side.z * w], i * 6);
      sampleRamp(this.ramp, age, _rgba);
      this.colArr.set([_rgba[0], _rgba[1], _rgba[2], _rgba[3], _rgba[0], _rgba[1], _rgba[2], _rgba[3]], i * 8);
    }
    geo.setDrawRange(0, (n - 1) * 6);
    (geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.pts.length = 0;
    this.mesh.geometry.setDrawRange(0, 0);
  }
}

let radialTex: THREE.DataTexture | null = null;
/** Shared soft radial gradient (ground decals). */
function radialTexture(): THREE.DataTexture {
  if (radialTex) return radialTex;
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n * 2 - 1;
      const dy = (y + 0.5) / n * 2 - 1;
      const r = Math.min(1, Math.hypot(dx, dy));
      const a = Math.pow(1 - r, 1.6) * (0.6 + 0.4 * Math.cos(r * 18) * (1 - r));
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }
  radialTex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  radialTex.needsUpdate = true;
  radialTex.userData.shared = true;
  return radialTex;
}

interface AuraRt { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; baseOpacity: number; pulse?: { speed: number; amount: number } }
interface LightRt { light: THREE.PointLight; base: number; flicker: number; seed: number }

/**
 * A built VFX recipe. Plays on its own (autoUpdate) or when you call `update(dt)`. Parent it to the object the
 * effect belongs to (a blueprint attachment, an NPC, a spell projectile).
 */
export class VfxObject extends THREE.Group {
  readonly recipe: VfxRecipe;
  /** Seconds since play(). */
  elapsed = 0;
  /** Emitting new particles. */
  playing = false;
  /** A finite effect ended and all particles died. */
  finished = false;
  private readonly emitters: ParticleEmitter[] = [];
  private readonly trails: TrailRibbon[] = [];
  private readonly auras: AuraRt[] = [];
  private readonly lights: LightRt[] = [];
  private readonly opts: BuildVfxOptions;
  private lastTick = -1;
  private disposed = false;

  /** @internal use buildVfx */
  constructor(recipe: VfxRecipe, opts: BuildVfxOptions) {
    super();
    this.recipe = recipe;
    this.opts = opts;
    this.name = recipe.name ? `vfx:${recipe.name}` : "vfx";
    const rng = mulberry(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    const quality = Math.min(2, Math.max(0.1, opts.quality ?? 1));
    for (const e of recipe.emitters ?? []) {
      const pe = new ParticleEmitter(e, rng, quality, this);
      this.emitters.push(pe);
      this.add(pe.points);
    }
    for (const t of recipe.trails ?? []) {
      const follow = (t.attach && opts.attachments?.[t.attach]) || opts.attachments?.tip || this;
      const tr = new TrailRibbon(t, follow);
      this.trails.push(tr);
      this.add(tr.mesh);
    }
    for (const a of recipe.auras ?? []) {
      const color = new THREE.Color(a.color);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      let geo: THREE.BufferGeometry;
      let y = 0;
      switch (a.shape) {
        case "ring":
          geo = new THREE.TorusGeometry(a.radius, Math.max(0.01, a.radius * 0.04), 6, 48).rotateX(Math.PI / 2);
          y = 0.02;
          break;
        case "column": {
          const h = a.height ?? 2;
          geo = new THREE.CylinderGeometry(a.radius, a.radius, h, 32, 1, true);
          y = h / 2;
          break;
        }
        case "ground_decal":
          geo = new THREE.CircleGeometry(a.radius, 40).rotateX(-Math.PI / 2);
          mat.map = radialTexture();
          y = 0.02;
          break;
        default:
          geo = new THREE.SphereGeometry(a.radius, 24, 16);
      }
      const baseOpacity = Math.min(0.85, 0.12 + 0.22 * a.intensity);
      mat.opacity = baseOpacity;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = y;
      mesh.name = `aura:${a.shape}`;
      mesh.renderOrder = 2;
      this.auras.push({ mesh, mat, baseOpacity, ...(a.pulse ? { pulse: a.pulse } : {}) });
      this.add(mesh);
    }
    for (const l of recipe.lights ?? []) {
      const light = new THREE.PointLight(new THREE.Color(l.color), l.intensity, l.range, 2);
      if (l.offset) light.position.set(...l.offset);
      light.name = "vfxLight";
      this.lights.push({ light, base: l.intensity, flicker: l.flicker ?? 0, seed: rng() * 100 });
      this.add(light);
    }
    if (opts.autoUpdate !== false) this.installCarrier();
    if (opts.autoplay !== false) this.play();
  }

  /** (Re)starts emitting; fires bursts. */
  play(): void {
    this.playing = true;
    this.finished = false;
    this.elapsed = 0;
    for (const e of this.emitters) if (e.e.burst) e.spawn(Math.round(e.e.burst * Math.min(2, Math.max(0.1, this.opts.quality ?? 1))));
  }

  /** Stops emitting. `immediate` also clears live particles and trails. */
  stop(immediate = false): void {
    this.playing = false;
    if (immediate) {
      for (const e of this.emitters) e.clear();
      for (const t of this.trails) t.clear();
    }
  }

  /** Fires one extra burst on every emitter (`count` per emitter; default each emitter's `burst` or 12). */
  burst(count?: number): void {
    for (const e of this.emitters) e.spawn(count ?? e.e.burst ?? 12);
  }

  /** Live particles across all emitters. */
  get particleCount(): number {
    return this.emitters.reduce((n, e) => n + e.count, 0);
  }

  /** Advances the simulation by `dt` seconds. Called automatically unless built with `autoUpdate: false`. */
  update(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 0.1);
    this.elapsed += dt;
    const dur = this.recipe.duration;
    if (this.playing && typeof dur === "number" && this.elapsed >= dur) this.playing = false;
    this.updateMatrixWorld();
    for (const e of this.emitters) e.update(dt, this.playing);
    for (const t of this.trails) t.update(dt, this.playing);
    const fade = this.playing ? 1 : Math.max(0, 1 - (typeof dur === "number" ? (this.elapsed - dur) / 0.4 : 1));
    for (const a of this.auras) {
      const k = a.pulse ? 1 + a.pulse.amount * Math.sin(this.elapsed * a.pulse.speed * Math.PI * 2) : 1;
      a.mat.opacity = a.baseOpacity * k * fade;
      if (a.pulse) a.mesh.scale.setScalar(1 + (k - 1) * 0.3);
      a.mesh.visible = a.mat.opacity > 0.003;
    }
    for (const l of this.lights) {
      const n = l.flicker ? 1 - l.flicker * (0.5 + 0.25 * Math.sin(this.elapsed * 23 + l.seed) + 0.25 * Math.sin(this.elapsed * 37.7 + l.seed * 2)) : 1;
      l.light.intensity = l.base * n * fade;
    }
    if (!this.playing && !this.finished && typeof dur === "number" && this.particleCount === 0 && fade <= 0) {
      this.finished = true;
      this.opts.onFinished?.(this);
      if (this.opts.disposeOnFinish) this.dispose();
    }
  }

  /** Detaches and frees GPU resources. */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Keep the shared decal texture alive.
    for (const a of this.auras) if (a.mat.map?.userData.shared) a.mat.map = null;
    disposeObject(this);
    superDispose(this);
  }

  private installCarrier(): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    const carrier = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
    carrier.name = "vfxTicker";
    carrier.frustumCulled = false;
    const size = new THREE.Vector2();
    carrier.onBeforeRender = (renderer, _scene, camera) => {
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
      // Point size scale = drawing-buffer height * projection[1][1] / 2 (perspective cameras).
      renderer.getDrawingBufferSize(size);
      const proj = camera.projectionMatrix.elements[5];
      for (const e of this.emitters) e.material.uniforms.uScale.value = size.y * proj * 0.5;
      const camPos = camera.getWorldPosition(_v);
      for (const t of this.trails) t.cameraPos.copy(camPos);
      if (this.lastTick < 0) {
        this.lastTick = now;
        return;
      }
      const dt = now - this.lastTick;
      if (dt < 0.001) return; // several cameras / passes in one frame
      this.lastTick = now;
      this.update(dt);
    };
    this.add(carrier);
  }
}

/**
 * Builds a VFX recipe (from `forge.vfx`, an item's `vfx`, a blueprint's `vfx[]`, or hand-written).
 * Clamps the input first by default. When nothing renderable is left it returns an empty effect with
 * `finished = true` (so call sites never need a null check).
 *
 * ```ts
 * const fx = buildVfx(recipe);
 * if (fx) sword.attachment("tip")?.add(fx);
 * ```
 */
export function buildVfx(input: VfxRecipe | unknown, opts: BuildVfxOptions = {}): VfxObject {
  const recipe = opts.clamp === false ? (input as VfxRecipe) : clampVfx(input);
  if (!recipe) {
    // Nothing renderable: an empty, already-finished effect keeps call sites simple.
    const empty = new VfxObject({ v: 1, emitters: [] }, { ...opts, autoplay: false, autoUpdate: false });
    empty.finished = true;
    return empty;
  }
  return new VfxObject(recipe, opts);
}
