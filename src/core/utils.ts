/**
 * Core utilities: seeded RNG, math helpers, spatial hashing, logger.
 * Everything here is allocation-free in the hot path.
 */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential decay (used for camera smoothing, shake). */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

/** Deterministic per-tile hash in [0,1) — used for texture variety without RNG calls. */
export function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Mulberry32 — tiny fast seedable PRNG. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/**
 * SpatialHash — O(1) "which entity occupies this cell" queries.
 * Backed by a flat Int32Array grid (no buckets, no allocations);
 * this is what keeps collision/occupancy lookups out of O(N^2) territory.
 */
export class SpatialHash {
  readonly w: number;
  readonly h: number;
  private cells: Int32Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cells = new Int32Array(w * h).fill(-1);
  }

  clear(): void {
    this.cells.fill(-1);
  }

  private key(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  set(x: number, y: number, entity: number): void {
    if (this.inBounds(x, y)) this.cells[this.key(x, y)] = entity;
  }

  get(x: number, y: number): number {
    if (!this.inBounds(x, y)) return -2; // out-of-bounds sentinel
    return this.cells[this.key(x, y)];
  }

  remove(x: number, y: number, entity: number): void {
    if (this.inBounds(x, y)) {
      const k = this.key(x, y);
      if (this.cells[k] === entity) this.cells[k] = -1;
    }
  }

  move(entity: number, fx: number, fy: number, tx: number, ty: number): void {
    this.remove(fx, fy, entity);
    this.set(tx, ty, entity);
  }
}

/** Toggleable logger — silenced in production builds. */
export const Logger = {
  enabled: false,
  info(...args: unknown[]): void {
    if (this.enabled) console.info("[neon]", ...args);
  },
  warn(...args: unknown[]): void {
    console.warn("[neon]", ...args);
  },
  error(...args: unknown[]): void {
    console.error("[neon]", ...args);
  },
};
