// The dashboard reads everything through one DataSource. LiveSource talks to a Liveforge server's /admin API and
// admin WebSocket; DemoSource runs an in-browser simulation of the Counterforge example manifest so the dashboard
// works (and can be filmed) with no server at all. Both return the protocol shapes from @liveforge/protocol.
import type {
  BakePack, Directive, EventPage, ProjectionName, ProjectionState, ReviewItem, SimulateRequest, StatsResponse, StoredEvent,
} from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";

export type ConnStatus = "connecting" | "live" | "polling" | "offline" | "demo";

export interface PersonaInfo {
  id: string;
  name: string;
  role: string;
  faction?: string;
  zone?: string;
}

/** What the dashboard knows about the game it is looking at. */
export interface GameInfo {
  id: string;
  name: string;
  protocol: string;
  serverVersion: string;
  modules: Record<string, boolean>;
  personas: PersonaInfo[];
  factions: { id: string; name: string }[];
  bosses: { id: string; name: string; phases: number }[];
  /** Other games the admin key can see (multi-game servers). */
  games: { id: string; name: string }[];
}

export interface PlayerSummary {
  id: string;
  events: number;
  lastSeen: number | null;
}

export interface WorldSummary {
  id: string;
  events: number;
  lastEventAt: number | null;
  players: PlayerSummary[];
}

export interface EventQuery {
  world?: string;
  player?: string;
  /** Only events with seq > after. */
  after?: number;
  limit?: number;
  /** Exact type or "ns.*". */
  type?: string;
}

export interface ManifestDoc {
  manifest: Manifest | null;
  /** Raw liveforge.yaml text when the server exposes it. */
  yaml: string | null;
  filename?: string;
}

export interface SimulateResult {
  accepted: number;
  rejected?: { index: number; code: string; message: string }[];
  lastSeq?: number | null;
}

export interface LiveHandlers {
  onEvent(e: StoredEvent): void;
  onDirective(d: Directive): void;
  onStatus(s: ConnStatus, detail?: string): void;
}

export interface DataSource {
  readonly mode: "live" | "demo";
  /** Shown in the top bar ("localhost:8787", "Demo data"). */
  readonly label: string;
  game(): Promise<GameInfo>;
  manifest(): Promise<ManifestDoc>;
  worlds(): Promise<WorldSummary[]>;
  events(q: EventQuery): Promise<EventPage>;
  /** One projection state. Player-scope projections need `player`. */
  projection<N extends ProjectionName>(name: N, world: string, player?: string | null): Promise<ProjectionState<N> | null>;
  /** Every player's state of a player-scope projection in a world. */
  projectionAll<N extends ProjectionName>(name: N, world: string): Promise<{ player: string; state: ProjectionState<N> }[]>;
  stats(): Promise<StatsResponse>;
  simulate(req: SimulateRequest): Promise<SimulateResult>;
  reviewList(): Promise<ReviewItem[]>;
  reviewSet(id: string, status: ReviewItem["status"], note?: string): Promise<ReviewItem>;
  bakeExport(): Promise<BakePack>;
  /** Live event + directive stream for a world. Returns an unsubscribe function. */
  connect(world: string, handlers: LiveHandlers): () => void;
  close(): void;
}

/** Error thrown by the admin client with the server's error code. */
export class AdminError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AdminError";
  }
}
