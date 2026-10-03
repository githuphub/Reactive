/**
 * Sky: gradient dome with sunset glow, blocky sun and moon, stars, and a slowly drifting
 * flat cloud layer. Computes the fog colour and terrain sky tint each frame.
 */
import * as THREE from 'three';
import { mulberry32 } from './random';
import type { TimeOfDay } from '../game/time';
import type { WeatherSystem } from './weather';

const DAY_TOP = new THREE.Color('#5d93f2');
const DAY_HORIZON = new THREE.Color('#b9d5fb');
const SUNSET_TOP = new THREE.Color('#3f5a9e');
const SUNSET_HORIZON = new THREE.Color('#f39a62');
const NIGHT_TOP = new THREE.Color('#03050c');
const NIGHT_HORIZON = new THREE.Color('#0c1424');
const STORM = new THREE.Color('#6c737e');
const CLOUD_HEIGHT = 116;
const CLOUD_TEXEL = 12;

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

export class Sky {
  readonly group = new THREE.Group();
  /** Fog colour for terrain (horizon colour). */
  readonly fogColor = new THREE.Color();
  /** Tint applied to sky light on terrain. */
  readonly skyTint = new THREE.Color(1, 1, 1);
  private readonly dome: THREE.Mesh;
  private readonly domeUniforms: Record<string, THREE.IUniform>;
  private readonly sun: THREE.Mesh;
  private readonly moon: THREE.Mesh;
  private readonly stars: THREE.Points;
  private readonly clouds: THREE.Mesh;
  private readonly cloudUniforms: Record<string, THREE.IUniform>;
  private readonly sunDir = new THREE.Vector3();
  private wind = 0;

  constructor() {
    this.group.name = 'sky';
    this.domeUniforms = {
      uTop: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uGlow: { value: new THREE.Color('#ff8a4a') },
      uGlowStrength: { value: 0 },
    };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(450, 24, 16),
      new THREE.ShaderMaterial({
        uniforms: this.domeUniforms,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uGlow; uniform float uGlowStrength;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float h = d.y;
            vec3 c = mix(uHorizon, uTop, pow(smoothstep(-0.02, 0.65, h), 0.8));
            c = mix(c, uHorizon * 0.55, smoothstep(0.0, -0.35, h));
            float g = pow(max(dot(d, uSunDir), 0.0), 5.0) * uGlowStrength * (1.0 - smoothstep(0.0, 0.5, abs(h)));
            c += uGlow * g;
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;

    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(56, 56), spriteMaterial(paintSun(), true));
    this.moon = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), spriteMaterial(paintMoon(), false));
    this.sun.renderOrder = this.moon.renderOrder = -9;
    this.sun.frustumCulled = this.moon.frustumCulled = false;

    const rng = mulberry32(1234);
    const starPos = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const u = rng() * 2 - 1;
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      starPos[i * 3] = Math.cos(a) * r * 400;
      starPos[i * 3 + 1] = u * 400;
      starPos[i * 3 + 2] = Math.sin(a) * r * 400;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(
      sg,
      new THREE.PointsMaterial({ color: 0xffffff, size: 1.7, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }),
    );
    this.stars.renderOrder = -9;
    this.stars.frustumCulled = false;

