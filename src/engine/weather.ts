/**
 * Weather: rain streaks / snow flakes around the camera, sky darkening and storm lightning.
 * Drive it with `game.weather.set('rain' | 'storm' | 'snow' | 'clear')`.
 */
import * as THREE from 'three';
import type { EventBus, GameEvents, Weather } from '../game/events';
import type { WorldStore } from './world-store';
import { isSnowy } from '../world/biomes';

const RAIN_COUNT = 1600;
const SNOW_COUNT = 1400;
const RADIUS = 22;
const HEIGHT = 26;

export class WeatherSystem {
  readonly group = new THREE.Group();
  private kind: Weather = 'clear';
  /** 0..1 smoothed precipitation intensity. */
  intensity = 0;
  /** 0..1 lightning flash brightness. */
  flash = 0;
  private lightningTimer = 8;
  private readonly rain: THREE.LineSegments;
  private readonly rainPos: Float32Array;
  private readonly rainDrop: Float32Array; // x, y, z, floor per drop
  private readonly snow: THREE.Points;
  private readonly snowPos: Float32Array;
  private readonly snowDrop: Float32Array;

  constructor(private readonly events: EventBus<GameEvents>) {
    this.group.name = 'weather';
    this.rainPos = new Float32Array(RAIN_COUNT * 6);
    this.rainDrop = new Float32Array(RAIN_COUNT * 4);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xa8bcdc, transparent: true, opacity: 0.55, fog: false, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.snowPos = new Float32Array(SNOW_COUNT * 3);
    this.snowDrop = new Float32Array(SNOW_COUNT * 4);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.snowPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.snow = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.13, transparent: true, opacity: 0.9, fog: false, depthWrite: false }));
    this.snow.frustumCulled = false;
    this.group.add(this.rain, this.snow);
    this.rain.visible = this.snow.visible = false;
    for (let i = 0; i < RAIN_COUNT; i++) this.rainDrop[i * 4 + 1] = Number.NaN;
    for (let i = 0; i < SNOW_COUNT; i++) this.snowDrop[i * 4 + 1] = Number.NaN;
  }

  get current(): Weather {
    return this.kind;
  }

  /** Changes the weather; visuals fade over a few seconds. */
  set(kind: Weather): void {
    if (kind === this.kind) return;
    const prev = this.kind;
    this.kind = kind;
    if (kind === 'storm') this.lightningTimer = 2 + Math.random() * 4;
    this.events.emit('weatherChanged', { weather: kind, prev });
  }

  /** How much the sky darkens (0 none .. ~0.55 storm). */
  get darkening(): number {
    const target = this.kind === 'storm' ? 0.55 : this.kind === 'rain' ? 0.35 : this.kind === 'snow' ? 0.25 : 0;
    return target * this.intensity;
  }

  update(dt: number, camera: THREE.Camera, world: WorldStore): void {
    const target = this.kind === 'clear' ? 0 : 1;
    this.intensity += (target - this.intensity) * Math.min(1, dt * 0.5);
    if (this.kind === 'storm') {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.flash = 1;
        this.lightningTimer = 5 + Math.random() * 12;
      }
    }
    this.flash = Math.max(0, this.flash - dt * 2.5);

    const cam = camera.position;
    const biomeSnowy = isSnowy(biomeIdAt(world, cam.x, cam.z));
    const precip = this.kind !== 'clear' && this.intensity > 0.02;
    const snowing = precip && (this.kind === 'snow' || biomeSnowy);
    const raining = precip && !snowing && world.biomeAt(cam.x, cam.z) !== 'desert';
    this.rain.visible = raining;
    this.snow.visible = snowing;
    if (raining) this.updateRain(dt, cam, world);
    if (snowing) this.updateSnow(dt, cam, world);
  }

  private updateRain(dt: number, cam: THREE.Vector3, world: WorldStore): void {
    const heavy = this.kind === 'storm' ? 1 : 0.65;
    const active = Math.floor(RAIN_COUNT * heavy * this.intensity);
    const d = this.rainDrop;
    const p = this.rainPos;
    for (let i = 0; i < RAIN_COUNT; i++) {
      const o = i * 4;
      if (i >= active) {
        p.fill(0, i * 6, i * 6 + 6);
        d[o + 1] = Number.NaN;
        continue;
      }
      let y = d[o + 1];
      if (Number.isNaN(y) || y < d[o + 3] || Math.abs(d[o] - cam.x) > RADIUS || Math.abs(d[o + 2] - cam.z) > RADIUS) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * RADIUS;
        d[o] = cam.x + Math.cos(a) * r;
        d[o + 2] = cam.z + Math.sin(a) * r;
        d[o + 3] = world.heightAt(d[o], d[o + 2]) + 1;
        y = Number.isNaN(y) ? cam.y + (Math.random() - 0.3) * HEIGHT : cam.y + HEIGHT * 0.6 + Math.random() * 4;
      }
      y -= dt * 22;
      d[o + 1] = y;
      const k = i * 6;
      p[k] = d[o]; p[k + 1] = y; p[k + 2] = d[o + 2];
      p[k + 3] = d[o] + 0.05; p[k + 4] = y + 0.7; p[k + 5] = d[o + 2];
    }
    (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateSnow(dt: number, cam: THREE.Vector3, world: WorldStore): void {
    const active = Math.floor(SNOW_COUNT * this.intensity);
    const d = this.snowDrop;
    const p = this.snowPos;
    const t = performance.now() / 1000;
    for (let i = 0; i < SNOW_COUNT; i++) {
      const o = i * 4;
      if (i >= active) {
        p[i * 3 + 1] = -1000;
        d[o + 1] = Number.NaN;
        continue;
      }
      let y = d[o + 1];
      if (Number.isNaN(y) || y < d[o + 3] || Math.abs(d[o] - cam.x) > RADIUS || Math.abs(d[o + 2] - cam.z) > RADIUS) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * RADIUS;
        d[o] = cam.x + Math.cos(a) * r;
        d[o + 2] = cam.z + Math.sin(a) * r;
        d[o + 3] = world.heightAt(d[o], d[o + 2]) + 1;
        y = Number.isNaN(y) ? cam.y + (Math.random() - 0.3) * HEIGHT : cam.y + HEIGHT * 0.6 + Math.random() * 4;
      }
      y -= dt * 2.2;
      d[o + 1] = y;
      p[i * 3] = d[o] + Math.sin(t * 1.3 + i) * 0.3;
      p[i * 3 + 1] = y;
      p[i * 3 + 2] = d[o + 2] + Math.cos(t * 1.1 + i * 0.7) * 0.3;
    }
    (this.snow.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}

function biomeIdAt(world: WorldStore, x: number, z: number): number {
  const c = world.chunkAt(Math.floor(x), Math.floor(z));
  return c ? c.biomes[(Math.floor(x) & 15) | ((Math.floor(z) & 15) << 4)] : 0;
}
