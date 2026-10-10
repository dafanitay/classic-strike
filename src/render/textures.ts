import * as THREE from 'three';
import { makeRng } from '../shared/vec';

/**
 * All surface textures are generated procedurally on a canvas at startup:
 * no image assets to license, nothing to download, and the gritty low-res
 * look suits the early-2000s style. Each texture represents `worldSize`
 * metres so UVs can be computed straight from world coordinates.
 */

export interface SurfaceTex {
  map: THREE.Texture;
  worldSize: number;
}

type Painter = (g: CanvasRenderingContext2D, s: number, rnd: () => number) => void;

function noise(g: CanvasRenderingContext2D, s: number, rnd: () => number, amount: number, count = s * s * 0.6): void {
  for (let i = 0; i < count; i++) {
    const v = (rnd() - 0.5) * amount;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    g.fillRect(Math.floor(rnd() * s), Math.floor(rnd() * s), 1 + Math.floor(rnd() * 2), 1 + Math.floor(rnd() * 2));
  }
}

function stains(g: CanvasRenderingContext2D, s: number, rnd: () => number, n: number, color: string, alpha: number): void {
  for (let i = 0; i < n; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    const r = s * (0.05 + rnd() * 0.18);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color.replace('A', String(alpha * (0.4 + rnd() * 0.6))));
    grad.addColorStop(1, color.replace('A', '0'));
    g.fillStyle = grad;
    // Draw wrapped so the texture still tiles.
    for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
      g.save();
      g.translate(ox, oy);
      g.fillRect(x - r, y - r, r * 2, r * 2);
      g.restore();
    }
  }
}

