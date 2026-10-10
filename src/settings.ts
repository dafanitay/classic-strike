export type Quality = 'low' | 'medium' | 'high';

export const CROSSHAIR_COLORS = {
  green: '#50fa50',
  yellow: '#ffe14d',
  cyan: '#4df2ff',
  white: '#ffffff',
  magenta: '#ff5cf0',
} as const;
export type CrosshairColor = keyof typeof CROSSHAIR_COLORS;

export interface CrosshairSettings {
  size: number; // line length, px
  gap: number; // centre gap, px
  thickness: number; // px
  color: CrosshairColor;
  /** Lines move apart with weapon inaccuracy (movement, jumping, bloom). */
  dynamic: boolean;
  dot: boolean;
  outline: boolean;
}

export const DEFAULT_CROSSHAIR: CrosshairSettings = {
  size: 8,
  gap: 3,
  thickness: 2,
  color: 'green',
  dynamic: true,
  dot: false,
  outline: true,
};

export interface Settings {
  sensitivity: number; // degrees per mouse count * 100 (classic-style 0.5–10)
  invertY: boolean;
  fov: number; // horizontal degrees
  masterVolume: number; // 0..1
  sfxVolume: number; // 0..1
  quality: Quality;
  playerName: string;
  crosshair: CrosshairSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 2.5,
  invertY: false,
  fov: 90,
  masterVolume: 0.7,
  sfxVolume: 0.8,
  quality: 'medium',
  playerName: 'Player',
  crosshair: { ...DEFAULT_CROSSHAIR },
};

const KEY = 'classic-strike.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, crosshair: { ...DEFAULT_CROSSHAIR } };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const s = { ...DEFAULT_SETTINGS, ...parsed };
    s.crosshair = sanitizeCrosshair(parsed.crosshair);
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
    return { ...DEFAULT_SETTINGS, crosshair: { ...DEFAULT_CROSSHAIR } };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode etc.) — settings just won't persist.
  }
}

export function sanitizeCrosshair(v: unknown): CrosshairSettings {
  const c = (v && typeof v === 'object' ? v : {}) as Partial<CrosshairSettings>;
  const d = DEFAULT_CROSSHAIR;
  return {
    size: Math.round(clampNum(c.size, 0, 30, d.size)),
    gap: Math.round(clampNum(c.gap, 0, 20, d.gap)),
    thickness: Math.round(clampNum(c.thickness, 1, 6, d.thickness)),
    color: typeof c.color === 'string' && c.color in CROSSHAIR_COLORS ? (c.color as CrosshairColor) : d.color,
    dynamic: typeof c.dynamic === 'boolean' ? c.dynamic : d.dynamic,
    dot: typeof c.dot === 'boolean' ? c.dot : d.dot,
    outline: typeof c.outline === 'boolean' ? c.outline : d.outline,
  };
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}
