/**
 * Liveforge connection settings. URL params win over Vite env vars, which win over the defaults:
 *
 * | Param | Env | Default | |
 * |---|---|---|---|
 * | `?lf=http://host:8790` | `VITE_LIVEFORGE_URL` | `http://localhost:8790` | Server URL. `?lf=off` = offline (local rules only). |
 * | `?lfkey=pk_...` | `VITE_LIVEFORGE_KEY` | `pk_dev_livecraft` | Publishable SDK key (dev-mode key by default). |
 * | `?lfworld=w` | `VITE_LIVEFORGE_WORLD` | `lc-<seed>` | Liveforge world id (one per Livecraft seed). |
 * | `?lfplayer=p` | | stable random id | Player id. |
 * | `?lfname=Alex` | | `Traveller` | Display name used in prompts and the statue. |
 * | `?lfdash=http://...` | `VITE_LIVEFORGE_DASHBOARD` | `<server>/dashboard` | Dashboard URL (Demo panel). |
 * | `?cassette=replay` | `VITE_LIVEFORGE_CASSETTE` | detected | Cassette mode label (live / record / replay). |
 * | `?nodemo` | | demo on | Demo panel, Brain View open, captions (on by default; `?nodemo` hides them). |
 *
 * Only the publishable key lives in the client; provider keys stay on the Liveforge server.
 */

export interface LiveforgeSettings {
  /** Server base URL, or null when Liveforge is switched off (`?lf=off`): everything runs on local rules. */
  url: string | null;
  key: string;
  world: string;
  player: string;
  playerName: string;
  dashboard: string | null;
  /** Cassette mode label forced by the URL/env, else null (detected from Brain badges). */
  cassette: string | null;
  /** Demo panel + Brain View open + captions (default on; `?nodemo` turns it off). */
  demo: boolean;
}

const PLAYER_KEY = 'lc.lf.player';
const ID_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;

function env(name: string): string | undefined {
  const v = (import.meta.env as Record<string, string | undefined>)[name];
  return v && v.trim() ? v.trim() : undefined;
}

function stablePlayerId(): string {
  try {
    const saved = localStorage.getItem(PLAYER_KEY);
    if (saved && ID_RE.test(saved)) return saved;
    const id = `p_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(PLAYER_KEY, id);
    return id;
  } catch {
    return `p_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** A world id saved by the Demo panel's "Reset memory" (a fresh Liveforge world for this seed). */
function savedWorld(seed: string): string | undefined {
  try {
    return localStorage.getItem(`lc.lf.world.${seed}`) ?? undefined;
  } catch {
    return undefined;
  }
}

const safeId = (v: string | null | undefined, fallback: string) => (v && ID_RE.test(v) ? v : fallback);

/** Reads the settings once (URL params, env, defaults). `seed` names the default world. */
export function readSettings(seed: string, search = typeof location !== 'undefined' ? location.search : ''): LiveforgeSettings {
  const q = new URLSearchParams(search);
  const rawUrl = q.get('lf') ?? env('VITE_LIVEFORGE_URL') ?? 'http://localhost:8790';
  const off = /^(0|off|false|no|none)$/i.test(rawUrl);
  const url = off ? null : rawUrl.replace(/\/+$/, '');
  const valid = url && /^https?:\/\//.test(url) ? url : null;
  const seedId = `lc-${seed.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'world'}`;
  return {
    url: valid,
    key: q.get('lfkey') ?? env('VITE_LIVEFORGE_KEY') ?? 'pk_dev_livecraft',
    world: safeId(q.get('lfworld') ?? env('VITE_LIVEFORGE_WORLD') ?? savedWorld(seed), seedId),
    player: safeId(q.get('lfplayer'), stablePlayerId()),
    playerName: (q.get('lfname') ?? 'Traveller').slice(0, 24),
    dashboard: q.get('lfdash') ?? env('VITE_LIVEFORGE_DASHBOARD') ?? (valid ? `${valid}/dashboard` : null),
    cassette: q.get('cassette') ?? env('VITE_LIVEFORGE_CASSETTE') ?? null,
    demo: !q.has('nodemo'),
  };
}
