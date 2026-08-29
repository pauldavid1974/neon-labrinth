/**
 * Field-of-view & light occlusion via radial DDA raycasts.
 *
 * Math: for each of N rays around a circle we run an Amanatides–Woo DDA:
 * the ray direction (dx,dy) gives per-axis step signs and `tMax` distances
 * to the next vertical/horizontal grid line; we hop cell-to-cell along
 * whichever axis boundary is nearer until we hit a solid tile or exceed the
 * radius. The hit point (clamped to the wall face) becomes one vertex of the
 * visibility/light polygon. A fixed per-ray angular jitter (hash-based, not
 * per-frame random) breaks up moiré without shimmering.
 *
 * All buffers are module-level and reused — zero allocations per cast.
 */
import { TAU as TAU_SAFE } from "../core/utils";
import { FOV_RAYS, LIGHT_RAYS, type DungeonMap } from "./types";

const MAX_RAYS = 128;
const jitter = new Float32Array(MAX_RAYS);
for (let i = 0; i < MAX_RAYS; i++) {
  // deterministic pseudo-jitter in [-0.35, 0.35] of a ray step
  const h = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  jitter[i] = ((h - Math.floor(h)) - 0.5) * 0.7;
}

/**
 * Compute player FoV: fills `visible` grid (0/1) and writes the boundary
 * polygon (tile units) into `polyOut`. Returns polygon vertex count.
 */
export function computeFov(
  map: DungeonMap,
  cx: number,
  cy: number,
  radius: number,
  polyOut: Float32Array,
): number {
  map.visible.fill(0, 0, map.w * map.h);
  castPoly(map, cx + 0.5, cy + 0.5, radius, FOV_RAYS, polyOut, true);
  return FOV_RAYS;
}

export type PolyOut = Float32Array | number[];

/** Occlusion polygon for a dynamic light at fractional tile position (cx,cy). */
export function castLightPoly(
  map: DungeonMap,
  cx: number,
  cy: number,
  radius: number,
  polyOut: PolyOut,
): number {
  return castPoly(map, cx, cy, radius, LIGHT_RAYS, polyOut, false);
}

function castPoly(
  map: DungeonMap,
  ox: number,
  oy: number,
  radius: number,
  rays: number,
  out: PolyOut,
  markVisible: boolean,
): number {
  const { w, h, tiles, visible } = map;
  const r2 = radius * radius;
  for (let i = 0; i < rays; i++) {
    const ang = ((i + jitter[i]) / rays) * TAU_SAFE;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);

    let x = Math.floor(ox);
    let y = Math.floor(oy);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    // distance along ray to next vertical / horizontal cell boundary
    const tDeltaX = Math.abs(1 / (dx || 1e-9));
    const tDeltaY = Math.abs(1 / (dy || 1e-9));
    let tMaxX = tDeltaX * (dx > 0 ? x + 1 - ox : ox - x);
    let tMaxY = tDeltaY * (dy > 0 ? y + 1 - oy : oy - y);

    let hitX = ox + dx * radius;
    let hitY = oy + dy * radius;
    let t = 0;

    for (let guard = 0; guard < 96; guard++) {
      if (x < 0 || y < 0 || x >= w || y >= h) {
        t = radius;
        break;
      }
      const ti = y * w + x;
      if (markVisible) {
        const ddx = x + 0.5 - ox;
        const ddy = y + 0.5 - oy;
        if (ddx * ddx + ddy * ddy <= r2) visible[ti] = 1;
      }
      const tile = tiles[ti];
      if (tile === 1 || tile === 4 || tile === 5) {
        // solid wall/pillar/crate — stop just before the face
        t = Math.max(0, Math.min(tMaxX, tMaxY) - 0.001);
        hitX = ox + dx * t;
        hitY = oy + dy * t;
        break;
      }
      // advance to next cell boundary
      if (tMaxX < tMaxY) {
        t = tMaxX;
        tMaxX += tDeltaX;
        x += stepX;
      } else {
        t = tMaxY;
        tMaxY += tDeltaY;
        y += stepY;
      }
      if (t >= radius) break;
    }
    if (t < radius && t > 0) {
      hitX = ox + dx * t;
      hitY = oy + dy * t;
    }
    out[i * 2] = hitX;
    out[i * 2 + 1] = hitY;
  }
  return rays;
}

/** True if a straight line between two tile centers is unobstructed. */
export function hasLoS(map: DungeonMap, x0: number, y0: number, x1: number, y1: number): boolean {
  const ox = x0 + 0.5;
  const oy = y0 + 0.5;
  const tx = x1 + 0.5;
  const ty = y1 + 0.5;
  let dx = tx - ox;
  let dy = ty - oy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-6) return true;
  dx /= dist;
  dy /= dist;

  let x = Math.floor(ox);
  let y = Math.floor(oy);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = Math.abs(1 / (dx || 1e-9));
  const tDeltaY = Math.abs(1 / (dy || 1e-9));
  let tMaxX = tDeltaX * (dx > 0 ? x + 1 - ox : ox - x);
  let tMaxY = tDeltaY * (dy > 0 ? y + 1 - oy : oy - y);

  const { w, h, tiles } = map;
  for (let guard = 0; guard < 128; guard++) {
    if (x === x1 && y === y1) return true;
    if (!map.inBounds(x, y)) return false;
    const ti = y * w + x;
    const tile = tiles[ti];
    if (!(x === x0 && y === y0) && (tile === 1 || tile === 4 || tile === 5)) return false;
    if (tMaxX < tMaxY) {
      tMaxX += tDeltaX;
      x += stepX;
    } else {
      tMaxY += tDeltaY;
      y += stepY;
    }
  }
  return false;
}

/** Raycast from origin toward a target point; returns distance to first solid. */
export function rayToWall(map: DungeonMap, ox: number, oy: number, tx: number, ty: number, maxDist: number): number {
  let dx = tx - ox;
  let dy = ty - oy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-6) return 0;
  dx /= dist;
  dy /= dist;
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = Math.abs(1 / (dx || 1e-9));
  const tDeltaY = Math.abs(1 / (dy || 1e-9));
  let tMaxX = tDeltaX * (dx > 0 ? x + 1 - ox : ox - x);
  let tMaxY = tDeltaY * (dy > 0 ? y + 1 - oy : oy - y);
  const { w, h, tiles } = map;
  let t = 0;
  for (let guard = 0; guard < 160; guard++) {
    if (t > maxDist) return maxDist;
    if (!map.inBounds(x, y)) return t;
    const tile = tiles[y * w + x];
    if (tile === 1 || tile === 4 || tile === 5) return t;
    if (tMaxX < tMaxY) {
      t = tMaxX;
      tMaxX += tDeltaX;
      x += stepX;
    } else {
      t = tMaxY;
      tMaxY += tDeltaY;
      y += stepY;
    }
  }
  return Math.min(t, maxDist);
}
