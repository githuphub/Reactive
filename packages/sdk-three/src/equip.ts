// LiveEquipSlot: attaches forged gear (ForgedItem / Blueprint) to a bone or object, forges from a prompt
// (instant blueprint first, AI upgrade swapped in), and optionally swaps in a Hyper3D mesh when it is ready.
import * as THREE from "three";
import type { Blueprint, ForgedItem } from "@liveforge/protocol";
import { Emitter, type AskHandle, type LiveforgeClient, type Unsubscribe } from "@liveforge/sdk";
import { buildBlueprint, type BlueprintObject, type BuildBlueprintOptions } from "./blueprint.js";
import { buildVfx, type VfxObject } from "./vfx.js";
import { applyVariant, type VariantHandle } from "./variant.js";

export interface LiveEquipSlotOptions {
  /** The bone / object the gear hangs from (a hand bone, a back socket, a weapon rack ...). */
  socket: THREE.Object3D;
  /** Needed for forge() and gear signals. */
  client?: LiveforgeClient;
  /** Slot name sent with forge asks and gear signals. Default "weapon". */
  slot?: string;
  /** Scale gear so its longest extent is this many metres. Default: authored size. */
  length?: number;
  /** Send gear.equipped / gear.unequipped signals. Default true (when a client is set). */
  signals?: boolean;
  /** Extra build options (detail, castShadow, autoAnimate ...). */
  build?: Omit<BuildBlueprintOptions, "length">;
  /**
   * Load a generated mesh (GLB) when a Hyper3D job finishes, e.g. with GLTFLoader:
   * `(url, headers) => { loader.setRequestHeader(headers); return loader.loadAsync(url).then((g) => g.scene); }`.
   * When omitted the blueprint stays.
   */
  loadMesh?: (url: string, headers: Record<string, string>) => Promise<THREE.Object3D>;
}

type EquipEvents = {
  equipped: (item: ForgedItem | null, object: THREE.Object3D) => void;
  unequipped: (item: ForgedItem | null) => void;
  /** The AI upgrade of a forge() replaced the instant item. */
  upgraded: (item: ForgedItem) => void;
  /** A generated mesh replaced the blueprint. */
  mesh: (object: THREE.Object3D, item: ForgedItem | null) => void;
  error: (err: unknown) => void;
};

/**
 * Equip slot for generated gear.
 *
 * ```ts
 * const hand = new LiveEquipSlot({ client: lf, socket: rightHandBone, length: 1.1 });
 * hand.forge("a rusty cleaver that drips green fire");
 * // each frame: hand.animate(t);
 * ```
 */
export class LiveEquipSlot extends Emitter<EquipEvents> {
  readonly socket: THREE.Object3D;
  /** Current item (null for a bare blueprint or empty). */
  item: ForgedItem | null = null;
  /** Current visual (BlueprintObject or loaded mesh), parented to the socket. */
  object: THREE.Object3D | null = null;
  private readonly opts: LiveEquipSlotOptions;
  private effects: VfxObject[] = [];
  private variant: VariantHandle | null = null;
  private forgeSeq = 0;
  private readonly offs: Unsubscribe[] = [];
  private waitingJob: string | null = null;

  constructor(opts: LiveEquipSlotOptions) {
    super();
    if (!opts.socket) throw new Error("[liveforge] LiveEquipSlot needs { socket } (a bone or Object3D)");
    this.opts = opts;
    this.socket = opts.socket;
    if (opts.client) {
      this.offs.push(
        opts.client.on("forge.ready", (d) => {
          if (!this.waitingJob || d.args.jobId !== this.waitingJob) return;
          this.waitingJob = null;
          if (d.args.state === "done" && d.args.url) void this.swapMesh(d.args.url);
        }),
      );
    }
  }

  get slot(): string {
    return this.opts.slot ?? "weapon";
  }

  /** Equips a ForgedItem (blueprint + vfx + variant) or a bare Blueprint. Returns the built object. */
  equip(gear: ForgedItem | Blueprint): THREE.Object3D {
    const isItem = (g: ForgedItem | Blueprint): g is ForgedItem => "blueprint" in g && "stats" in g;
    const item = isItem(gear) ? gear : null;
    const bp = item ? item.blueprint : (gear as Blueprint);
    this.removeVisual();
    const obj = buildBlueprint(bp, { ...(this.opts.build ?? {}), ...(this.opts.length ? { length: this.opts.length } : {}) });
    this.alignGrip(obj);
    this.socket.add(obj);
    this.object = obj;
    if (item?.vfx) {
      const fx = buildVfx(item.vfx, { attachments: obj.attachments });
      (obj.attachment(item.vfx.attach ?? "") ?? obj.attachment("tip") ?? obj).add(fx);
      this.effects.push(fx);
    }
    if (item?.variant) this.variant = applyVariant(obj, item.variant);
    const prev = this.item;
    this.item = item;
    if (this.signalsOn && item && (!prev || prev.id !== item.id)) {
      this.opts.client!.signal("gear.equipped", {
        item: item.id, slot: item.slot ?? this.slot, name: item.name, tags: item.tags ?? [],
        ...(typeof item.stats.value === "number" ? { value: item.stats.value } : {}),
      });
    }
    this.emit("equipped", item, obj);
    return obj;
  }

