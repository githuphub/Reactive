// Forge job runner: 3D mesh jobs (Hyper3D) submitted by modules, polled in the background, GLBs stored under
// <dataDir>/assets and served at /v1/assets/:file. On completion: WS `job`, `forge.ready` directive, lf.forge.job event.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgeJob } from "@liveforge/protocol";
import type { Db } from "../store/db.js";
import type { Mesh3DProvider } from "../providers/mesh3d.js";
import type { Logger } from "../log.js";

type Row = {
  id: string; game: string; world: string; player: string | null; provider: string; provider_job: string | null; state: ForgeJob["state"];
  prompt: string; url: string | null; error: string | null; ask_id: string | null; meta: string | null; created_at: number; updated_at: number;
};
const toJob = (r: Row): ForgeJob => ({
  id: r.id, provider: r.provider, state: r.state, prompt: r.prompt, createdAt: r.created_at, updatedAt: r.updated_at,
  ...(r.url ? { url: r.url } : {}), ...(r.error ? { error: r.error } : {}), ...(r.ask_id ? { askId: r.ask_id } : {}),
});

export interface JobEvents {
  onChange(job: ForgeJob, scope: { game: string; world: string; player: string | null; meta: Record<string, unknown> }): void;
}

export class JobRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  readonly assetsDir: string;

  constructor(
    private readonly db: Db,
    private readonly provider: Mesh3DProvider | null,
    dataDir: string,
    private readonly pollMs: number,
    private readonly events: JobEvents,
    private readonly log: Logger,
  ) {
    this.assetsDir = join(dataDir, "assets");
  }

  get available(): boolean {
    return !!this.provider;
  }

  start(): void {
    if (!this.provider || this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(id: string, game?: string): ForgeJob | null {
    const row = this.db.prepare("SELECT * FROM forge_jobs WHERE id = ?").get(id) as Row | undefined;
    if (!row || (game && row.game !== game)) return null;
    return toJob(row);
  }

  list(game: string, limit = 100): ForgeJob[] {
    return (this.db.prepare("SELECT * FROM forge_jobs WHERE game = ? ORDER BY created_at DESC LIMIT ?").all(game, limit) as Row[]).map(toJob);
  }

  async submit(game: string, prompt: string, opts: { world: string; player?: string | null; askId?: string; meta?: Record<string, unknown> }): Promise<ForgeJob | null> {
    if (!this.provider) return null;
    const id = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = Date.now();
    this.db.prepare("INSERT INTO forge_jobs (id, game, world, player, provider, provider_job, state, prompt, ask_id, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 'queued', ?, ?, ?, ?, ?)")
      .run(id, game, opts.world, opts.player ?? null, this.provider.id, prompt, opts.askId ?? null, JSON.stringify(opts.meta ?? {}), now, now);
    try {
      const { jobId } = await this.provider.submit(prompt);
      this.db.prepare("UPDATE forge_jobs SET provider_job = ?, updated_at = ? WHERE id = ?").run(jobId, Date.now(), id);
    } catch (e) {
      this.update(id, "failed", { error: (e as Error).message.slice(0, 300) });
    }
    const job = this.get(id)!;
    this.notify(id);
    return job;
  }

  private update(id: string, state: ForgeJob["state"], extra: { url?: string; error?: string } = {}): void {
    this.db.prepare("UPDATE forge_jobs SET state = ?, url = COALESCE(?, url), error = COALESCE(?, error), updated_at = ? WHERE id = ?")
      .run(state, extra.url ?? null, extra.error ?? null, Date.now(), id);
  }

  private notify(id: string): void {
    const row = this.db.prepare("SELECT * FROM forge_jobs WHERE id = ?").get(id) as Row | undefined;
    if (!row) return;
    try {
      this.events.onChange(toJob(row), { game: row.game, world: row.world, player: row.player, meta: row.meta ? JSON.parse(row.meta) : {} });
    } catch (e) {
      this.log.error("job notify failed", { id, error: e as Error });
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.provider) return;
    this.polling = true;
    try {
      const rows = this.db.prepare("SELECT * FROM forge_jobs WHERE state IN ('queued', 'generating') AND provider_job IS NOT NULL").all() as Row[];
      for (const r of rows) {
        try {
          const { state } = await this.provider.status(r.provider_job!);
          if (state === "done") {
            const bytes = await this.provider.download(r.provider_job!);
            mkdirSync(this.assetsDir, { recursive: true });
            const file = `${r.id}.glb`;
            writeFileSync(join(this.assetsDir, file), Buffer.from(bytes));
            this.update(r.id, "done", { url: `/v1/assets/${file}` });
            this.notify(r.id);
          } else if (state !== r.state) {
            this.update(r.id, state, state === "failed" ? { error: "provider reported failure" } : {});
            this.notify(r.id);
          }
        } catch (e) {
          this.log.warn("job poll failed", { id: r.id, error: e as Error });
          if (Date.now() - r.created_at > 15 * 60_000) {
            this.update(r.id, "failed", { error: `timed out: ${(e as Error).message}`.slice(0, 300) });
            this.notify(r.id);
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
