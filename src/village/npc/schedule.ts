/**
 * Daily schedule brain. Runs routines through the villager's controller at 'schedule' priority,
 * so any agent action (V3) takes over at once and the schedule resumes after a grace period.
 *
 * - Day: work (farmer harvests and replants, smith hammers at the anvil and furnace, librarian
 *   reads at the shelves, builder sorts the yard piles, guard patrols, others potter about).
 * - Evening: gather around the well and chat.
 * - Night: go home, shut the door, sleep. Guards keep the night watch; the golem patrols.
 * - Hostiles near, injured, or a hostile village posture: non-guards go indoors.
 * - Festive posture: everyone gathers at the plaza.
 */
import type { Vec3Like } from '../nav';
import type { Village } from '../village';
import type { Npc } from './npc';

export type Activity = 'work' | 'gather' | 'home' | 'flee' | 'watch' | 'patrol' | 'party';

const S = { priority: 'schedule' as const };

export class ScheduleBrain {
  activity: Activity | null = null;
  private gen = 0;
  private decide = Math.random();
  private lastChat = 0;

  constructor(private readonly npc: Npc, private readonly v: Village) {}

  /** What this villager should be doing now. */
  desired(): Activity {
    const npc = this.npc;
    const t = this.v.game.time.time;
    const night = t >= 0.565 && t < 0.97;
    const evening = t >= 0.455 && t < 0.565;
    if (npc.isGolem) return 'patrol';
    if (npc.def.guard) return night || evening || this.v.posture === 'hostile' ? 'watch' : 'work';
    if (this.v.nearestHostile(npc.position, 18) || npc.injured || this.v.posture === 'hostile') return 'flee';
    if (night) return 'home';
    if (this.v.posture === 'festive') return 'party';
    if (evening) return 'gather';
    return 'work';
  }

  update(dt: number): void {
    this.decide -= dt;
    if (this.decide > 0) return;
    this.decide = 0.8 + Math.random() * 0.6;
    const npc = this.npc;
    if (!this.v.schedulesEnabled || npc.removed) return;
    const c = npc.controller;
    if (c.agentControlled || c.currentMode) {
      this.activity = null;
      return;
    }
    const want = this.desired();
    if (want === this.activity) return;
    this.activity = want;
    const gen = ++this.gen;
    if (npc.sleeping && want !== 'home') npc.wake();
    void this.routine(want, gen).catch((err) => console.error('[village] schedule', npc.def.id, err));
  }

  /** Re-evaluates now (e.g. after a posture change). */
  poke(): void {
    this.activity = null;
    this.decide = 0;
  }

  private alive(gen: number): boolean {
    return gen === this.gen && !this.npc.removed && !this.npc.controller.agentControlled;
  }

  private async routine(a: Activity, gen: number): Promise<void> {
    switch (a) {
      case 'work': return this.work(gen);
      case 'gather': return this.gather(gen, false);
      case 'party': return this.gather(gen, true);
      case 'home':
      case 'flee': return this.goHome(gen, a === 'flee');
      case 'watch': return this.watch(gen);
      case 'patrol': return this.patrol(gen);
    }
  }

  private async pause(gen: number, seconds: number): Promise<boolean> {
    if (!this.alive(gen)) return false;
    await this.npc.controller.wait(seconds, S);
    return this.alive(gen);
  }

  private async goHome(gen: number, flee: boolean): Promise<void> {
    const npc = this.npc;
    const c = npc.controller;
    const home = this.v.homeOf(npc);
    if (!home) return;
    const r = await c.walkTo(home.entrance, { ...S, run: flee, reach: 1 });
    if (!this.alive(gen) || !r.ok) return;
    const bed = home.bed;
    if (bed) {
      await c.walkTo(bed.stand, { ...S, reach: 0.9 });
      if (!this.alive(gen)) return;
      this.v.closeDoorsOf(home.id);
      if (!flee) npc.lieDown(bed.foot, bed.head);
    } else {
      this.v.closeDoorsOf(home.id);
    }
  }

