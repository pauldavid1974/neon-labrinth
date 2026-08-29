/**
 * Shared data contracts: config constants, component shapes, and the
 * GameCtx interface that systems receive. Systems and renderer both depend
 * on this file only — never on each other's concrete classes.
 */
import type { Container } from "pixi.js";
import type { World } from "../core/ecs";
import type { SpatialHash } from "../core/utils";

/* ------------------------------------------------------------------ config */

export const TILE = 32; // px per tile
export const MAP_W = 46;
export const MAP_H = 32;
export const FOV_RAYS = 96; // rays for player field-of-view polygon
export const LIGHT_RAYS = 56; // rays per dynamic light occlusion polygon
export const FOV_RADIUS = 8.6;

export enum TileT {
  Floor = 0,
  Wall = 1,
  Door = 2,
  Stairs = 3,
  Pillar = 4,
  Crate = 5,
}

export type GState = "title" | "playing" | "paused" | "transition" | "dying" | "dead";

export type EnemyKind = "stalker" | "sentinel" | "goliath";

export interface WeaponStats {
  name: string;
  bolt: number; // ranged damage
  melee: number; // bump-attack damage
  cost: number; // energy per shot
  color: number;
}

export interface PlayerStats {
  hp: number;
  maxHp: number;
  en: number;
  maxEn: number;
  armor: number;
  enRegen: number;
  lifesteal: number;
  kills: number;
  score: number;
  weapon: WeaponStats;
  pierce: boolean;
  onStairs: boolean;
  dashCd: number; // real-time seconds remaining
  fireCd: number;
  invuln: number; // real-time invulnerability after dash
  lastDx: number;
  lastDy: number;
}

/* ------------------------------------------------------------- components */

export interface GridPos {
  x: number;
  y: number;
}

/** Render-side interpolation state. (fx,fy) = where the tween started. */
export interface Anim {
  rx: number;
  ry: number;
  fx: number;
  fy: number;
  t: number; // 0..1 progress
  delay: number; // stagger before tween starts (enemy turns)
  speed: number; // tween speed in 1/seconds
  punch: number; // scale punch on hit, decays
}

export interface Health {
  hp: number;
  max: number;
}

export interface AIComp {
  kind: EnemyKind;
  path: Int16Array; // A* output buffer (preallocated, reused)
  pathLen: number;
  pathIdx: number;
  cd: number; // ability cooldown in turns
  aggro: boolean;
  moveTick: number; // goliath moves every 2nd turn
  hurtT: number;
}

export interface LightComp {
  r: number;
  color: number;
  base: number; // base alpha/intensity
  phase: number; // flicker phase offset
  poly: number[]; // reused occlusion polygon buffer (LIGHT_RAYS*2)
}

export interface VisualComp {
  root: Container;
  body: Container; // tintable main shape (Graphics is a Container)
  bar: Container | null; // enemy hp bar
  barHp: number; // last hp the bar was drawn with
  tint: number; // base tint
  flash: number; // 0..1 white flash
  bobPhase: number;
  bobAmp: number;
  ring: Container | null; // rotating ring (player)
}

export interface LootComp {
  kind: "weapon" | "heal" | "energy" | "relic";
  tier: number;
  name: string;
}

export interface Marker {
  tag: string; // "player" | "enemy" | "loot" | "vent"
}

/* ----------------------------------------------------------------- the map */

export interface DungeonMap {
  w: number;
  h: number;
  tiles: Uint8Array;
  seen: Uint8Array; // fog of war memory: 0 unknown, 1 explored
  visible: Uint8Array; // current FoV: 1 visible
  spawnX: number;
  spawnY: number;
  stairsX: number;
  stairsY: number;
  fovVersion: number; // bumped whenever FoV is recomputed
  floorSeed: number;
  idx(x: number, y: number): number;
  inBounds(x: number, y: number): boolean;
  solid(x: number, y: number): boolean;
  walkable(x: number, y: number): boolean;
}

/* ---------------------------------------------------------------------- fx */

export interface IFx {
  beam(x0: number, y0: number, x1: number, y1: number, color: number, width: number): void;
  ring(x: number, y: number, color: number, radius: number): void;
  burst(x: number, y: number, color: number, count: number, speed: number, life: number, size: number): void;
  shards(x: number, y: number, color: number, count: number, power: number): void;
  text(x: number, y: number, str: string, color: string, size?: number): void;
  flash(color: number, alpha: number): void;
  shake(mag: number): void;
}

/* -------------------------------------------------------------- audio-like */

export type SfxName =
  | "shoot"
  | "hit"
  | "hurt"
  | "kill"
  | "pickup"
  | "weapon"
  | "dash"
  | "stairs"
  | "crate"
  | "ui"
  | "denied"
  | "charge"
  | "enemyshoot";

export interface ISfx {
  play(name: SfxName): void;
}

/* ------------------------------------------------------------- game context */

export interface InputState {
  /** tile-space (fractional) pointer target, updated by the renderer */
  aimX: number;
  aimY: number;
  lmbHeld: boolean;
  /** queued discrete intents filled by InputSystem */
  moveQueue: Int8Array; // pairs [dx,dy,...]
  moveCount: number;
  wantShoot: boolean;
  wantDash: boolean;
  wantWait: boolean;
  wantDescend: boolean;
}

export interface GameCtx {
  world: World;
  map: DungeonMap;
  hash: SpatialHash;
  player: number;
  stats: PlayerStats;
  fx: IFx;
  sfx: ISfx;
  rng: () => number;
  floor: number;
  turn: number;
  time: number;
  state: GState;
  input: InputState;
  setState(s: GState): void;
  /** Fully tear down an entity: visual, light, hash entry, then destroy. */
  removeEntity(e: number): void;
  damageEnemy(e: number, dmg: number, kx: number, ky: number, silent?: boolean): void;
  damagePlayer(dmg: number, fromX: number, fromY: number): void;
  smashCrateAt(x: number, y: number): void;
  endPlayerAction(acted: boolean): void;
  descend(): void;
  pushHud(): void;
}

/* -------------------------------------------------------- React HUD snapshot */

export interface DeathStats {
  floor: number;
  kills: number;
  score: number;
  time: string;
  weapon: string;
}

export interface Snap {
  state: GState;
  hp: number;
  maxHp: number;
  en: number;
  maxEn: number;
  armor: number;
  floor: number;
  kills: number;
  score: number;
  weapon: string;
  prompt: string;
  muted: boolean;
  banner: string;
  bannerKey: number;
  death: DeathStats | null;
  dmgPulse: number; // incremented to retrigger CSS flash
}

export const INITIAL_SNAP: Snap = {
  state: "title",
  hp: 100,
  maxHp: 100,
  en: 100,
  maxEn: 100,
  armor: 0,
  floor: 1,
  kills: 0,
  score: 0,
  weapon: "PULSE SIDEARM",
  prompt: "",
  muted: false,
  banner: "",
  bannerKey: 0,
  death: null,
  dmgPulse: 0,
};