  /** Removes the current gear. */
  unequip(): void {
    const item = this.item;
    this.removeVisual();
    this.item = null;
    this.waitingJob = null;
    if (item && this.signalsOn) this.opts.client!.signal("gear.unequipped", { item: item.id, slot: item.slot ?? this.slot });
    this.emit("unequipped", item);
  }

  /**
   * Forges an item from a prompt (`forge.item`) and equips it: the instant (rules) item at once, then the AI
   * upgrade when it lands. Requests a 3D mesh job too when `loadMesh` is set.
   */
  forge(prompt: string, params: { family?: string; element?: string; context?: Record<string, unknown> } = {}): AskHandle<"forge.item"> {
    const client = this.opts.client;
    if (!client) throw new Error("[liveforge] LiveEquipSlot.forge needs { client }");
    const seq = ++this.forgeSeq;
    const h = client.ask("forge.item", { prompt: prompt.slice(0, 400), slot: this.slot, ...params, ...(this.opts.loadMesh ? { mesh: true } : {}) });
    void h.instant.then((r) => {
      if (seq !== this.forgeSeq) return;
      this.equipSafe(r.result.item);
      this.trackJob(r.result.item);
    }).catch((err) => this.emit("error", err));
    h.onUpgrade((r) => {
      if (seq !== this.forgeSeq) return;
      if (this.equipSafe(r.result.item)) this.emit("upgraded", r.result.item);
      this.trackJob(r.result.item);
    });
    return h;
  }

  /** Advances blueprint animations (seconds). */
  animate(t: number): void {
    (this.object as BlueprintObject | null)?.animate?.(t);
  }

  dispose(): void {
    this.removeVisual();
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.clear();
  }

  private get signalsOn(): boolean {
    return !!this.opts.client && this.opts.signals !== false;
  }

  private equipSafe(item: ForgedItem): boolean {
    try {
      this.equip(item);
      return true;
    } catch (err) {
      this.emit("error", err);
      return false;
    }
  }

  private trackJob(item: ForgedItem): void {
    if (!this.opts.loadMesh || !item.mesh) return;
    if (item.mesh.state === "done" && item.mesh.url) void this.swapMesh(item.mesh.url);
    else if (item.mesh.state !== "failed") this.waitingJob = item.mesh.jobId;
  }

  private async swapMesh(url: string): Promise<void> {
    const client = this.opts.client;
    if (!this.opts.loadMesh || !client) return;
    const item = this.item;
    try {
      const mesh = await this.opts.loadMesh(client.resolveUrl(url), client.authHeaders());
      if (this.item !== item) return; // gear changed meanwhile
      // Fit the mesh to the blueprint's size and keep the VFX.
      const box = new THREE.Box3().setFromObject(mesh);
      const size = box.getSize(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z, 1e-3);
      const target = this.opts.length ?? ((this.object as BlueprintObject | null)?.measure ?? longest);
      mesh.scale.multiplyScalar(target / longest);
      const old = this.object;
      const keep = this.effects;
      if (old) {
        for (const fx of keep) fx.removeFromParent();
        (old as BlueprintObject).dispose?.();
      }
      this.socket.add(mesh);
      for (const fx of keep) mesh.add(fx);
      this.object = mesh;
      this.emit("mesh", mesh, item);
    } catch (err) {
      this.emit("error", err);
    }
  }

  /** Held items: the grip attachment sits on the socket origin. */
  private alignGrip(obj: BlueprintObject): void {
    const grip = obj.attachment("grip");
    if (grip && grip.position.lengthSq() > 0) obj.position.copy(grip.position).multiplyScalar(-obj.scaleFactor);
  }

  private removeVisual(): void {
    this.variant?.revert();
    this.variant = null;
    for (const fx of this.effects) fx.dispose();
    this.effects = [];
    if (this.object) {
      const o = this.object as BlueprintObject;
      if (typeof o.dispose === "function" && o.blueprint) o.dispose();
      else o.removeFromParent();
    }
    this.object = null;
  }
}