  private async work(gen: number): Promise<void> {
    const npc = this.npc;
    const c = npc.controller;
    switch (npc.def.work) {
      case 'farm': {
        while (this.alive(gen)) {
          const r = await c.gather('wheat', 1 + Math.floor(Math.random() * 3), S);
          if (!this.alive(gen)) return;
          if (!r.ok) {
            const spot = this.v.farmSpot();
            if (spot) await c.walkTo(spot, { ...S, reach: 1 });
            if (Math.random() < 0.3) await c.emote('think', S);
          }
          if (!(await this.pause(gen, 1.5 + Math.random() * 3))) return;
          this.maybeChat();
        }
        return;
      }
      case 'smithy':
      case 'library':
      case 'yard': {
        const spots = this.v.workSpots(npc.def.work);
        let i = Math.floor(Math.random() * Math.max(1, spots.length));
        while (this.alive(gen) && spots.length) {
          const s = spots[i % spots.length];
          i += 1 + Math.floor(Math.random() * 2);
          const r = await c.walkTo(s.at, { ...S, reach: 0.8 });
          if (!this.alive(gen)) return;
          if (r.ok) {
            npc.face(s.look.x + 0.5, s.look.z + 0.5);
            npc.lookAtTarget({ x: s.look.x + 0.5, y: s.look.y + 0.5, z: s.look.z + 0.5 }, 8);
          }
          const kind = npc.def.work === 'library' ? (Math.random() < 0.6 ? 'think' : 'nod') : 'hammer';
          for (let k = 0; k < 3 && this.alive(gen); k++) {
            await c.emote(kind, { ...S, seconds: 2 + Math.random() * 1.5 });
            if (npc.def.work === 'smithy' && this.alive(gen)) this.v.sparks(s.look);
            if (!(await this.pause(gen, 0.8 + Math.random() * 1.5))) return;
          }
          this.maybeChat();
        }
        return;
      }
      default: {
        // Potter around the plaza, the green and the well.
        while (this.alive(gen)) {
          const p = this.v.wanderSpot('plaza');
          await c.walkTo(p, { ...S, reach: 1.2 });
          if (!(await this.pause(gen, 3 + Math.random() * 6))) return;
          this.maybeChat();
        }
      }
    }
  }

  private async gather(gen: number, party: boolean): Promise<void> {
    const npc = this.npc;
    const c = npc.controller;
    const spot = this.v.gatherSpot(npc, party);
    await c.walkTo(spot.at, { ...S, reach: 1 });
    if (!this.alive(gen)) return;
    npc.face(spot.look.x, spot.look.z);
    while (this.alive(gen)) {
      npc.lookAtTarget(this.v.nearestNpc(npc, 6) ?? spot.look, 4);
      if (party && Math.random() < 0.35) await c.emote(Math.random() < 0.5 ? 'cheer' : 'laugh', S);
      this.maybeChat(party ? 0.5 : 0.25);
      if (!(await this.pause(gen, 3 + Math.random() * 4))) return;
    }
  }

  private async watch(gen: number): Promise<void> {
    const npc = this.npc;
    npc.swordDrawn = true;
    const posts = ['gate', 'tower_base', 'well', 'gate'];
    let i = 0;
    while (this.alive(gen)) {
      const p = this.v.post(posts[i++ % posts.length]);
      if (p) await npc.controller.walkTo(p, { ...S, reach: 1.2 });
      if (!(await this.pause(gen, 8 + Math.random() * 8))) return;
    }
  }

  private async patrol(gen: number): Promise<void> {
    const npc = this.npc;
    const route = npc.isGolem ? ['plaza', 'mara_house', 'farm', 'bram_plot', 'well', 'gate', 'tower_base'] : ['gate', 'well', 'plaza', 'bram_plot', 'tower_base'];
    let i = Math.floor(Math.random() * route.length);
    while (this.alive(gen)) {
      const p = this.v.post(route[i++ % route.length]);
      if (p) await npc.controller.walkTo(jitter(p, 2), { ...S, reach: 1.5 });
      if (!this.alive(gen)) return;
      if (npc.isGolem && Math.random() < 0.25) await npc.controller.emote(Math.random() < 0.5 ? 'creak' : 'stare', S);
      if (!(await this.pause(gen, 4 + Math.random() * 6))) return;
    }
  }

  /** Now and then, say a bark to a villager nearby. */
  private maybeChat(chance = 0.12): void {
    const npc = this.npc;
    const now = this.v.clock;
    if (now - this.lastChat < 25 || Math.random() > chance || npc.isGolem) return;
    const other = this.v.nearestNpc(npc, 5);
    const nearPlayer = npc.position.distanceTo(this.v.game.player.position) < 10;
    if (!other && !nearPlayer) return;
    this.lastChat = now;
    if (other) npc.lookAtTarget(other, 4);
    void npc.controller.say(this.v.barkFor(npc), S);
  }
}

function jitter(p: Vec3Like, r: number): Vec3Like {
  return { x: p.x + (Math.random() - 0.5) * r * 2, y: p.y, z: p.z + (Math.random() - 0.5) * r * 2 };
}
