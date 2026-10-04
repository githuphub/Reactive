/**
 * Villager makeovers (lane WB). When something happens to a villager (Bram builds for you, Mara's house is griefed,
 * Rowan stands guard, a festival, you help someone, a villager becomes your friend) they change their look:
 *
 * 1. **Instant rules:** the looks table below applies at once (Bram → hard hat + tool belt, Mara → red scarf, Rowan →
 *    plumed helmet, festive → flower crowns, helped / friend → a cape in your colours), built from local Blueprint
 *    accessories with `@liveforge/three`'s `buildBlueprint` and attached to the villager model.
 * 2. **AI upgrade:** `forge.npc_look {npc, prompt, asset}` → when the AI (or a cached AI) answer arrives, its
 *    recolours (primary → robe, secondary → trim) and accessory blueprints replace the rules look.
 *
 * Looks are saved per villager (slot `wb_looks`). Festive looks are dropped when the festival ends.
 */
import type { AskResult, Blueprint } from '@liveforge/sdk';
import { buildBlueprint, disposeObject } from '@liveforge/three';
import type * as THREE from 'three';
import type { Game } from '../../../game/game';
import { village, type Npc } from '../../../village';
import { getHub } from '../../hub';
import { lfNpcId } from '../../ids';
import type { LiveforgeService } from '../../service';
import { npcLabel } from '../stats';
import { ACCESSORIES, fitForServer, type AccessoryFit } from './accessories';
import '../events';

/** Why a villager changes their look. */
export type MakeoverReason = 'built_for_player' | 'griefed' | 'guarding' | 'festive' | 'helped' | 'friend';

/** A look as saved and applied. */
export interface Look {
  reason: MakeoverReason;
  /** Robe / trim colours (CSS hex). */
  recolor?: { robe?: string; trim?: string };
  parts: { fit: AccessoryFit; blueprint: Blueprint; label: string }[];
  source: 'rules' | 'ai' | 'cache';
  summary: string;
}

/** Instant-rules looks table: reason → (npc → accessory ids + recolour). `*` = anyone. */
const TABLE: Record<MakeoverReason, Record<string, { acc: string[]; recolor?: Look['recolor'] }>> = {
  built_for_player: { bram: { acc: ['hard_hat', 'tool_belt'] }, '*': { acc: ['tool_belt'] } },
  griefed: { mara: { acc: ['red_scarf'], recolor: { trim: '#8e2a22' } }, '*': { acc: ['red_scarf'] } },
  guarding: { captain_rowan: { acc: ['plumed_helmet'], recolor: { trim: '#b8352e' } }, '*': { acc: ['plumed_helmet'] } },
  festive: { '*': { acc: ['flower_crown'] } },
  helped: { '*': { acc: ['hero_cape'] }, bram: { acc: ['hard_hat', 'hero_cape'] } },
  friend: { '*': { acc: ['hero_cape'], recolor: { trim: '#2f8f86' } } },
};

/** What the AI is asked for, per reason. */
const PROMPTS: Record<MakeoverReason, string> = {
  built_for_player: 'proudly dressed after building a house for the player: a builder\'s hard hat and a tool belt',
  griefed: 'upset and defiant after the player broke their house: a red scarf, darker colours',
  guarding: 'standing guard against a night raid: a plumed helmet and a cape',
  festive: 'dressed up for the village festival: a flower crown and bright colours',
  helped: 'grateful after the player helped them: a cape in the player\'s teal colours',
  friend: 'now a close friend of the player: a teal cape and a friendship amulet',
};

const NAMED = ['bram', 'mara', 'hilde', 'pip', 'captain_rowan'];

