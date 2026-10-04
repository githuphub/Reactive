/**
 * Day/night clock. `time` runs 0..1 per day: 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight.
 * Default day length is 20 real minutes; `timeScale` speeds it up (V3 / demo panel).
 */
import * as THREE from 'three';
import type { DayPhase, EventBus, GameEvents } from './events';

export type NamedTime = 'dawn' | 'day' | 'noon' | 'dusk' | 'night' | 'midnight';

const NAMED: Record<NamedTime, number> = { dawn: 0.98, day: 0.08, noon: 0.25, dusk: 0.47, night: 0.6, midnight: 0.75 };

export class TimeOfDay {
  /** Real seconds per in-game day. */
  dayLength = 1200;
  /** Multiplier on the clock speed (0 freezes time). */
  timeScale = 1;
  /** 0..1 within the current day. */
  time = 0.04;
  /** Days elapsed. */
  day = 0;
  private emitTimer = 0;
  private lastPhase: DayPhase;

  constructor(private readonly events: EventBus<GameEvents>) {
    this.lastPhase = this.phase;
  }

  /** Jumps to a time (0..1) or a named moment. Fires timeChanged (and phaseChanged if needed). */
  setTime(t: number | NamedTime): void {
    this.time = typeof t === 'number' ? ((t % 1) + 1) % 1 : NAMED[t];
    this.emit();
  }

  /** Total elapsed days as a float (day + time). */
  get absolute(): number {
    return this.day + this.time;
  }

  /** Sun elevation -1..1 (sin of the sun angle). */
  get sunHeight(): number {
    return Math.sin(this.time * Math.PI * 2);
  }

  /** 0.15 (night) .. 1 (day) sky brightness. */
  get daylight(): number {
    const h = this.sunHeight;
    const t = Math.max(0, Math.min(1, (h + 0.12) / 0.4));
    return 0.15 + 0.85 * t * t * (3 - 2 * t);
  }

  get phase(): DayPhase {
    const t = this.time;
    if (t >= 0.96 || t < 0.04) return 'dawn';
    if (t < 0.46) return 'day';
    if (t < 0.54) return 'dusk';
    return 'night';
  }

  get isNight(): boolean {
    return this.phase === 'night';
  }

  /** In-game clock hours 0..24 (sunrise at 6:00). */
  get hours(): number {
    return (this.time * 24 + 6) % 24;
  }

  /** Unit vector towards the sun (rises in +X / east, sets in -X / west). */
  sunDirection(out = new THREE.Vector3()): THREE.Vector3 {
    const a = this.time * Math.PI * 2;
    return out.set(Math.cos(a), Math.sin(a), 0.25).normalize();
  }

  update(dt: number): void {
    this.time += (dt * this.timeScale) / this.dayLength;
    if (this.time >= 1) {
      this.time -= 1;
      this.day++;
    }
    this.emitTimer -= dt;
    if (this.emitTimer <= 0 || this.phase !== this.lastPhase) this.emit();
  }

  private emit(): void {
    this.emitTimer = 1;
    const phase = this.phase;
    if (phase !== this.lastPhase) {
      const prev = this.lastPhase;
      this.lastPhase = phase;
      this.events.emit('phaseChanged', { phase, prev, day: this.day });
    }
    this.events.emit('timeChanged', { time: this.time, day: this.day, phase, daylight: this.daylight });
  }
}
