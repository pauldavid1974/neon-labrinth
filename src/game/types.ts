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
  Barrel = 6,
  TeslaNode = 7,
  Acid = 8,
  Shrine = 9,
}

export interface BiomeDef {
  name: string;
  code: string;
  primary: number;
  secondary: number;
  wallBase: number;
  floorBase: number;
  gridColor: number;
}

export function getBiome(floor: number): BiomeDef {
  if (floor <= 3) {
    return {
      name: "CORE GENERATOR",
      code: "SEC-01",
      primary: 0x00f0ff,
      secondary: 0x1a7f9e,
      wallBase: 0x060c18,
      floorBase: 0x04070e,
      gridColor: 0x00f0ff,
    };
  }
  if (floor <= 6) {
    return {
      name: "BIO-CYBER FOUNDRY",
      code: "SEC-02",
      primary: 0x22c55e,
      secondary: 0xeab308,
      wallBase: 0x06140b,
      floorBase: 0x030d06,
      gridColor: 0x22c55e,
    };
  }
  if (floor <= 9) {
    return {
      name: "NEURAL MATRIX",
      code: "SEC-03",
      primary: 0xff2bd6,
      secondary: 0x9d4edd,
      wallBase: 0x140618,
      floorBase: 0x0b030e,
      gridColor: 0xff2bd6,
    };
  }
  return {
    name: "ZERO-POINT VOID",
    code: "SEC-04",
    primary: 0xfbbf24,
    secondary: 0xffffff,
    wallBase: 0x120f04,
    floorBase: 0x0a0802,
    gridColor: 0xfbbf24,
  };
}

export type GState = "title" | "playing" | "paused" | "transition" | "dying" | "dead";

export type EnemyKind = "stalker" | "sentinel" | "goliath" | "phantom" | "skitterer" | "sentry" | "boss_warden";
export type EliteKind = "volatile" | "hasted" | "shielded";

export type WeaponBehavior = "beam" | "scatter" | "chain" | "aoe" | "rail";

export interface WeaponStats {
  name: string;
  bolt: number; // ranged damage
  melee: number; // bump-attack damage
  cost: number; // energy per shot
  color: number;
  behavior?: WeaponBehavior;
  spread?: number;
  chainCount?: number;
  aoeRadius?: number;
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
  abilityCd: number; // EMP ability cooldown
  maxAbilityCd: number;
  lastDx: number;
  lastDy: number;
  relics: string[];
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
  elite?: EliteKind;
  shieldHits?: number;
  bossPhase?: number;
  path: Int16Array; // A* output buffer (preallocated, reused)
  pathLen: number;
  pathIdx: number;
  cd: number; // ability cooldown in turns
  aggro: boolean;
  moveTick: number; // moves on specific ticks
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
  | "enemyshoot"
  | "explode"
  | "shock"
  | "scatter"
  | "emp"
  | "shrine";

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
  wantAbility: boolean;
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
  smashBarrelAt(x: number, y: number): void;
  shockNodeAt(x: number, y: number): void;
  useShrineAt(x: number, y: number): void;
  explodeAt(x: number, y: number, radius: number, dmg: number, color: number): void;
  spawnEnemy(kind: EnemyKind, x: number, y: number): void;
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
  relics: string[];
}

export interface BossSnap {
  name: string;
  hp: number;
  maxHp: number;
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
  abilityCd: number;
  maxAbilityCd: number;
  relics: string[];
  boss: BossSnap | null;
  biomeName: string;
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
  abilityCd: 0,
  maxAbilityCd: 7.5,
  relics: [],
  boss: null,
  biomeName: "CORE GENERATOR",
};
