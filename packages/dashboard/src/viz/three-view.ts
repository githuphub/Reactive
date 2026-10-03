// Three.js Blueprint v1 + VFX v1 renderer for the gallery: builds primitives per the protocol conventions
// (metres, +Y up, size = full extents, Euler XYZ about the part centre, mirror x/z), animates parts, runs VFX
// recipes as GPU points with colour ramps and size curves, and renders cached thumbnails.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { partMaterial, type Blueprint, type BlueprintPart, type Emitter, type VfxRecipe } from "@liveforge/protocol";

// ------------------------------------------------------------------------------------------ geometry

const geoCache = new Map<string, THREE.BufferGeometry>();

function normalise(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const c = b.getCenter(new THREE.Vector3());
  const s = b.getSize(new THREE.Vector3());
  g.translate(-c.x, -c.y, -c.z);
  g.scale(1 / (s.x || 1), 1 / (s.y || 1), 1 / (s.z || 1));
  g.computeVertexNormals();
  return g;
}

function wedgeGeometry(): THREE.BufferGeometry {
  // blade outline in XY (tip +Y), diamond cross-section along Z
  const T = [0, 0.5, 0], sL = [-0.5, 0.25, 0], sR = [0.5, 0.25, 0], bL = [-0.5, -0.5, 0], bR = [0.5, -0.5, 0];
  const f1 = [0, 0.25, 0.5], f2 = [0, -0.5, 0.5], k1 = [0, 0.25, -0.5], k2 = [0, -0.5, -0.5];
  const tris = [
    [T, sL, f1], [T, f1, sR], [sL, bL, f2], [sL, f2, f1], [f1, f2, bR], [f1, bR, sR],
    [T, k1, sL], [T, sR, k1], [sL, k2, bL], [sL, k1, k2], [k1, bR, k2], [k1, sR, bR],
    [bL, f2, bR], [bL, bR, k2],
  ];
  const pos = new Float32Array(tris.flat(2));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return normalise(g);
}

function crescentGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.absarc(0, 0, 0.5, 0, Math.PI, false);
  s.absarc(0, -0.12, 0.36, Math.PI, 0, true);
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false, curveSegments: 18 });
  return normalise(g);
}

