// LiveNPC: a talking, remembering NPC bound to a persona id. Proximity barks, text / voice conversation with
// streamed replies spoken through speechSynthesis, structured actions, directive routing (npc:<id>).
import * as THREE from "three";
import type { Directive, NpcAction, VoiceStyle } from "@liveforge/protocol";
import { Emitter, type AskHandle, type LiveforgeClient, type Unsubscribe } from "@liveforge/sdk";
import { speak, stopSpeaking } from "./tts.js";

export interface LiveNPCOptions {
  client: LiveforgeClient;
  /** Persona id from the manifest (`personas[].id`). */
  id: string;
  /** The NPC's object in the scene (for proximity). */
  object?: THREE.Object3D;
  /** The player's object (for proximity barks). */
  player?: THREE.Object3D;
  /** Bark when the player comes within this many metres. Default 4. 0 disables proximity barks. */
  barkRadius?: number;
  /** Min seconds between proximity barks. Default 25. */
  barkCooldownSec?: number;
  /** Speak lines with speechSynthesis. Default true. */
  speak?: boolean;
  /** Voice override. Default: the persona's voice from GET /v1/config, then whatever the server sends per line. */
  voice?: VoiceStyle;
  /** Stream replies sentence by sentence (spoken as they arrive). Default true. */
  stream?: boolean;
  /** Send `social.talked_to` when a conversation starts. Default true. */
  autoSignals?: boolean;
  /** Conversation turns kept and sent as `history`. Default 10. */
  historySize?: number;
  /** Extra context sent with every bark / reply (zone, time of day, quest state ...). */
  context?: () => Record<string, unknown>;
}

/** A line the NPC says. `stage`: instant (rules), partial (streamed sentence), upgrade (AI), bark, directive. */
export interface NpcLine {
  npc: string;
  text: string;
  stage: "instant" | "partial" | "upgrade" | "bark" | "directive";
  emote?: string;
  voice?: VoiceStyle;
  /** False for an instant line that an AI upgrade will replace (show it, don't speak it). */
  final: boolean;
}

type NpcEvents = {
  /** A line to show (speech bubble / chat log). */
  say: (line: NpcLine) => void;
  /** A structured action (trade, give, flee, call_guards ...), validated by the server against the manifest. */
  action: (action: NpcAction, source: "reply" | "bark" | "directive") => void;
  /** The NPC heard a rumour (`rumour.heard` directive). */
  rumour: (args: { rumourId: string; content: string; heat?: number }) => void;
  /** The NPC ended the conversation. */
  end: () => void;
  /** Mood change from a reply (-1..1). */
  mood: (delta: number) => void;
};

/**
 * Drop-in talking NPC.
 *
 * ```ts
 * const bess = new LiveNPC({ client: lf, id: "bess", object: bessMesh, player: playerMesh });
 * bess.on("say", (l) => bubble(l.npc, l.text));
 * bess.on("action", (a) => a.action === "trade" && openShop(a.args.priceMultiplier));
 * // each frame: bess.update(dt);   // proximity barks
 * await bess.talk("Any news from the bridge?");
 * ```
 */
export class LiveNPC extends Emitter<NpcEvents> {
  readonly id: string;
  object: THREE.Object3D | undefined;
  player: THREE.Object3D | undefined;
  private readonly client: LiveforgeClient;
  private readonly opts: LiveNPCOptions;
  private readonly history: Array<{ role: "player" | "npc"; text: string }> = [];
  private voice: VoiceStyle | undefined;
  private lastBark = -Infinity;
  private inRange = false;
  private talking = false;
  private conversationOpen = false;
  private readonly offs: Unsubscribe[] = [];
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  constructor(opts: LiveNPCOptions) {
    super();
    if (!opts.client) throw new Error("[liveforge] LiveNPC needs { client }");
    if (!opts.id) throw new Error("[liveforge] LiveNPC needs { id } (a persona id from the manifest)");
    this.opts = opts;
    this.client = opts.client;
    this.id = opts.id;
    this.object = opts.object;
    this.player = opts.player;
    this.voice = opts.voice;
    if (!this.voice) {
      void this.client.persona(this.id).then((p) => {
        if (p?.voice && !this.voice) this.voice = p.voice;
      }).catch(() => {});
    }
    const mine = (d: Directive) => d.target === `npc:${this.id}` || (d.args as { npc?: unknown }).npc === this.id;
    this.offs.push(
      this.client.on("npc.bark", (d) => {
        if (!mine(d)) return;
        this.deliver({ npc: this.id, text: d.args.text, stage: "directive", final: true, ...(d.args.emote ? { emote: d.args.emote } : {}), ...(d.args.voice ? { voice: d.args.voice } : {}) });
      }),
      this.client.on("npc.action", (d) => {
        if (!mine(d)) return;
        if (d.args.line) this.deliver({ npc: this.id, text: d.args.line, stage: "directive", final: true });
        this.emit("action", d.args.action, "directive");
      }),
      this.client.on("rumour.heard", (d) => {
        if (!mine(d)) return;
        this.emit("rumour", { rumourId: d.args.rumourId, content: d.args.content, ...(d.args.heat !== undefined ? { heat: d.args.heat } : {}) });
      }),
    );
  }

  /** True while a reply is in flight. */
  get busy(): boolean {
    return this.talking;
  }

