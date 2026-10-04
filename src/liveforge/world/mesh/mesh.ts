/**
 * Hyper3D meshes (lane WB). When the server finishes a mesh job (`job` WS message, or a `forge.ready` directive with
 * a GLB url) the GLB is loaded with three's GLTFLoader, normalised to ~1.4 blocks, and placed as a slowly turning
 * decoration in front of the player, with a "🧊 3D model ready" toast and a Brain entry.
 *
 * Without a mesh provider nothing happens. The Demo button "🧊 Upgrade to 3D" re-forges the last forged thing with
 * `forge.item {prompt, mesh: true}` (the SDK has no "mesh for an existing item" call: kit gap) and reports when the
 * server starts no job (no HYPER3D key, or manifest `clamps.forge.meshJobs` off).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BrainEntry, Directive } from '@liveforge/sdk';
import type { Game } from '../../../game/game';
import { getHub } from '../../hub';
import type { LiveforgeService } from '../../service';

interface Deco {
  root: THREE.Object3D;
  spin: number;
}

export class MeshJobs {
  private readonly loader = new GLTFLoader();
  private readonly done = new Set<string>();
  private readonly pending = new Map<string, string>();
  private readonly decos: Deco[] = [];
  /** Last forged thing (from the forge's Brain entries). */
  private lastForged: { name: string; prompt: string } | null = null;

  constructor(private readonly game: Game, private readonly lf: LiveforgeService) {
    lf.client.onJob((j) => {
      if (j.state === 'done' && j.url) void this.load(j.id, j.url, this.pending.get(j.id));
      else if (j.state === 'failed') this.lf.think({ source: 'forge', actor: 'forge', kind: 'tool_result', model: 'rules', text: `3D mesh job ${j.id} failed`, data: { ok: false } });
    });
    lf.client.on('forge.ready', (d: Directive) => {
      const a = d.args as { jobId?: string; url?: string; state?: string; item?: { name?: string } };
      if (a.state === 'done' && a.url && a.jobId) void this.load(a.jobId, a.url, a.item?.name);
    });
    lf.client.brain.subscribe((e: BrainEntry) => {
      const spec = (e.data as { spec?: { name?: string; prompt?: string } } | undefined)?.spec;
      if (spec?.name) this.lastForged = { name: spec.name, prompt: spec.prompt ?? spec.name };
    }, { source: 'forge' });
    game.addSystem({
      name: 'wb-mesh-decos',
      update: (dt) => {
        for (const d of this.decos) d.root.rotation.y += d.spin * dt;
      },
    });
  }

  /** Demo: ask for a 3D mesh of the last forged thing. */
  async upgradeLast(): Promise<void> {
    const last = this.lastForged;
    if (!last) return void this.game.ui.toast('Forge something first (F), then upgrade it to 3D', { kind: 'warn' });
    if (!this.lf.online) return void this.game.ui.toast('🧊 3D models need the Reactive server (Hyper3D runs there)', { kind: 'warn', seconds: 4 });
    try {
      const r = await this.lf.ask('forge.item', { prompt: last.prompt.slice(0, 400), mesh: true }, { upgrade: false }).instant;
      const job = r.result.item.mesh;
      if (!job?.jobId) {
        this.game.ui.toast('No 3D provider on this server (needs a HYPER3D key and clamps.forge.meshJobs: true)', { seconds: 5 });
        this.lf.think({ source: 'forge', actor: 'forge', kind: 'tool_result', model: 'rules', text: `3D upgrade of ${last.name}: no mesh provider (kit: forge.item mesh:true started no job)`, data: { ok: false } });
        return;
      }
      this.pending.set(job.jobId, last.name);
      this.game.ui.toast(`🧊 Generating a 3D model of ${last.name}…`, { kind: 'good', seconds: 4 });
      this.lf.think({ source: 'forge', actor: 'forge', kind: 'tool_call', model: 'rules', text: `hyper3d(${JSON.stringify(last.prompt.slice(0, 60))}) → job ${job.jobId} (${job.state})` });
      if (job.state === 'done' && job.url) void this.load(job.jobId, job.url, last.name);
    } catch (err) {
      this.game.ui.toast(`3D upgrade failed: ${(err as Error).message}`, { kind: 'warn' });
    }
  }

  private async load(jobId: string, url: string, name?: string): Promise<void> {
    if (this.done.has(jobId)) return;
    this.done.add(jobId);
    const full = /^https?:/.test(url) ? url : this.lf.client.resolveUrl(url);
    const t0 = performance.now();
    try {
      this.loader.setRequestHeader(this.lf.client.authHeaders());
      const gltf = await this.loader.loadAsync(full);
      const root = new THREE.Group();
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const k = 1.4 / Math.max(size.x, size.y, size.z, 0.001);
      model.scale.setScalar(k);
      const c = box.getCenter(new THREE.Vector3());
      model.position.set(-c.x * k, -box.min.y * k, -c.z * k);
      root.add(model);
      // in front of the player, on the ground
      const p = this.game.player.position;
      const yaw = this.game.player.yaw;
      const x = p.x - Math.sin(yaw) * 2.5, z = p.z - Math.cos(yaw) * 2.5;
      const ground = this.game.world.heightAt(Math.floor(x), Math.floor(z));
      root.position.set(x, Math.max(ground + 1, Math.floor(p.y)), z);
      root.name = `hyper3d:${jobId}`;
      this.game.scene.add(root);
      this.decos.push({ root, spin: 0.6 });
      const label = name ?? 'your forged thing';
      this.game.ui.toast(`🧊 3D model ready: ${label}`, { kind: 'good', seconds: 5 });
      getHub().caption(`🧊 Hyper3D: ${label} as a real 3D model`, 6);
      this.lf.think({ source: 'forge', actor: 'forge', kind: 'tool_result', model: 'rules', ms: Math.round(performance.now() - t0), text: `🧊 3D model ready: ${label} (job ${jobId})`, data: { ok: true, url } });
    } catch (err) {
      console.warn('[mesh] GLB load failed', url, err);
    }
  }
}
