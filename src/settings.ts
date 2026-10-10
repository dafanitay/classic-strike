export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  sensitivity: number; // degrees per mouse count * 100 (classic-style 0.5–10)
  invertY: boolean;
  fov: number; // horizontal degrees
  masterVolume: number; // 0..1
  sfxVolume: number; // 0..1
  quality: Quality;
  playerName: string;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 2.5,
  invertY: false,
  fov: 90,
  masterVolume: 0.7,
  sfxVolume: 0.8,
  quality: 'medium',
  playerName: 'Player',
};

const KEY = 'classic-strike.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const s = { ...DEFAULT_SETTINGS, ...parsed };
    // Sanitize anything that might have been hand-edited.
    s.sensitivity = clampNum(s.sensitivity, 0.1, 20, DEFAULT_SETTINGS.sensitivity);
    s.fov = clampNum(s.fov, 70, 120, DEFAULT_SETTINGS.fov);
    s.masterVolume = clampNum(s.masterVolume, 0, 1, DEFAULT_SETTINGS.masterVolume);
    s.sfxVolume = clampNum(s.sfxVolume, 0, 1, DEFAULT_SETTINGS.sfxVolume);
    if (!['low', 'medium', 'high'].includes(s.quality)) s.quality = DEFAULT_SETTINGS.quality;
    s.invertY = !!s.invertY;
    s.playerName = String(s.playerName || 'Player').slice(0, 16);
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode etc.) — settings just won't persist.
  }
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}