  /** Proximity check: call every frame (or a few times a second). Barks "approach" when the player comes close. */
  update(_dt = 0): void {
    const radius = this.opts.barkRadius ?? 4;
    if (!radius || !this.object || !this.player) return;
    this.object.getWorldPosition(this.a);
    this.player.getWorldPosition(this.b);
    const near = this.a.distanceTo(this.b) <= radius;
    if (near && !this.inRange) {
      const now = performance.now() / 1000;
      if (now - this.lastBark >= (this.opts.barkCooldownSec ?? 25) && !this.talking) {
        this.lastBark = now;
        void this.bark("approach");
      }
    }
    if (!near && this.inRange && this.conversationOpen) this.endConversation();
    this.inRange = near;
  }

  /** Asks for a one-liner (`npc.bark`) and says it. Triggers: approach, idle, combat, gear, moment, greeting, farewell ... */
  bark(trigger = "idle", context?: Record<string, unknown>): AskHandle<"npc.bark"> {
    const ctx = { ...(this.opts.context?.() ?? {}), ...(context ?? {}) };
    const h = this.client.ask("npc.bark", { npc: this.id, trigger, ...(Object.keys(ctx).length ? { context: ctx } : {}) });
    void h.final.then((r) => {
      const res = r.result;
      this.deliver({ npc: this.id, text: res.text, stage: "bark", final: true, ...(res.emote ? { emote: res.emote } : {}), ...(res.voice ? { voice: res.voice } : {}) });
      for (const act of res.actions ?? []) this.emit("action", act, "bark");
    }).catch(() => {});
    return h;
  }

  /**
   * Says something to the NPC: text, or recorded audio (Blob) that is transcribed with POST /v1/stt first.
   * Lines arrive through the "say" event (instant, streamed partials, final upgrade); actions through "action".
   * Resolves with the ask handle once the request was sent.
   */
  async talk(input: string | Blob, opts: { language?: string } = {}): Promise<AskHandle<"npc.reply">> {
    let text: string;
    if (typeof input === "string") text = input.trim();
    else text = (await this.client.stt(input, opts.language ? { language: opts.language } : {})).text.trim();
    if (!text) throw new Error("[liveforge] LiveNPC.talk: nothing to say (empty text or silent audio)");
    if (!this.conversationOpen) {
      this.conversationOpen = true;
      if (this.opts.autoSignals !== false) this.client.signal("social.talked_to", { npc: this.id });
    }
    const historySize = this.opts.historySize ?? 10;
    const history = this.history.slice(-historySize);
    this.history.push({ role: "player", text });
    const ctx = this.opts.context?.();
    const stream = this.opts.stream !== false;
    const h = this.client.ask("npc.reply", {
      npc: this.id,
      text: text.slice(0, 1000),
      ...(history.length ? { history } : {}),
      ...(stream ? { stream: true } : {}),
      ...(ctx && Object.keys(ctx).length ? { context: ctx } : {}),
    });
    this.talking = true;
    let spokePartials = false;
    h.onPartial((p) => {
      spokePartials = true;
      this.deliver({ npc: this.id, text: p.text, stage: "partial", final: false }, true);
    });
    void (async () => {
      try {
        const inst = await h.instant;
        const pending = inst.upgrade === "pending";
        const ir = inst.result;
        this.emitLine({ npc: this.id, text: ir.text, stage: "instant", final: !pending, ...(ir.emote ? { emote: ir.emote } : {}), ...(ir.voice ? { voice: ir.voice } : {}) }, !pending);
        const up = pending ? await h.upgrade : null;
        const final = up?.result ?? ir;
        if (up) {
          this.emitLine({ npc: this.id, text: final.text, stage: "upgrade", final: true, ...(final.emote ? { emote: final.emote } : {}), ...(final.voice ? { voice: final.voice } : {}) }, !spokePartials);
        } else if (pending && !spokePartials) {
          // The upgrade never came: speak the instant answer after all.
          this.speakLine(ir.text, ir.voice);
        }
        this.history.push({ role: "npc", text: final.text });
        while (this.history.length > historySize * 2) this.history.shift();
        for (const act of final.actions ?? []) this.emit("action", act, "reply");
        if (typeof final.mood === "number" && final.mood !== 0) this.emit("mood", final.mood);
        if (final.end) this.endConversation();
      } catch (err) {
        console.warn(`[liveforge] ${this.id} could not reply:`, err);
      } finally {
        this.talking = false;
      }
    })();
    return h;
  }

  /** Closes the conversation (clears history; fires "end"). */
  endConversation(): void {
    if (!this.conversationOpen) return;
    this.conversationOpen = false;
    this.history.length = 0;
    this.emit("end");
  }

  /** Stops listening to directives and silences speech. */
  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    stopSpeaking();
    this.clear();
  }

  private emitLine(line: NpcLine, spoken: boolean): void {
    this.emit("say", line);
    if (spoken) this.speakLine(line.text, line.voice);
  }

  private deliver(line: NpcLine, speakIt = true): void {
    this.emit("say", line);
    if (speakIt) this.speakLine(line.text, line.voice);
  }

  private speakLine(text: string, voice?: VoiceStyle): void {
    if (this.opts.speak === false || !text) return;
    void speak(text, { voice: { ...(this.voice ?? {}), ...(voice ?? {}) } });
  }
}