    this.cloudUniforms = {
      map: { value: paintClouds() },
      uOffset: { value: new THREE.Vector2() },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uOpacity: { value: 0.85 },
    };
    const cloudGeo = new THREE.PlaneGeometry(900, 900);
    cloudGeo.rotateX(-Math.PI / 2);
    this.clouds = new THREE.Mesh(
      cloudGeo,
      new THREE.ShaderMaterial({
        uniforms: this.cloudUniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
          uniform vec2 uOffset;
          varying vec2 vUv;
          varying float vDist;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vUv = (wp.xz + uOffset) / ${(64 * CLOUD_TEXEL).toFixed(1)};
            vec4 mv = viewMatrix * wp;
            vDist = length(mv.xz);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D map; uniform vec3 uColor; uniform float uOpacity;
          varying vec2 vUv; varying float vDist;
          void main() {
            float a = texture2D(map, vUv).a;
            if (a < 0.5) discard;
            float fade = 1.0 - smoothstep(220.0, 430.0, vDist);
            gl_FragColor = vec4(uColor, uOpacity * fade);
          }`,
      }),
    );
    this.clouds.renderOrder = 5;
    this.clouds.frustumCulled = false;

    this.group.add(this.dome, this.stars, this.sun, this.moon, this.clouds);
  }

  /** Updates colours and follows the camera. */
  update(dt: number, camera: THREE.Camera, time: TimeOfDay, weather: WeatherSystem): void {
    const cam = camera.position;
    time.sunDirection(this.sunDir);
    const h = this.sunDir.y;
    const day = smooth(-0.12, 0.3, h);
    const sunset = Math.max(0, 1 - Math.abs(h) / 0.3) * (1 - 0.6 * weather.intensity);
    const dark = weather.darkening;

    // Dome colours.
    tmpA.copy(NIGHT_TOP).lerp(DAY_TOP, day).lerp(SUNSET_TOP, sunset * 0.5);
    tmpB.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, day).lerp(SUNSET_HORIZON, sunset * 0.65);
    const stormCol = tmpStorm.copy(STORM).multiplyScalar(0.25 + 0.75 * day);
    tmpA.lerp(stormCol, dark * 1.4);
    tmpB.lerp(stormCol, dark * 1.4);
    if (weather.flash > 0) {
      tmpA.lerp(WHITE, weather.flash * 0.6);
      tmpB.lerp(WHITE, weather.flash * 0.6);
    }
    (this.domeUniforms.uTop.value as THREE.Color).copy(tmpA);
    (this.domeUniforms.uHorizon.value as THREE.Color).copy(tmpB);
    (this.domeUniforms.uSunDir.value as THREE.Vector3).copy(this.sunDir);
    this.domeUniforms.uGlowStrength.value = sunset * 0.9;
    this.fogColor.copy(tmpB);

    // Terrain tint: neutral by day, warm at sunset, cool moonlight at night.
    this.skyTint.setRGB(1, 1, 1).lerp(SUNSET_TINT, sunset * 0.5).lerp(NIGHT_TINT, 1 - day);
    this.skyTint.multiplyScalar(1 - dark * 0.5 + weather.flash * 0.8);

    this.dome.position.copy(cam);
    this.stars.position.copy(cam);
    this.stars.rotation.z = time.time * Math.PI * 2;
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - day * 1.6) * (1 - weather.intensity * 0.8);

    this.sun.position.copy(cam).addScaledVector(this.sunDir, 380);
    this.sun.lookAt(cam);
    this.moon.position.copy(cam).addScaledVector(this.sunDir, -380);
    this.moon.lookAt(cam);
    (this.sun.material as THREE.MeshBasicMaterial).opacity = 1 - weather.intensity * 0.85;
    (this.moon.material as THREE.MeshBasicMaterial).opacity = 1 - weather.intensity * 0.85;

    this.wind += dt * 1.6;
    const snap = CLOUD_TEXEL;
    this.clouds.position.set(Math.floor(cam.x / snap) * snap, CLOUD_HEIGHT, Math.floor(cam.z / snap) * snap);
    (this.cloudUniforms.uOffset.value as THREE.Vector2).set(this.wind, 0);
    (this.cloudUniforms.uColor.value as THREE.Color).setRGB(1, 1, 1).lerp(STORM, dark * 1.2).lerp(SUNSET_HORIZON, sunset * 0.25).multiplyScalar(0.2 + 0.8 * day);
    this.cloudUniforms.uOpacity.value = 0.8 + weather.intensity * 0.15;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}

const tmpStorm = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);
const SUNSET_TINT = new THREE.Color(1, 0.82, 0.66);
const NIGHT_TINT = new THREE.Color(0.62, 0.7, 1.0);

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function spriteMaterial(canvas: HTMLCanvasElement, additive: boolean): THREE.MeshBasicMaterial {
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

function paintSun(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(255,200,90,0.25)';
  ctx.fillRect(1, 1, 14, 14);
  ctx.fillStyle = 'rgba(255,210,110,0.55)';
  ctx.fillRect(3, 3, 10, 10);
  ctx.fillStyle = '#ffe9a0';
  ctx.fillRect(4, 4, 8, 8);
  ctx.fillStyle = '#fff8dc';
  ctx.fillRect(5, 5, 6, 6);
  return c;
}

function paintMoon(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#d8dde8';
  ctx.fillRect(4, 4, 8, 8);
  ctx.fillStyle = '#b9c0cf';
  for (const [x, y, w] of [[5, 5, 2], [9, 7, 2], [6, 9, 1], [10, 10, 1]]) ctx.fillRect(x, y, w, w);
  ctx.fillStyle = '#eef1f7';
  ctx.fillRect(4, 4, 8, 1);
  return c;
}

function paintClouds(): THREE.Texture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const rng = mulberry32(777);
  // Tileable value noise, two octaves.
  const grid = (cells: number) => {
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = rng();
    return (x: number, y: number) => {
      const fx = (x / size) * cells, fy = (y / size) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const s = (t: number) => t * t * (3 - 2 * t);
      const at = (i: number, j: number) => g[((j % cells) + cells) % cells * cells + (((i % cells) + cells) % cells)];
      const a = at(x0, y0), b = at(x0 + 1, y0), cc = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      return a + (b - a) * s(tx) + (cc - a) * s(ty) + (a - b - cc + d) * s(tx) * s(ty);
    };
  };
  const n1 = grid(8), n2 = grid(16);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const v = n1(x, y) * 0.7 + n2(x, y) * 0.3;
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = v > 0.58 ? 255 : 0;
    }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
