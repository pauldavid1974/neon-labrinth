/**
 * BSP dungeon generation.
 *
 * Approach: recursively split the map rectangle into a tree of leaves
 * (Binary Space Partitioning). Each leaf carves one room; sibling leaves are
 * connected with L-shaped corridors, which guarantees a connected graph of
 * rooms. Afterwards we dress the map: pillars, destructible crates, doors at
 * room thresholds, vents (decorative light anchors), loot and enemy spawns,
 * and the stairs in the room farthest from spawn.
 */
import type { Rng } from "../core/utils";
import { MAP_W, MAP_H, TileT, type DungeonMap, type EnemyKind } from "./types";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoomInfo extends Rect {
  cx: number;
  cy: number;
}

export interface FloorPlan {
  rooms: RoomInfo[];
  enemySpawns: { x: number; y: number; kind: EnemyKind }[];
  lootSpawns: { x: number; y: number }[];
  vents: { x: number; y: number }[];
}

export class DungeonGen implements DungeonMap {
  readonly w = MAP_W;
  readonly h = MAP_H;
  tiles = new Uint8Array(MAP_W * MAP_H);
  seen = new Uint8Array(MAP_W * MAP_H);
  visible = new Uint8Array(MAP_W * MAP_H);
  spawnX = 2;
  spawnY = 2;
  stairsX = 2;
  stairsY = 2;
  fovVersion = 0;
  floorSeed = 1;

  idx(x: number, y: number): number {
    return y * this.w + x;
  }
  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  solid(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return true;
    const t = this.tiles[this.idx(x, y)];
    return t === TileT.Wall || t === TileT.Pillar || t === TileT.Crate;
  }
  walkable(x: number, y: number): boolean {
    return this.inBounds(x, y) && !this.solid(x, y);
  }

  /** Reset per-floor buffers (kept allocated — reused across floors). */
  reset(seed: number): void {
    this.floorSeed = seed;
    this.tiles.fill(TileT.Wall);
    this.seen.fill(0);
    this.visible.fill(0);
    this.fovVersion++;
  }
}

/* ------------------------------------------------------------- generation */

const leaves: Rect[] = [];
const stack: Rect[] = [];

export function generateFloor(map: DungeonGen, plan: FloorPlan, floor: number, rng: Rng): void {
  map.reset((rng.next() * 0xffffffff) >>> 0);
  plan.rooms.length = 0;
  plan.enemySpawns.length = 0;
  plan.lootSpawns.length = 0;
  plan.vents.length = 0;

  // --- BSP split (iterative, using a reusable stack) ---
  leaves.length = 0;
  stack.length = 0;
  stack.push({ x: 1, y: 1, w: map.w - 2, h: map.h - 2 });
  const minLeaf = 8;
  while (stack.length > 0) {
    const r = stack.pop() as Rect;
    const canSplitH = r.w >= minLeaf * 2 + 1;
    const canSplitV = r.h >= minLeaf * 2 - 2;
    const split = (canSplitH || canSplitV) && leaves.length < 26;
    if (!split) {
      leaves.push(r);
      continue;
    }
    const horizontal = canSplitH && (!canSplitV || rng.chance(r.w > r.h ? 0.72 : 0.28));
    if (horizontal) {
      const cut = rng.int(minLeaf, r.w - minLeaf);
      stack.push({ x: r.x, y: r.y, w: cut, h: r.h });
      stack.push({ x: r.x + cut, y: r.y, w: r.w - cut, h: r.h });
    } else {
      const cut = rng.int(Math.max(6, minLeaf - 2), r.h - Math.max(6, minLeaf - 2));
      stack.push({ x: r.x, y: r.y, w: r.w, h: cut });
      stack.push({ x: r.x, y: r.y + cut, w: r.w, h: r.h - cut });
    }
  }

  // --- carve one room per leaf ---
  for (const leaf of leaves) {
    const rw = rng.int(Math.max(4, Math.min(5, leaf.w - 2)), Math.max(5, leaf.w - 2));
    const rh = rng.int(Math.max(4, Math.min(5, leaf.h - 2)), Math.max(5, leaf.h - 2));
    const rx = leaf.x + rng.int(1, Math.max(1, leaf.w - rw - 1));
    const ry = leaf.y + rng.int(1, Math.max(1, leaf.h - rh - 1));
    carveRect(map, rx, ry, rw, rh);
    const room: RoomInfo = {
      x: rx,
      y: ry,
      w: rw,
      h: rh,
      cx: (rx + (rw >> 1)) | 0,
      cy: (ry + (rh >> 1)) | 0,
    };
    plan.rooms.push(room);
  }

  // --- connect consecutive rooms with L corridors (BSP sibling pairing) ---
  for (let i = 1; i < plan.rooms.length; i++) {
    const a = plan.rooms[i - 1];
    const b = plan.rooms[i];
    carveCorridor(map, a.cx, a.cy, b.cx, b.cy, rng);
  }
  // a couple of extra loops so the graph is not a single line
  const extra = 1 + ((plan.rooms.length / 4) | 0);
  for (let i = 0; i < extra && plan.rooms.length > 3; i++) {
    const a = plan.rooms[rng.int(0, plan.rooms.length - 1)];
    const b = plan.rooms[rng.int(0, plan.rooms.length - 1)];
    if (a !== b) carveCorridor(map, a.cx, a.cy, b.cx, b.cy, rng);
  }

  // --- dress rooms: pillars, crates, doors, vents ---
  for (const room of plan.rooms) {
    if (room.w >= 8 && room.h >= 8 && rng.chance(0.75)) {
      // pillar ring inside large rooms
      const px0 = room.x + 2;
      const py0 = room.y + 2;
      const px1 = room.x + room.w - 3;
      const py1 = room.y + room.h - 3;
      setIfFloor(map, px0, py0, TileT.Pillar);
      setIfFloor(map, px1, py0, TileT.Pillar);
      setIfFloor(map, px0, py1, TileT.Pillar);
      setIfFloor(map, px1, py1, TileT.Pillar);
    }
    const crates = rng.int(0, 2 + Math.min(2, floor));
    for (let c = 0; c < crates; c++) {
      const cx = rng.int(room.x, room.x + room.w - 1);
      const cy = rng.int(room.y, room.y + room.h - 1);
      if (map.tiles[map.idx(cx, cy)] === TileT.Floor) map.tiles[map.idx(cx, cy)] = TileT.Crate;
    }
    if (room.w >= 6 && rng.chance(0.5)) {
      plan.vents.push({ x: room.cx, y: room.cy });
    }
  }

  // --- spawn & stairs: farthest pair of rooms ---
  const spawnRoom = plan.rooms[rng.int(0, Math.min(2, plan.rooms.length - 1))];
  let best = spawnRoom;
  let bestD = -1;
  for (const r of plan.rooms) {
    const d = Math.abs(r.cx - spawnRoom.cx) + Math.abs(r.cy - spawnRoom.cy);
    if (d > bestD) {
      bestD = d;
      best = r;
    }
  }
  map.spawnX = spawnRoom.cx;
  map.spawnY = spawnRoom.cy;
  map.stairsX = best.cx;
  map.stairsY = best.cy;
  clearSpot(map, map.stairsX, map.stairsY);
  map.tiles[map.idx(map.stairsX, map.stairsY)] = TileT.Stairs;
  clearSpot(map, map.spawnX, map.spawnY);

  // --- enemy & loot placement (budget scales with depth) ---
  const budget = Math.min(22, 5 + floor * 2);
  let spent = 0;
  for (let i = 0; i < plan.rooms.length && spent < budget; i++) {
    const room = plan.rooms[i];
    if (room === spawnRoom) continue;
    const distFromSpawn = Math.abs(room.cx - map.spawnX) + Math.abs(room.cy - map.spawnY);
    const count = rng.int(1, Math.min(3, 1 + (floor >> 1)));
    for (let c = 0; c < count && spent < budget; c++) {
      const spot = randomFloorTile(map, room, rng);
      if (!spot) continue;
      plan.enemySpawns.push({ x: spot.x, y: spot.y, kind: pickEnemyKind(floor, distFromSpawn, rng) });
      spent++;
    }
    if (rng.chance(0.55) || i === plan.rooms.length - 1) {
      const spot = randomFloorTile(map, room, rng);
      if (spot) plan.lootSpawns.push(spot);
    }
  }
  // guarantee at least one heal per floor
  if (plan.lootSpawns.length > 0) {
    const s = plan.lootSpawns[rng.int(0, plan.lootSpawns.length - 1)];
    plan.lootSpawns[plan.lootSpawns.length - 1] = { x: s.x, y: s.y };
  }
}

