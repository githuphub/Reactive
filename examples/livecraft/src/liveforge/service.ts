/**
 * The game's Reactive service: one `@liveforge/sdk` client per session, connection status, the cassette-mode
 * label, persona voices, and safe wrappers so no gameplay path ever throws because Reactive is down.
 *
 * Offline (no server, or `?lf=off`) every ask answers from the local rules (`client.setFallback`, see rules.ts),
 * agent goals run on the SDK's local template runner, builder plans come from the SDK's template planner, and
 * raid plans from the local counter-table. Signals queue (or are dropped with `?lf=off`).
 *
 * ```ts
 * const lf = getLiveforge();
 * lf.signal('build.pillared', { height: 6 });
 * const h = lf.ask('npc.reply', { npc: 'bram', text: 'hello' });
 * lf.think({ source: 'forge', actor: 'forge', kind: 'plan', text: 'Stormcaller pickaxe', model: 'rules' });
 * ```
 */
import {
  Emitter, createClient,
  type AskHandle, type AskKind, type AskOptions, type AskParamsInput, type BrainDraft, type BrainEntry,
  type LiveforgeClient, type LiveforgeError, type PublicConfig, type VoiceStyle,
} from '@liveforge/sdk';
import type { LiveforgeSettings } from './config';

/** off = `?lf=off`; connecting = first contact; online = the server answers; offline = unreachable (retrying). */
export type LfStatus = 'off' | 'connecting' | 'online' | 'offline';

/** What answered recently: a live model, cassettes, rules only, or no server at all. */
export type CassetteLabel = 'LIVE' | 'RECORD' | 'REPLAY' | 'RULES' | 'OFFLINE';

type ServiceEvents = {
  status: (s: LfStatus) => void;
  cassette: (label: CassetteLabel) => void;
  /** Fired once each time the server becomes reachable (re-register tools, re-send context). */
  online: () => void;
};

const RETRY_MS = 15_000;

/** Custom signal types declared in the Livecraft manifest. */
export type LivecraftSignal =
  | 'block.broken' | 'block.placed' | 'build.pillared' | 'combat.shot_bow' | 'combat.hid' | 'movement.sprinted'
  | 'item.crafted' | 'item.forged' | 'item.used' | 'night.survived';

export class LiveforgeService extends Emitter<ServiceEvents> {
  readonly settings: LiveforgeSettings;
  readonly client: LiveforgeClient;
  status: LfStatus;
  /** Persona cards from GET /v1/config (voices), once online. */
  personas = new Map<string, PublicConfig['personas'][number]>();
  /** Modules switched on in the server's manifest (empty until online). */
  modules: Record<string, boolean> = {};
  /** Server has an LLM provider (from /health); null = unknown. */
  serverLlm: boolean | null = null;
  /** Server speech-to-text provider id (from /health); null = none configured, undefined = unknown. */
  serverStt: string | null | undefined = undefined;
  private seenModel: CassetteLabel | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private warned = false;

  constructor(settings: LiveforgeSettings) {
    super();
    this.settings = settings;
    const off = !settings.url;
    this.status = off ? 'off' : 'connecting';
    this.client = createClient({
      url: settings.url ?? 'http://offline.invalid',
      gameKey: settings.key,
      player: settings.player,
      world: settings.world,
      offline: off,
      requestTimeoutMs: 6000,
      upgradeTimeoutMs: 45_000,
      onError: (err) => this.onClientError(err),
    });
    this.client.brain.subscribe((e) => this.noteModel(e));
    if (off) return;
    this.client.onStatus((s) => {
      if (s === 'open') this.setStatus('online');
    });
    void this.connect();
  }

  /** True while the server answers. */
  get online(): boolean {
    return this.status === 'online';
  }

