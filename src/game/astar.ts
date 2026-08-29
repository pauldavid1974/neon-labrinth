/**
 * A* pathfinding on the tile grid — 4-directional.
 *
 * Math: f(n) = g(n) + h(n) with Manhattan distance heuristic (admissible for
 * a 4-neighbour grid). A binary min-heap keyed on f drives the open set.
 * Occupied cells (other enemies) are blocked so mobs don't stack, but the
 * goal cell is always enterable (it is usually the player's tile).
 *
 * All scratch buffers are module-level singletons — reused on every call,
 * zero allocation in the hot path. The resulting path (goal→start) is
 * reversed in place into the caller-provided Int16Array as [x0,y0,x1,y1...],
 * excluding the start cell. Returns step count, or 0 if no path.
 */
import type { SpatialHash } from "../core/utils";
import { MAP_W, MAP_H, type DungeonMap } from "./types";

const N = MAP_W * MAP_H;
const gScore = new Float32Array(N);
const fScore = new Float32Array(N);
const from = new Int32Array(N);
const closed = new Uint8Array(N);
const heap = new Int32Array(N);
let heapLen = 0;

function heapPush(cell: number): void {
  if (heapLen >= N) return; // safety valve: degrade gracefully instead of overflowing
  let i = heapLen++;
  heap[i] = cell;
  const f = fScore[cell];
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (fScore[heap[p]] <= f) break;
    heap[i] = heap[p];
    i = p;
  }
  heap[i] = cell;
}

function heapPop(): number {
  const top = heap[0];
  const last = heap[--heapLen];
  if (heapLen > 0) {
    let i = 0;
    const f = fScore[last];
    for (;;) {
      let s = i;
      const l = i * 2 + 1;
      const r = l + 1;
      if (l < heapLen && fScore[heap[l]] < f) s = l;
      if (r < heapLen && fScore[heap[r]] < (s === i ? f : fScore[heap[s]])) s = r;
      if (s === i) break;
      heap[i] = heap[s];
      i = s;
    }
    heap[i] = last;
  }
  return top;
}

const DX4 = [1, -1, 0, 0];
const DY4 = [0, 0, 1, -1];

export function findPath(
  map: DungeonMap,
  occupancy: SpatialHash,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  maxExpand: number,
  out: Int16Array,
): number {
  const { w, h, tiles } = map;
  if (sx === tx && sy === ty) return 0;
  gScore.fill(Infinity, 0, w * h);
  closed.fill(0, 0, w * h);
  heapLen = 0;

  const start = sy * w + sx;
  const goal = ty * w + tx;
  gScore[start] = 0;
  fScore[start] = Math.abs(tx - sx) + Math.abs(ty - sy);
  from[start] = -1;
  heapPush(start);

  let found = false;
  let expanded = 0;

  while (heapLen > 0 && expanded < maxExpand) {
    const cur = heapPop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    if (cur === goal) {
      found = true;
      break;
    }
    const cx = cur % w;
    const cy = (cur / w) | 0;
    const g = gScore[cur];
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX4[d];
      const ny = cy + DY4[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (closed[ni]) continue;
      const tile = tiles[ni];
      if (tile === 1 || tile === 4 || tile === 5) continue; // wall/pillar/crate
      if (ni !== goal && occupancy.get(nx, ny) >= 0) continue; // occupied by an entity
      const ng = g + 1;
      if (ng < gScore[ni]) {
        gScore[ni] = ng;
        fScore[ni] = ng + Math.abs(tx - nx) + Math.abs(ty - ny);
        from[ni] = cur;
        heapPush(ni);
      }
    }
  }

  if (!found) return 0;

  // trace back goal→start, then reverse into `out` as x,y pairs (skip start)
  let len = 0;
  let cur = goal;
  while (cur !== start && cur >= 0) {
    out[len * 2] = cur % w;
    out[len * 2 + 1] = (cur / w) | 0;
    len++;
    cur = from[cur];
  }
  // reverse in place
  for (let i = 0, j = len - 1; i < j; i++, j--) {
    const ax = out[i * 2];
    const ay = out[i * 2 + 1];
    out[i * 2] = out[j * 2];
    out[i * 2 + 1] = out[j * 2 + 1];
    out[j * 2] = ax;
    out[j * 2 + 1] = ay;
  }
  return len;
}