export class Makeovers {
  private readonly looks = new Map<string, Look>();
  /** Look before the festival (restored after it). */
  private readonly beforeFestive = new Map<string, Look | null>();
  private readonly worn = new Map<string, { detach: (() => void)[]; objects: THREE.Object3D[]; hidden: string[]; recolored: boolean }>();
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly game: Game, private readonly lf: LiveforgeService) {
    game.save.register('wb_looks', () => Object.fromEntries([...this.looks.entries()].filter(([, l]) => l.reason !== 'festive')), (d: Record<string, Look>) => {
      void village.ready.then(() => {
        for (const [npc, look] of Object.entries(d ?? {})) if (look?.parts) this.apply(npc, look, true);
      });
    });

    game.events.on('villagerAction', (e) => {
      const id = lfNpcId(e.npc);
      if (e.ok && e.action === 'buildPlan') this.trigger(id, 'built_for_player');
      if (e.ok && e.action === 'guard' && id === 'captain_rowan' && (game.time.isNight || village.posture === 'hostile')) this.trigger(id, 'guarding');
    });
    game.events.on('villageDamaged', (e) => this.trigger(lfNpcId(e.owner), 'griefed'));
    game.events.on('villagePosture', (e) => {
      if (e.posture === 'festive') for (const n of NAMED) this.trigger(n, 'festive');
      else if (e.prev === 'festive') this.endFestival();
      if (e.posture === 'hostile') this.trigger('captain_rowan', 'guarding');
    });
  }

  /** The current look of a villager (journal). */
  lookOf(npc: string): Look | undefined {
    return this.looks.get(lfNpcId(npc));
  }

  /**
   * Gives a villager a makeover for `reason`: the rules look at once, then the `forge.npc_look` AI upgrade. Throttled
   * (same reason → no-op, 20 s per villager unless `force`).
   */
  trigger(npc: string, reason: MakeoverReason, force = false): void {
    const id = lfNpcId(npc);
    if (id === 'iron_golem' || !village.npc(id)) return;
    const cur = this.looks.get(id);
    if (!force && cur?.reason === reason) return;
    const now = Date.now();
    if (!force && reason !== 'festive' && now - (this.lastAt.get(id) ?? 0) < 20_000) return;
    this.lastAt.set(id, now);
    if (reason === 'festive' && !this.beforeFestive.has(id)) this.beforeFestive.set(id, cur ?? null);

    const rules = this.rulesLook(id, reason);
    this.apply(id, rules, false);
    this.announce(id, rules, 'rules', 0);
    this.game.events.emit('npcMakeover', { npc: id, reason, summary: rules.summary });

    const t0 = performance.now();
    try {
      const h = this.lf.ask('forge.npc_look', { npc: id, prompt: `${npcLabel(id)}, ${PROMPTS[reason]}`, asset: 'villager' });
      const take = (r: AskResult<'forge.npc_look'>, source: 'ai' | 'cache') => {
        if (this.looks.get(id)?.reason !== reason) return; // something newer happened
        const look = this.serverLook(id, reason, r, source);
        if (!look) return;
        this.apply(id, look, false);
        this.announce(id, look, source, performance.now() - t0);
      };
      void h.instant.then((r) => {
        if (r.source === 'cache') take(r.result, 'cache');
      }).catch(() => {});
      h.onUpgrade((u) => take(u.result, 'ai'));
    } catch {
      /* rules look stands */
    }
  }

  private endFestival(): void {
    for (const [id, prev] of this.beforeFestive) {
      if (this.looks.get(id)?.reason !== 'festive') continue;
      if (prev) this.apply(id, prev, true);
      else this.clear(id);
    }
    this.beforeFestive.clear();
  }

  private rulesLook(id: string, reason: MakeoverReason): Look {
    const row = TABLE[reason][id] ?? TABLE[reason]['*'];
    const parts = row.acc.map((a) => ACCESSORIES[a]).filter(Boolean).map((a) => ({ fit: a.fit, blueprint: a.blueprint, label: a.label }));
    return {
      reason, parts, source: 'rules', ...(row.recolor ? { recolor: row.recolor } : {}),
      summary: `${npcLabel(id)} → ${parts.map((p) => p.label).join(' + ') || 'new colours'}`,
    };
  }

  private serverLook(id: string, reason: MakeoverReason, r: AskResult<'forge.npc_look'>, source: 'ai' | 'cache'): Look | null {
    const recolor: Look['recolor'] = {};
    for (const rc of r.variant?.recolour ?? []) {
      if (rc.from === 'primary') recolor.robe = rc.to;
      else if (rc.from === 'secondary' || rc.from === 'trim') recolor.trim = recolor.trim ?? rc.to;
    }
    const swap = r.variant?.materialSwaps?.find((m) => m.slot === '*' || /robe|body|cloth|primary/i.test(m.slot));
    if (swap && !recolor.robe) recolor.robe = swap.material.color;
    const parts = (r.accessories ?? []).slice(0, 3).map((b) => ({ fit: fitForServer(b), blueprint: b, label: (b.name ?? b.tags?.[0] ?? 'an accessory').toLowerCase() }));
    if (!parts.length && !recolor.robe && !recolor.trim) return null;
    return {
      reason, parts, source, ...(recolor.robe || recolor.trim ? { recolor } : {}),
      summary: `${npcLabel(id)} → ${parts.map((p) => p.label).join(' + ') || 'new colours'}${recolor.robe ? ` (robe ${recolor.robe})` : ''}`,
    };
  }

  /** Puts a look on the villager model (replacing the previous one). */
  private apply(id: string, look: Look, restoring: boolean): void {
    const npc = village.npc(id);
    if (!npc || npc.isGolem) return;
    this.strip(id, npc);
    const w = { detach: [] as (() => void)[], objects: [] as THREE.Object3D[], hidden: [] as string[], recolored: false };
    for (const p of look.parts) {
      try {
        const obj = buildBlueprint(p.blueprint, { clamp: look.source !== 'rules', castShadow: false, autoAnimate: true, ...(p.fit.length ? { length: p.fit.length } : {}) });
        obj.position.set(...p.fit.at);
        w.detach.push(npc.look.attach(p.fit.part, obj));
        w.objects.push(obj);
        for (const h of p.fit.hide ?? []) {
          npc.look.setPartVisible(h, false);
          w.hidden.push(h);
        }
      } catch (err) {
        console.warn('[makeovers] accessory failed', p.label, err);
      }
    }
    if (look.recolor) {
      npc.look.recolor(look.recolor);
      w.recolored = true;
    }
    this.worn.set(id, w);
    this.looks.set(id, look);
    if (!restoring) this.game.save.markDirty('wb_looks');
  }

  private clear(id: string): void {
    const npc = village.npc(id);
    if (npc) this.strip(id, npc);
    this.looks.delete(id);
    this.game.save.markDirty('wb_looks');
  }

  private strip(id: string, npc: Npc): void {
    const w = this.worn.get(id);
    if (!w) return;
    for (const d of w.detach) d();
    for (const o of w.objects) disposeObject(o);
    for (const h of w.hidden) npc.look.setPartVisible(h, true);
    if (w.recolored) npc.look.recolor({ robe: npc.def.look.robe, trim: npc.def.look.trim });
    this.worn.delete(id);
  }

  private announce(id: string, look: Look, source: 'rules' | 'ai' | 'cache', ms: number): void {
    const model = source === 'rules' ? 'rules' : source === 'cache' ? 'cache' : this.lf.cassette === 'REPLAY' ? 'replay' : 'sonnet';
    this.lf.think({ source: 'forge', actor: id, kind: 'plan', model, ms: Math.round(ms), text: `makeover (${look.reason.replace(/_/g, ' ')}): ${look.summary}`, data: { look } });
    const npc = village.npc(id);
    if (npc && npc.position.distanceTo(this.game.player.position) < 40) {
      getHub().caption(`✨ ${look.summary}${source === 'rules' ? '' : ' · AI restyle'}`, 5);
      if (source === 'rules') void npc.controller.emote(look.reason === 'griefed' ? 'glare' : 'cheer', { priority: 'schedule' });
    }
  }
}
