/** User settings persisted in localStorage (shared across seeds). */

export interface Settings {
  /** Chunks, 2..10. */
  renderDistance: number;
  /** Vertical field of view in degrees. */
  fov: number;
  /** Mouse sensitivity multiplier. */
  sensitivity: number;
  /** Camera bob while walking. */
  viewBob: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  renderDistance: 6,
  fov: 75,
  sensitivity: 1,
  viewBob: true,
};

const KEY = 'livecraft.settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // ignore (private mode, bad JSON)
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}
