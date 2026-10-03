// Liveforge dashboard (K5 owns; K0 skeleton). The dashboard is a static app talking to the server's /admin/* API
// and the admin WebSocket (topics ["events"]). See docs/CONTRACTS.md §9, §12. K5 may replace this package's build
// (e.g. Vite) as long as `npm run build` at the repo root keeps passing.
import type { StatsResponse, EventPage } from "@liveforge/protocol";

export interface AdminApiOptions {
  url: string;
  adminKey: string;
  game?: string;
}

/** Minimal typed admin client to start from. */
export function adminApi(o: AdminApiOptions) {
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${o.url.replace(/\/+$/, "")}/admin${path}`, {
      headers: { Authorization: `Bearer ${o.adminKey}`, ...(o.game ? { "x-liveforge-game": o.game } : {}) },
    });
    if (!res.ok) throw new Error(`admin ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    stats: () => get<StatsResponse>("/stats"),
    events: (q = "") => get<EventPage>(`/events${q}`),
    projection: <S = unknown>(name: string, world: string, player?: string) =>
      get<{ state?: S; players?: Record<string, S> }>(`/projections/${name}?world=${encodeURIComponent(world)}${player ? `&player=${encodeURIComponent(player)}` : ""}`),
  };
}
