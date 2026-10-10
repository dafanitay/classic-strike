import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CROSSHAIR, DEFAULT_SETTINGS, loadSettings, sanitizeCrosshair } from '../settings';
import { crosshairLayout, spreadToPixels } from './crosshair';

describe('crosshair layout', () => {
  it('places four lines symmetrically around the centre with the configured gap', () => {
    const l = crosshairLayout({ ...DEFAULT_CROSSHAIR, size: 10, gap: 4, thickness: 2, dynamic: false });
    const [top, bottom, left, right] = l.lines;
    expect(top).toEqual({ x: -1, y: -14, w: 2, h: 10 });
    expect(bottom).toEqual({ x: -1, y: 4, w: 2, h: 10 });
    expect(left).toEqual({ x: -14, y: -1, w: 10, h: 2 });
    expect(right).toEqual({ x: 4, y: -1, w: 10, h: 2 });
    expect(l.dot).toBeNull();
  });

  it('only a dynamic crosshair opens with inaccuracy', () => {
    const dyn = crosshairLayout({ ...DEFAULT_CROSSHAIR, gap: 3, dynamic: true }, 20);
    const stat = crosshairLayout({ ...DEFAULT_CROSSHAIR, gap: 3, dynamic: false }, 20);
    expect(dyn.lines[3].x).toBe(23);
    expect(stat.lines[3].x).toBe(3);
  });

  it('supports dot-only crosshairs', () => {
    const l = crosshairLayout({ ...DEFAULT_CROSSHAIR, size: 0, dot: true, thickness: 4 });
    expect(l.lines).toHaveLength(0);
    expect(l.dot).toEqual({ x: -2, y: -2, w: 4, h: 4 });
  });

  it('converts weapon spread to pixels consistently with the camera', () => {
    // 1° at a 74° vertical FOV on a 1080 px tall screen ≈ 12.4 px.
    expect(spreadToPixels(Math.PI / 180, (74 * Math.PI) / 180, 1080)).toBeCloseTo(12.5, 0);
    expect(spreadToPixels(0, 1, 1080)).toBe(0);
  });
});

describe('crosshair settings persistence', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects out-of-range or malformed values instead of resetting everything', () => {
    const c = sanitizeCrosshair({ size: 999, gap: -5, thickness: 'x', color: 'chartreuse', dynamic: 'yes', dot: true });
    expect(c.size).toBe(30);
    expect(c.gap).toBe(0);
    expect(c.thickness).toBe(DEFAULT_CROSSHAIR.thickness);
    expect(c.color).toBe(DEFAULT_CROSSHAIR.color);
    expect(c.dynamic).toBe(DEFAULT_CROSSHAIR.dynamic);
    expect(c.dot).toBe(true);
  });

  it('loads saved crosshair settings and keeps other saved settings', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    store.set('classic-strike.settings.v1', JSON.stringify({ sensitivity: 1.7, crosshair: { size: 12, color: 'cyan', dot: true } }));
    const s = loadSettings();
    expect(s.sensitivity).toBe(1.7);
    expect(s.crosshair).toEqual({ ...DEFAULT_CROSSHAIR, size: 12, color: 'cyan', dot: true });
  });

  it('settings saved before crosshair options existed still load with defaults', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: () => {} });
    store.set('classic-strike.settings.v1', JSON.stringify({ sensitivity: 3, quality: 'high' }));
    const s = loadSettings();
    expect(s.quality).toBe('high');
    expect(s.crosshair).toEqual(DEFAULT_CROSSHAIR);
  });

  it('defaults are never shared (editing a loaded copy cannot change the defaults)', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    const s = loadSettings();
    s.crosshair.size = 25;
    expect(DEFAULT_SETTINGS.crosshair.size).toBe(DEFAULT_CROSSHAIR.size);
    expect(loadSettings().crosshair.size).toBe(DEFAULT_CROSSHAIR.size);
  });
});
