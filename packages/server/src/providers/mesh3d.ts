// 3D generation adapter + Hyper3D Rodin implementation (ported from Counterforge packages/pipeline/src/hyper3d.ts;
// fetch-based, runs in Node / Workers). Flow: POST /rodin -> POST /status -> POST /download -> GET file.
// jobId encoding: status needs `jobs.subscription_key`, download needs the top-level `uuid`, so the opaque jobId is
// "<uuid>:<subscription_key>".

export type MeshJobState = "queued" | "generating" | "done" | "failed";

/** Any text-to-3D service. The forge job runner (core/jobs.ts) drives it; modules call ctx.jobs.submitMesh. */
export interface Mesh3DProvider {
  readonly id: string;
  submit(prompt: string, options?: Record<string, string | number | undefined>): Promise<{ jobId: string }>;
  status(jobId: string): Promise<{ state: MeshJobState }>;
  /** Fetch the finished GLB bytes (call once state is "done"). */
  download(jobId: string): Promise<ArrayBuffer>;
}

/** Appended (once) to every mesh prompt for a consistent low-poly look. */
export const STYLE_SUFFIX = ", low poly, stylized, flat colors, game asset, single object, no background";

export interface Hyper3DConfig {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

export type JobState = MeshJobState;

/** Submit options. Only fields with a defined value are sent. */
export interface Hyper3DOptions {
  /** Documented. Always send a Gen-2.5 tier explicitly (otherwise falls back to Gen-1/1.5 behaviour). */
  tier?: string;
  /** Documented: `glb` is supported. */
  geometry_file_format?: string;
  /** Documented: examples use `Raw`. Required for fast mode. */
  mesh_mode?: string;
  /** UNVERIFIED semantics (likely a target face count; docs: <= 20000 enables fast mode). One-line change after the live probe. */
  quality_override?: number;
  /** UNVERIFIED value set (docs examples use "medium"). Left unset by default. */
  quality?: string;
}

/**
 * Lowest-cost / lowest-poly settings. `tier`, `geometry_file_format`, `mesh_mode` are documented;
 * `quality_override` is UNVERIFIED (see Hyper3DOptions). Edit here after `scripts/probe-hyper3d.ts` runs.
 */
export const HYPER3D_DEFAULTS: Hyper3DOptions = {
  tier: "Gen-2.5-Extreme-Low",
  geometry_file_format: "glb",
  mesh_mode: "Raw",
  quality_override: 2000,
};

// ---- jobId encoding -------------------------------------------------------------------------

export function encodeJobId(uuid: string, subscriptionKey: string): string {
  return `${uuid}:${subscriptionKey}`;
}

export function decodeJobId(jobId: string): { uuid: string; subscriptionKey: string } {
  const i = jobId.indexOf(":");
  if (i <= 0 || i === jobId.length - 1) throw new Error(`Malformed Hyper3D jobId: ${jobId}`);
  return { uuid: jobId.slice(0, i), subscriptionKey: jobId.slice(i + 1) };
}

// ---- state mapping --------------------------------------------------------------------------

/** Aggregate raw per-job statuses (Waiting/Generating/Done/Failed): any Failed -> failed; all Done -> done; any Generating -> generating; else queued. */
export function aggregateState(rawStatuses: string[]): JobState {
  if (rawStatuses.includes("Failed")) return "failed";
  if (rawStatuses.length > 0 && rawStatuses.every((s) => s === "Done")) return "done";
  if (rawStatuses.includes("Generating")) return "generating";
  return "queued";
}

// ---- HTTP -----------------------------------------------------------------------------------

async function call(cfg: Hyper3DConfig, path: string, init: RequestInit): Promise<any> {
  const doFetch = cfg.fetch ?? fetch;
  const res = await doFetch(`${cfg.baseUrl.replace(/\/+$/, "")}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    const ra = res.headers.get("retry-after");
    throw new Error(`Hyper3D ${path} failed: HTTP ${res.status}${ra ? ` (Retry-After ${ra})` : ""} ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Hyper3D ${path}: non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

const authHeader = (cfg: Hyper3DConfig) => ({ Authorization: `Bearer ${cfg.apiKey}` });
const jsonPost = (cfg: Hyper3DConfig, body: unknown): RequestInit => ({
  method: "POST",
  headers: { ...authHeader(cfg), "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ---- API ------------------------------------------------------------------------------------

/** Submit a text-to-3D job. `meshPrompt` is sent as-is (the caller appends STYLE_SUFFIX). `options` merge over HYPER3D_DEFAULTS. */
export async function submitJob(
  cfg: Hyper3DConfig,
  meshPrompt: string,
  options: Hyper3DOptions = {},
): Promise<{ jobId: string }> {
  // multipart/form-data; Content-Type is deliberately NOT set so fetch generates the boundary.
  const form = new FormData();
  form.append("prompt", meshPrompt);
  const merged: Hyper3DOptions = { ...HYPER3D_DEFAULTS, ...options };
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) form.append(k, String(v));
  const body = await call(cfg, "/rodin", { method: "POST", headers: authHeader(cfg), body: form });
  if (body.error) throw new Error(`Hyper3D submit rejected: ${body.error}${body.message ? ` (${body.message})` : ""}`);
  const uuid: unknown = body.uuid;
  const subscriptionKey: unknown = body.jobs?.subscription_key;
  if (typeof uuid !== "string" || !uuid || typeof subscriptionKey !== "string" || !subscriptionKey) {
    throw new Error("Hyper3D submit response missing uuid / jobs.subscription_key");
  }
  return { jobId: encodeJobId(uuid, subscriptionKey) };
}

export async function getJobStatus(cfg: Hyper3DConfig, jobId: string): Promise<{ state: JobState }> {
  const { subscriptionKey } = decodeJobId(jobId);
  const body = await call(cfg, "/status", jsonPost(cfg, { subscription_key: subscriptionKey }));
  if (body.error) throw new Error(`Hyper3D status rejected: ${body.error}${body.message ? ` (${body.message})` : ""}`);
  const jobs: { status?: unknown }[] = Array.isArray(body.jobs) ? body.jobs : [];
  return { state: aggregateState(jobs.map((j) => String(j.status))) };
}

/** Download-list lookup; returns the .glb file URL (URLs expire: fetch the bytes promptly). Call only once state is "done". */
export async function getGlbUrl(cfg: Hyper3DConfig, jobId: string): Promise<string> {
  const { uuid } = decodeJobId(jobId);
  const body = await call(cfg, "/download", jsonPost(cfg, { task_uuid: uuid }));
  const list: { name?: string; url?: string }[] = Array.isArray(body.list) ? body.list : [];
  const isGlb = (s: string | undefined) => !!s && /\.glb(\?|#|$)/i.test(s);
  const hit = list.find((f) => isGlb(f.name) && f.url) ?? list.find((f) => isGlb(f.url));
  if (!hit?.url) throw new Error(`Hyper3D download list has no .glb entry (files: ${list.map((f) => f.name).join(", ") || "none"})`);
  return hit.url;
}

/** Fetch the GLB bytes. File URLs are assumed pre-signed (UNVERIFIED); retries once with auth on 401/403. */
export async function fetchGlbBytes(cfg: Hyper3DConfig, url: string): Promise<ArrayBuffer> {
  const doFetch = cfg.fetch ?? fetch;
  let res = await doFetch(url);
  if (res.status === 401 || res.status === 403) res = await doFetch(url, { headers: authHeader(cfg) });
  if (!res.ok) throw new Error(`Hyper3D GLB fetch failed: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** Hyper3D Rodin as a Mesh3DProvider. */
export class Hyper3DProvider implements Mesh3DProvider {
  readonly id = "hyper3d";
  constructor(private readonly cfg: Hyper3DConfig) {}
  submit(prompt: string, options: Record<string, string | number | undefined> = {}) {
    const p = prompt.endsWith(STYLE_SUFFIX) ? prompt : prompt + STYLE_SUFFIX;
    return submitJob(this.cfg, p, options as Hyper3DOptions);
  }
  status(jobId: string) {
    return getJobStatus(this.cfg, jobId);
  }
  async download(jobId: string) {
    return fetchGlbBytes(this.cfg, await getGlbUrl(this.cfg, jobId));
  }
}