function unitGeometry(shape: BlueprintPart["shape"], detail: number): THREE.BufferGeometry {
  const key = `${shape}:${detail}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const seg = detail >= 2 ? 20 : detail === 1 ? 12 : 8;
  let g: THREE.BufferGeometry;
  switch (shape) {
    case "box": g = new THREE.BoxGeometry(1, 1, 1); break;
    case "sphere": g = new THREE.SphereGeometry(0.5, seg, Math.round(seg * 0.7)); break;
    case "cylinder": g = new THREE.CylinderGeometry(0.5, 0.5, 1, Math.max(10, seg)); break;
    case "cone": g = new THREE.ConeGeometry(0.5, 1, Math.max(10, seg)); break;
    case "octahedron": g = new THREE.OctahedronGeometry(0.5); break;
    case "icosahedron": g = new THREE.IcosahedronGeometry(0.5); break;
    case "prism": g = new THREE.CylinderGeometry(0.5, 0.5, 1, 3).rotateY(Math.PI / 2); break;
    case "wedge": g = wedgeGeometry(); break;
    case "crescent": g = crescentGeometry(); break;
    default: g = new THREE.BoxGeometry(1, 1, 1);
  }
  geoCache.set(key, g);
  return g;
}

/** Geometry sized to `size` (torus and capsule are built at real size, the rest are unit primitives scaled). */
function partGeometry(p: BlueprintPart, detail: number): { geo: THREE.BufferGeometry; scale: THREE.Vector3 } {
  const [x, y, z] = p.size;
  if (p.shape === "torus") {
    const tube = Math.max(0.004, Math.min(z, 0.45 * x) / 2);
    const R = Math.max(tube * 1.2, x / 2 - tube);
    return { geo: new THREE.TorusGeometry(R, tube, 8, detail >= 1 ? 28 : 18), scale: new THREE.Vector3(1, y / (x || 1), 1) };
  }
  if (p.shape === "capsule") {
    const r = Math.max(0.005, Math.min(x, z) / 2);
    return { geo: new THREE.CapsuleGeometry(r, Math.max(0, y - 2 * r), 6, detail >= 1 ? 14 : 10), scale: new THREE.Vector3(1, 1, 1) };
  }
  return { geo: unitGeometry(p.shape, detail), scale: new THREE.Vector3(x, y, z) };
}

// ------------------------------------------------------------------------------------------ blueprint

interface AnimatedPart {
  mesh: THREE.Mesh;
  part: BlueprintPart;
  base: { pos: THREE.Vector3; rot: THREE.Euler; scale: THREE.Vector3; emissive: number };
}

export interface BuiltModel {
  group: THREE.Group;
  update(t: number, dt: number): void;
  dispose(): void;
}

export function buildBlueprint(bp: Blueprint): BuiltModel {
  const group = new THREE.Group();
  group.name = bp.name ?? "blueprint";
  const detail = bp.lod?.detail === "high" ? 2 : bp.lod?.detail === "low" ? 0 : 1;
  const anims: AnimatedPart[] = [];
  const disposables: { dispose(): void }[] = [];
  const attach = new Map(bp.attachments.map((a) => [a.name, a]));
  for (const p of bp.parts) {
    const m = partMaterial(bp, p);
    const mat = new THREE.MeshStandardMaterial({
      color: m.color,
      metalness: m.metalness ?? 0.2,
      roughness: m.roughness ?? 0.6,
      emissive: m.emissive ?? "#000000",
      emissiveIntensity: m.emissive ? m.emissiveIntensity ?? 1 : 0,
      flatShading: m.flatShading ?? true,
      transparent: (m.opacity ?? 1) < 1,
      opacity: m.opacity ?? 1,
      side: p.shape === "wedge" || p.shape === "crescent" ? THREE.DoubleSide : THREE.FrontSide,
    });
    disposables.push(mat);
    const { geo, scale } = partGeometry(p, detail);
    if (p.shape === "torus" || p.shape === "capsule") disposables.push(geo);
    const parentOff = p.parent ? attach.get(p.parent)?.position ?? [0, 0, 0] : [0, 0, 0];
    const copies: [number[], number[]][] = [[[p.offset[0], p.offset[1], p.offset[2]], [...p.rotation]]];
    if (p.mirror === "x") copies.push([[-p.offset[0], p.offset[1], p.offset[2]], [p.rotation[0], -p.rotation[1], -p.rotation[2]]]);
    if (p.mirror === "z") copies.push([[p.offset[0], p.offset[1], -p.offset[2]], [-p.rotation[0], -p.rotation[1], p.rotation[2]]]);
    for (const [off, rot] of copies) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(off[0] + parentOff[0], off[1] + parentOff[1], off[2] + parentOff[2]);
      mesh.rotation.set(rot[0], rot[1], rot[2]);
      mesh.scale.copy(scale);
      group.add(mesh);
      if (p.anim) anims.push({ mesh, part: p, base: { pos: mesh.position.clone(), rot: mesh.rotation.clone(), scale: mesh.scale.clone(), emissive: mat.emissiveIntensity } });
    }
  }
  return {
    group,
    update(t) {
      for (const a of anims) {
        const an = a.part.anim!;
        const w = an.speed;
        const amt = an.amount;
        const mat = a.mesh.material as THREE.MeshStandardMaterial;
        switch (an.kind) {
          case "spin":
            a.mesh.rotation.y = a.base.rot.y + t * w;
            break;
          case "pulse": {
            const k = 1 + Math.sin(t * w * 2) * amt * 0.15;
            a.mesh.scale.copy(a.base.scale).multiplyScalar(k);
            mat.emissiveIntensity = a.base.emissive * (1 + Math.sin(t * w * 2) * amt);
            break;
          }
          case "float":
            a.mesh.position.y = a.base.pos.y + Math.sin(t * w) * amt * 0.08;
            break;
          case "orbit": {
            const r = Math.hypot(a.base.pos.x, a.base.pos.z) || 0.2;
            const ang = Math.atan2(a.base.pos.z, a.base.pos.x) + t * w;
            a.mesh.position.x = Math.cos(ang) * r;
            a.mesh.position.z = Math.sin(ang) * r;
            break;
          }
          case "flicker":
            mat.emissiveIntensity = a.base.emissive * (1 - amt * 0.5 + Math.random() * amt);
            break;
          case "wobble":
            a.mesh.rotation.z = a.base.rot.z + Math.sin(t * w) * amt * 0.35;
            break;
        }
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

// ------------------------------------------------------------------------------------------ VFX

const VERT = `
attribute float size;
attribute vec4 pcolor;
varying vec4 vColor;
uniform float scale;
void main() {
  vColor = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * scale / max(0.001, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}`;

const hexToRgb = (hex: string) => new THREE.Color(hex);

class EmitterSim {
  readonly points: THREE.Points;
  private n: number;
  private age: Float32Array;
  private life: Float32Array;
  private vel: Float32Array;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private carry = 0;
  private dir: THREE.Vector3;
  private ramp: { t: number; c: THREE.Color; a: number }[];
  private bursted = false;

  constructor(private e: Emitter, origin: THREE.Vector3) {
    this.n = Math.min(512, e.maxParticles);
    this.age = new Float32Array(this.n).fill(-1);
    this.life = new Float32Array(this.n);
    this.vel = new Float32Array(this.n * 3);
    this.pos = new Float32Array(this.n * 3);
    this.col = new Float32Array(this.n * 4);
    this.size = new Float32Array(this.n);
    this.dir = new THREE.Vector3(...e.velocity.dir);
    if (this.dir.lengthSq() < 1e-6) this.dir.set(0, 1, 0);
    this.dir.normalize();
    this.ramp = e.colorRamp.map((s) => ({ t: s.t, c: hexToRgb(s.color), a: s.alpha ?? 1 }));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("pcolor", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("size", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { scale: { value: 520 } },
      transparent: true,
      depthWrite: false,
      blending: e.blend === "alpha" ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.position.copy(origin);
    if (e.offset) this.points.position.add(new THREE.Vector3(...e.offset));
  }

  private spawn(i: number) {
    const e = this.e;
    let x = 0, y = 0, z = 0;
    const r = e.radius ?? 0.2;
    if (e.shape === "sphere") {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(r * Math.cbrt(Math.random()));
      x = v.x; y = v.y; z = v.z;
    } else if (e.shape === "box") {
      const ex = e.extents ?? [0.3, 0.3, 0.3];
      x = (Math.random() - 0.5) * ex[0]; y = (Math.random() - 0.5) * ex[1]; z = (Math.random() - 0.5) * ex[2];
    } else if (e.shape === "ring") {
      const a = Math.random() * Math.PI * 2;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    } else if (e.shape === "line") {
      x = (Math.random() - 0.5) * (e.extents?.[0] ?? 0.6);
    } else if (e.shape === "cone") {
      const a = Math.random() * Math.PI * 2;
      const rr = r * Math.sqrt(Math.random());
      x = Math.cos(a) * rr; z = Math.sin(a) * rr;
    }
    this.pos.set([x, y, z], i * 3);
    const d = this.dir.clone();
    const spread = e.shape === "cone" ? Math.min(1, (e.angle ?? 25) / 90) : e.velocity.spread;
    if (spread > 0) d.lerp(new THREE.Vector3().randomDirection(), spread).normalize();
    const sp = e.velocity.speed[0] + Math.random() * (e.velocity.speed[1] - e.velocity.speed[0]);
    this.vel.set([d.x * sp, d.y * sp, d.z * sp], i * 3);
    this.age[i] = 0;
    this.life[i] = e.lifetime[0] + Math.random() * Math.max(0, e.lifetime[1] - e.lifetime[0]);
  }

  private sampleRamp(t: number, out: THREE.Color): number {
    const r = this.ramp;
    if (t <= r[0].t) { out.copy(r[0].c); return r[0].a; }
    for (let i = 1; i < r.length; i++) {
      if (t <= r[i].t) {
        const k = (t - r[i - 1].t) / (r[i].t - r[i - 1].t || 1);
        out.copy(r[i - 1].c).lerp(r[i].c, k);
        return r[i - 1].a + (r[i].a - r[i - 1].a) * k;
      }
    }
    out.copy(r[r.length - 1].c);
    return r[r.length - 1].a;
  }

  private sampleSize(t: number): number {
    const s = this.e.sizeCurve;
    if (t <= s[0].t) return s[0].size;
    for (let i = 1; i < s.length; i++) if (t <= s[i].t) return s[i - 1].size + (s[i].size - s[i - 1].size) * ((t - s[i - 1].t) / (s[i].t - s[i - 1].t || 1));
    return s[s.length - 1].size;
  }

  update(dt: number) {
    const e = this.e;
    let toSpawn = 0;
    if (!this.bursted && e.burst) {
      toSpawn += e.burst;
      this.bursted = true;
    }
    this.carry += e.rate * dt;
    toSpawn += Math.floor(this.carry);
    this.carry -= Math.floor(this.carry);
    const c = new THREE.Color();
    const g = e.gravity ?? 0;
    const drag = 1 - (e.drag ?? 0) * dt;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] < 0) {
        if (toSpawn > 0) {
          this.spawn(i);
          toSpawn--;
        } else {
          this.col[i * 4 + 3] = 0;
          this.size[i] = 0;
          continue;
        }
      }
      this.age[i] += dt;
      const t = this.age[i] / (this.life[i] || 1);
      if (t >= 1) {
        this.age[i] = -1;
        this.col[i * 4 + 3] = 0;
        this.size[i] = 0;
        continue;
      }
      this.vel[i * 3 + 1] -= g * dt;
      for (let k = 0; k < 3; k++) {
        this.vel[i * 3 + k] *= drag;
        this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      }
      const a = this.sampleRamp(t, c);
      this.col.set([c.r, c.g, c.b, a], i * 4);
      this.size[i] = this.sampleSize(t);
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.pcolor.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
    if (e.spin) this.points.rotation.y += e.spin * dt;
  }

  dispose() {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

export interface BuiltVfx {
  group: THREE.Group;
  update(t: number, dt: number): void;
  dispose(): void;
}

export function buildVfx(recipe: VfxRecipe, origin = new THREE.Vector3()): BuiltVfx {
  const group = new THREE.Group();
  const emitters = recipe.emitters.map((e) => new EmitterSim(e, origin));
  for (const em of emitters) group.add(em.points);
  const auras: { mesh: THREE.Mesh; base: number; pulse?: { speed: number; amount: number } }[] = [];
  for (const a of recipe.auras ?? []) {
    let geo: THREE.BufferGeometry;
    if (a.shape === "ring") geo = new THREE.TorusGeometry(a.radius, 0.025, 8, 48).rotateX(Math.PI / 2);
    else if (a.shape === "column") geo = new THREE.CylinderGeometry(a.radius, a.radius, a.height ?? 1.5, 32, 1, true);
    else if (a.shape === "ground_decal") geo = new THREE.CircleGeometry(a.radius, 40).rotateX(-Math.PI / 2);
    else geo = new THREE.SphereGeometry(a.radius, 24, 16);
    const mat = new THREE.MeshBasicMaterial({ color: a.color, transparent: true, opacity: Math.min(1, a.intensity * 0.25), blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(origin);
    if (a.shape === "column") mesh.position.y += (a.height ?? 1.5) / 2;
    group.add(mesh);
    auras.push({ mesh, base: mat.opacity, pulse: a.pulse });
  }
  const lights: { light: THREE.PointLight; base: number; flicker: number }[] = [];
  for (const l of recipe.lights ?? []) {
    const light = new THREE.PointLight(l.color, l.intensity * 1.5, l.range, 1.5);
    light.position.copy(origin);
    if (l.offset) light.position.add(new THREE.Vector3(...l.offset));
    group.add(light);
    lights.push({ light, base: light.intensity, flicker: l.flicker ?? 0 });
  }
  return {
    group,
    update(t, dt) {
      for (const em of emitters) em.update(Math.min(dt, 0.05));
      for (const a of auras) {
        const m = a.mesh.material as THREE.MeshBasicMaterial;
        m.opacity = a.pulse ? a.base * (1 + Math.sin(t * a.pulse.speed * 2) * a.pulse.amount) : a.base;
      }
      for (const l of lights) l.light.intensity = l.base * (1 - l.flicker * 0.5 + Math.random() * l.flicker);
    },
    dispose() {
      for (const em of emitters) em.dispose();
      for (const a of auras) {
        a.mesh.geometry.dispose();
        (a.mesh.material as THREE.Material).dispose();
      }
    },
  };
}

// ------------------------------------------------------------------------------------------ viewer

function stageScene(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1208, 1.1));
  const key = new THREE.DirectionalLight(0xfff1dd, 2.2);
  key.position.set(2, 4, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6f8cff, 1.4);
  rim.position.set(-3, 2, -3);
  scene.add(rim);
}

/** Interactive orbit viewer for one blueprint (+ its VFX). */
export class BlueprintViewer {
  readonly el: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  private controls: OrbitControls;
  private model: BuiltModel | null = null;
  private fx: BuiltVfx[] = [];
  private clock = new THREE.Clock();
  private raf = 0;
  private ro: ResizeObserver;
  private floor: THREE.Mesh;

  constructor(el: HTMLElement) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(this.renderer.domElement);
    stageScene(this.scene);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x141824, roughness: 0.95, metalness: 0 });
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(2.2, 64).rotateX(-Math.PI / 2), floorMat);
    this.scene.add(this.floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.18, 2.2, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff7a2f, transparent: true, opacity: 0.35 }));
    ring.position.y = 0.002;
    this.scene.add(ring);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.6;
    this.camera.position.set(1.6, 1.2, 2.2);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    this.loop();
  }

  /** Show a blueprint with optional extra VFX recipes (the blueprint's own `vfx` are included automatically). */
  show(bp: Blueprint | null, extraVfx: VfxRecipe[] = []): void {
    this.clearModel();
    const recipes: VfxRecipe[] = [...(bp?.vfx ?? []), ...extraVfx];
    let bounds = new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 0.8, 0.3));
    if (bp) {
      this.model = buildBlueprint(bp);
      const b = new THREE.Box3().setFromObject(this.model.group);
      // sit on the floor
      this.model.group.position.y = -Math.min(0, b.min.y) + 0.02;
      this.scene.add(this.model.group);
      bounds = new THREE.Box3().setFromObject(this.model.group);
    }
    const attach = new Map((bp?.attachments ?? []).map((a) => [a.name, a.position]));
    const lift = this.model?.group.position.y ?? 0;
    for (const r of recipes.slice(0, 3)) {
      const p = (r.attach && attach.get(r.attach)) || (bp ? [0, bounds.max.y - lift - 0.05, 0] : [0, 0.5, 0]);
      const fx = buildVfx(r, new THREE.Vector3(p[0], p[1] + lift, p[2]));
      this.fx.push(fx);
      this.scene.add(fx.group);
    }
    this.frame(bounds);
  }

  private frame(b: THREE.Box3) {
    const size = b.getSize(new THREE.Vector3());
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(0.4, size.length() * 0.75);
    this.controls.target.copy(c);
    this.camera.position.set(c.x + r * 1.1, c.y + r * 0.55, c.z + r * 1.6);
    this.camera.near = r / 100;
    this.camera.far = r * 50;
    this.camera.updateProjectionMatrix();
  }

  setAutoRotate(on: boolean): void {
    this.controls.autoRotate = on;
  }

  private clearModel() {
    if (this.model) {
      this.scene.remove(this.model.group);
      this.model.dispose();
      this.model = null;
    }
    for (const f of this.fx) {
      this.scene.remove(f.group);
      f.dispose();
    }
    this.fx = [];
  }

  private resize() {
    const w = this.el.clientWidth || 400;
    const hgt = this.el.clientHeight || 400;
    this.renderer.setSize(w, hgt, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.clock.getDelta();
    const t = this.clock.elapsedTime;
    this.model?.update(t, dt);
    for (const f of this.fx) f.update(t, dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.clearModel();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

// ------------------------------------------------------------------------------------------ thumbnails

let thumbRenderer: THREE.WebGLRenderer | null = null;
const thumbCache = new Map<string, string>();

/** Render a blueprint to a PNG data URL (cached by key). Returns "" when WebGL is unavailable. */
export function thumbnail(key: string, bp: Blueprint, size = 160): string {
  const hit = thumbCache.get(key);
  if (hit) return hit;
  try {
    thumbRenderer ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
    thumbRenderer.setSize(size, size, false);
    thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
    thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    stageScene(scene);
    const m = buildBlueprint(bp);
    m.update(0.6, 0);
    scene.add(m.group);
    const b = new THREE.Box3().setFromObject(m.group);
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(0.3, b.getSize(new THREE.Vector3()).length() * 0.62);
    const cam = new THREE.PerspectiveCamera(36, 1, 0.01, 50);
    cam.position.set(c.x + r * 1.2, c.y + r * 0.5, c.z + r * 1.5);
    cam.lookAt(c);
    thumbRenderer.setClearColor(0x000000, 0);
    thumbRenderer.render(scene, cam);
    const url = thumbRenderer.domElement.toDataURL("image/png");
    m.dispose();
    thumbCache.set(key, url);
    return url;
  } catch {
    return "";
  }
}