const painters: Record<string, { size: number; world: number; paint: Painter }> = {
  sand: {
    size: 256, world: 4,
    paint: (g, s, r) => {
      g.fillStyle = '#b89a6a';
      g.fillRect(0, 0, s, s);
      stains(g, s, r, 10, 'rgba(120,90,50,A)', 0.25);
      stains(g, s, r, 8, 'rgba(230,210,170,A)', 0.2);
      // Wind ripples (wrapping sine bands so the texture still tiles).
      for (let y = 0; y < s; y += 2) {
        const v = Math.sin((y / s) * Math.PI * 2 * 9 + Math.sin((y / s) * Math.PI * 2 * 2) * 1.5);
        g.fillStyle = v > 0 ? `rgba(240,220,180,${v * 0.06})` : `rgba(100,75,40,${-v * 0.07})`;
        g.fillRect(0, y, s, 2);
      }
      noise(g, s, r, 0.22);
    },
  },
  dirt: {
    size: 256, world: 4,
    paint: (g, s, r) => {
      g.fillStyle = '#8a7356';
      g.fillRect(0, 0, s, s);
      stains(g, s, r, 14, 'rgba(70,52,34,A)', 0.35);
      noise(g, s, r, 0.28);
      for (let i = 0; i < 60; i++) {
        g.fillStyle = `rgba(60,48,36,${0.3 + r() * 0.4})`;
        g.beginPath();
        g.arc(r() * s, r() * s, 1 + r() * 3, 0, Math.PI * 2);
        g.fill();
      }
    },
  },
  concrete: {
    size: 256, world: 4,
    paint: (g, s, r) => {
      g.fillStyle = '#8d8a82';
      g.fillRect(0, 0, s, s);
      stains(g, s, r, 12, 'rgba(60,58,52,A)', 0.25);
      noise(g, s, r, 0.18);
      // Aggregate speckle.
      for (let i = 0; i < 260; i++) {
        g.fillStyle = r() < 0.5 ? 'rgba(170,166,156,0.5)' : 'rgba(60,58,54,0.5)';
        g.fillRect(r() * s, r() * s, 1, 1);
      }
      g.strokeStyle = 'rgba(40,40,36,0.55)';
      g.lineWidth = 2;
      g.strokeRect(1, 1, s - 2, s - 2);
      g.beginPath();
      g.moveTo(s / 2, 0);
      g.lineTo(s / 2, s);
      g.stroke();
    },
  },
  tile: {
    size: 256, world: 2,
    paint: (g, s, r) => {
      const n = 4;
      const t = s / n;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const base = (x + y) % 2 ? [176, 160, 132] : [158, 136, 106];
        const k = 0.9 + r() * 0.2;
        g.fillStyle = `rgb(${base[0] * k},${base[1] * k},${base[2] * k})`;
        g.fillRect(x * t, y * t, t, t);
      }
      noise(g, s, r, 0.15);
      // Chipped edges on a few tiles.
      for (let i = 0; i < 6; i++) {
        g.fillStyle = 'rgba(80,64,44,0.45)';
        g.fillRect(Math.floor(r() * n) * t + (r() < 0.5 ? 3 : t - 9), Math.floor(r() * n) * t + r() * (t - 8), 6, 5);
      }
      g.strokeStyle = 'rgba(42,34,24,0.8)';
      g.lineWidth = 4;
      for (let i = 0; i <= n; i++) {
        g.beginPath();
        g.moveTo(i * t, 0);
        g.lineTo(i * t, s);
        g.moveTo(0, i * t);
        g.lineTo(s, i * t);
        g.stroke();
      }
      stains(g, s, r, 6, 'rgba(70,55,35,A)', 0.25);
    },
  },
  wall: {
    // Sandstone blocks.
    size: 256, world: 4,
    paint: (g, s, r) => {
      // Mortar first, then blocks inset from it.
      g.fillStyle = '#7d6648';
      g.fillRect(0, 0, s, s);
      const rows = 8;
      const h = s / rows;
      const bw = s / 4;
      for (let y = 0; y < rows; y++) {
        const off = y % 2 ? s / 8 : 0;
        for (let x = -1; x < 4; x++) {
          const k = 0.85 + r() * 0.25;
          const x0 = x * bw + off + 2;
          const y0 = y * h + 2;
          g.fillStyle = `rgb(${194 * k},${164 * k},${119 * k})`;
          g.fillRect(x0, y0, bw - 4, h - 4);
          // Bevel: sunlit top edge, shaded bottom edge (the canvas is
          // flipped on upload, so its top row is the top of the wall).
          g.fillStyle = 'rgba(255,240,210,0.22)';
          g.fillRect(x0, y0, bw - 4, 2);
          g.fillStyle = 'rgba(40,28,15,0.3)';
          g.fillRect(x0, y0 + h - 7, bw - 4, 3);
          // Weathered corners.
          if (r() < 0.35) {
            g.fillStyle = 'rgba(70,52,32,0.35)';
            g.fillRect(x0 + (r() < 0.5 ? 0 : bw - 12), y0 + r() * (h - 10), 8, 6);
          }
        }
      }
      noise(g, s, r, 0.2);
      // A few hairline cracks.
      for (let i = 0; i < 5; i++) {
        g.strokeStyle = `rgba(60,44,28,${0.25 + r() * 0.25})`;
        g.lineWidth = 1;
        g.beginPath();
        let x = r() * s;
        let y = r() * s;
        g.moveTo(x, y);
        for (let k = 0; k < 4; k++) {
          x += (r() - 0.5) * 18;
          y += r() * 12;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      stains(g, s, r, 8, 'rgba(90,70,45,A)', 0.3);
      // Grime toward the bottom (texture v=0 is the floor line).
      const grad = g.createLinearGradient(0, s, 0, s * 0.55);
      grad.addColorStop(0, 'rgba(60,45,30,0.45)');
      grad.addColorStop(1, 'rgba(60,45,30,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    },
  },
  plaster: {
    size: 256, world: 4,
    paint: (g, s, r) => {
      g.fillStyle = '#9c9488';
      g.fillRect(0, 0, s, s);
      stains(g, s, r, 16, 'rgba(70,64,56,A)', 0.3);
      noise(g, s, r, 0.16);
      for (let i = 0; i < 6; i++) {
        g.strokeStyle = `rgba(50,45,40,${0.2 + r() * 0.3})`;
        g.lineWidth = 1;
        g.beginPath();
        let x = r() * s;
        let y = r() * s;
        g.moveTo(x, y);
        for (let k = 0; k < 6; k++) {
          x += (r() - 0.5) * 30;
          y += (r() - 0.5) * 30;
          g.lineTo(x, y);
        }
        g.stroke();
      }
    },
  },
  crate: {
    size: 128, world: 1.6,
    paint: (g, s, r) => {
      g.fillStyle = '#8a6532';
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 6; i++) {
        g.fillStyle = `rgba(${90 + r() * 40},${60 + r() * 20},${25},0.35)`;
        g.fillRect(0, (i * s) / 6, s, s / 6 - 2);
      }
      noise(g, s, r, 0.2);
      g.strokeStyle = '#4a3418';
      g.lineWidth = 10;
      g.strokeRect(5, 5, s - 10, s - 10);
      g.lineWidth = 8;
      g.beginPath();
      g.moveTo(8, 8);
      g.lineTo(s - 8, s - 8);
      g.stroke();
    },
  },
  roof: {
    size: 128, world: 3,
    paint: (g, s, r) => {
      g.fillStyle = '#4b4a46';
      g.fillRect(0, 0, s, s);
      noise(g, s, r, 0.2);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      for (let i = 0; i < 4; i++) g.fillRect((i * s) / 4, 0, 3, s);
    },
  },
};

const cache = new Map<string, SurfaceTex>();

export function surface(name: keyof typeof painters, anisotropy = 4): SurfaceTex {
  const key = `${name}:${anisotropy}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = painters[name];
  const c = document.createElement('canvas');
  c.width = c.height = p.size;
  const g = c.getContext('2d')!;
  p.paint(g, p.size, makeRng(name.length * 977 + name.charCodeAt(0)));
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const out = { map: tex, worldSize: p.world };
  cache.set(key, out);
  return out;
}

/** Large painted letter for bombsite floors / wall signs. */
export function labelTexture(text: string, color = '#d33b2c', bg = 'rgba(0,0,0,0)', size = 256): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);
  g.fillStyle = color;
  g.font = `bold ${Math.floor(size * (text.length > 2 ? 0.28 : 0.7))}px Impact, "Arial Black", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.globalAlpha = 0.85;
  g.fillText(text, size / 2, size / 2 + size * 0.04);
  // Weathering.
  g.globalCompositeOperation = 'destination-out';
  const r = makeRng(text.charCodeAt(0));
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(0,0,0,${r() * 0.6})`;
    g.fillRect(r() * size, r() * size, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