  /** The badge label: forced by `?cassette=`, else what the Brain badges and /health say. */
  get cassette(): CassetteLabel {
    if (this.status === 'off' || this.status === 'offline') return 'OFFLINE';
    const forced = this.settings.cassette?.toUpperCase();
    if (forced === 'LIVE' || forced === 'RECORD' || forced === 'REPLAY' || forced === 'RULES') return forced;
    if (this.seenModel) return this.seenModel;
    if (this.serverLlm === false) return 'RULES';
    return this.serverLlm ? 'LIVE' : 'RULES';
  }

  /** Tries to reach the server now (startup, and every 15 s while offline). */
  async connect(): Promise<boolean> {
    if (!this.settings.url) return false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      const cfg = await this.client.connect();
      this.personas = new Map(cfg.personas.map((p) => [p.id, p]));
      this.modules = { ...(cfg.modules as Record<string, boolean>) };
      void this.health();
      const was = this.status;
      this.setStatus('online');
      if (was !== 'online') this.emit('online');
      return true;
    } catch {
      this.setStatus('offline');
      this.retryTimer = setTimeout(() => void this.connect(), RETRY_MS);
      return false;
    }
  }

  /** Persona voice from the server config (undefined offline). */
  voiceOf(npc: string): VoiceStyle | undefined {
    return this.personas.get(npc)?.voice;
  }

  /** Fire-and-forget signal (never throws). */
  signal(type: string, data: Record<string, unknown> = {}): void {
    try {
      (this.client.signal as (t: string, d: Record<string, unknown>) => void).call(this.client, type, data);
    } catch (err) {
      console.warn('[liveforge] signal failed', type, err);
    }
  }

  /** `client.ask` with a short timeout while the server is known to be down (the local answer comes fast). */
  ask<K extends AskKind>(kind: K, params: AskParamsInput<K>, opts: AskOptions<K> = {}): AskHandle<K> {
    const o = this.status === 'offline' && opts.timeoutMs === undefined ? { ...opts, timeoutMs: 1200 } : opts;
    return this.client.ask(kind, params, o);
  }

  /** Adds a local Brain entry (offline rules, game-side reasoning). */
  think(draft: BrainDraft): BrainEntry {
    return this.client.brain.add(draft);
  }

  private async health(): Promise<void> {
    if (!this.settings.url) return;
    try {
      const r = await fetch(`${this.settings.url}/health`);
      const j = (await r.json()) as { llm?: boolean; stt?: string | null };
      this.serverLlm = !!j.llm;
      this.serverStt = j.stt ?? null;
      this.emit('cassette', this.cassette);
    } catch {
      /* stays unknown */
    }
  }

  private noteModel(e: BrainEntry): void {
    if (e.id.startsWith('local_')) return;
    const label: CassetteLabel | null = e.model === 'replay' ? 'REPLAY' : e.model === 'sonnet' || e.model === 'haiku' ? 'LIVE' : null;
    if (!label || label === this.seenModel) return;
    this.seenModel = label;
    this.emit('cassette', this.cassette);
  }

  private setStatus(s: LfStatus): void {
    if (this.status === s || this.status === 'off') return;
    this.status = s;
    if (s === 'offline' && !this.retryTimer && this.settings.url) {
      this.retryTimer = setTimeout(() => void this.connect(), RETRY_MS);
    }
    this.emit('status', s);
    this.emit('cassette', this.cassette);
  }

  private onClientError(err: LiveforgeError): void {
    if (err.code === 'network' || err.code === 'timeout') {
      if (this.client.status !== 'open') this.setStatus('offline');
      if (!this.warned) console.info('[liveforge] server unreachable: running on local rules (retrying in the background)');
      this.warned = true;
      return;
    }
    console.warn('[liveforge]', err.message);
  }
}

let current: LiveforgeService | null = null;

/** @internal set by the plugin. */
export function setLiveforge(s: LiveforgeService): void {
  current = s;
}

/** The running Reactive service (throws before the plugin initialised it). */
export function getLiveforge(): LiveforgeService {
  if (!current) throw new Error('Reactive is not initialised yet (liveforge/plugin.ts runs at plugin init)');
  return current;
}

/** The running service, or null. */
export function maybeLiveforge(): LiveforgeService | null {
  return current;
}