function pickEnemyKind(floor: number, dist: number, rng: Rng): EnemyKind {
  const roll = rng.next();
  if (floor >= 3 && roll < 0.18 + floor * 0.02) return "goliath";
  if (floor >= 2 && roll < 0.5) return "sentinel";
  if (floor < 2 && dist < 12) return "stalker";
  return roll < 0.62 ? "stalker" : "sentinel";
}

function randomFloorTile(map: DungeonGen, room: RoomInfo, rng: Rng): { x: number; y: number } | null {
  for (let tries = 0; tries < 12; tries++) {
    const x = rng.int(room.x, room.x + room.w - 1);
    const y = rng.int(room.y, room.y + room.h - 1);
    if (map.tiles[map.idx(x, y)] === TileT.Floor) return { x, y };
  }
  return null;
}

function clearSpot(map: DungeonGen, x: number, y: number): void {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const t = map.idx(x + dx, y + dy);
      if (map.inBounds(x + dx, y + dy) && map.tiles[t] !== TileT.Wall && map.tiles[t] !== TileT.Stairs) {
        map.tiles[t] = TileT.Floor;
      }
    }
  }
}

function setIfFloor(map: DungeonGen, x: number, y: number, t: TileT): void {
  if (map.inBounds(x, y) && map.tiles[map.idx(x, y)] === TileT.Floor) map.tiles[map.idx(x, y)] = t;
}

function carveRect(map: DungeonGen, x: number, y: number, w: number, h: number): void {
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      if (map.inBounds(i, j)) map.tiles[map.idx(i, j)] = TileT.Floor;
    }
  }
}

function carveCorridor(map: DungeonGen, x0: number, y0: number, x1: number, y1: number, rng: Rng): void {
  let x = x0;
  let y = y0;
  // L-shape: horizontal-first or vertical-first, chosen per corridor
  const hFirst = rng.chance(0.5);
  const step = (cx: number, cy: number): void => {
    if (!map.inBounds(cx, cy)) return;
    const i = map.idx(cx, cy);
    if (map.tiles[i] === TileT.Wall) map.tiles[i] = TileT.Floor;
  };
  if (hFirst) {
    while (x !== x1) {
      step(x, y);
      x += x < x1 ? 1 : -1;
    }
    while (y !== y1) {
      step(x, y);
      y += y < y1 ? 1 : -1;
    }
  } else {
    while (y !== y1) {
      step(x, y);
      y += y < y1 ? 1 : -1;
    }
    while (x !== x1) {
      step(x, y);
      x += x < x1 ? 1 : -1;
    }
  }
  step(x1, y1);
}
