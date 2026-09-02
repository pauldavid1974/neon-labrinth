/**
 * Gameplay systems — pure logic, no rendering.
 *
 * Turn model: the world is turn-based. Each player intent (move / bump-attack
 * / shoot / dash / wait / descend) resolves instantly on the logical grid,
 * then every enemy takes one utility-scored action. Movement is only
 * *rendered* smoothly by animationSystem; logic never waits for tweens.
 */
import type { Store } from "../core/ecs";
import { clamp, manhattan } from "../core/utils";
import { findPath } from "./astar";
import { computeFov, hasLoS, rayToWall } from "./fov";
import {
  FOV_RADIUS,
  TileT,
  type AIComp,
  type Anim,
  type GameCtx,
  type GridPos,
  type Health,
  type LightComp,
  type LootComp,
  type Marker,
  type VisualComp,
  type WeaponStats,
} from "./types";
import type { World } from "../core/ecs";

/* -------------------------------------------------- cached store handles */

interface Stores {
  pos: Store<GridPos>;
  anim: Store<Anim>;
  hp: Store<Health>;
  ai: Store<AIComp>;
  vis: Store<VisualComp>;
  mark: Store<Marker>;
  loot: Store<LootComp>;
  light: Store<LightComp>;
}

let S: Stores | null = null;

export function bindStores(world: World): Stores {
  S = {
    pos: world.s<GridPos>("pos", () => ({ x: 0, y: 0 })),
    anim: world.s<Anim>("anim", () => ({ rx: 0, ry: 0, fx: 0, fy: 0, t: 1, delay: 0, speed: 10, punch: 0 })),
    hp: world.s<Health>("hp", () => ({ hp: 1, max: 1 })),
    ai: world.s<AIComp>("ai", () => ({
      kind: "stalker",
      path: new Int16Array(512),
      pathLen: 0,
      pathIdx: 0,
      cd: 0,
      aggro: false,
      moveTick: 0,
      hurtT: 0,
    })),
    vis: world.s<VisualComp>("visual"),
    mark: world.s<Marker>("marker", () => ({ tag: "" })),
    loot: world.s<LootComp>("loot", () => ({ kind: "heal", tier: 0, name: "" })),
    light: world.s<LightComp>("light", () => ({ r: 4, color: 0xffffff, base: 1, phase: 0, poly: new Array(112).fill(0) })),
  };
  return S;
}

function st(): Stores {
  if (!S) throw new Error("stores not bound");
  return S;
}

/* ------------------------------------------------------------- animation */

export function animationSystem(ctx: GameCtx, dt: number): void {
  const { pos, anim } = st();
  for (let i = 0; i < ctx.world.count; i++) {
    const e = ctx.world.ids[i];
    const a = anim.m.get(e);
    if (!a) continue;
    if (a.punch > 0) a.punch = Math.max(0, a.punch - dt * 4.2);
    if (a.delay > 0) {
      a.delay -= dt;
      continue;
    }
    if (a.t >= 1) continue;
    const p = pos.m.get(e);
    if (!p) continue;
    a.t = Math.min(1, a.t + dt * a.speed);
    // smoothstep ease-out for weighty, readable movement
    const k = a.t * a.t * (3 - 2 * a.t);
    a.rx = a.fx + (p.x - a.fx) * k;
    a.ry = a.fy + (p.y - a.fy) * k;
  }
}

/** Snap an entity's render position after a teleport/floor change. */
export function snapAnim(e: number): void {
  const { pos, anim } = st();
  const p = pos.m.get(e);
  const a = anim.m.get(e);
  if (p && a) {
    a.rx = p.x;
    a.ry = p.y;
    a.fx = p.x;
    a.fy = p.y;
    a.t = 1;
    a.delay = 0;
  }
}

function startTween(e: number, speed: number, delay: number): void {
  const { pos, anim } = st();
  const p = pos.m.get(e);
  const a = anim.m.get(e);
  if (!p || !a) return;
  a.fx = a.rx;
  a.fy = a.ry;
  a.t = 0;
  a.delay = delay;
  a.speed = speed;
}

/* ------------------------------------------------------------------- FoV */

export function recomputeFov(ctx: GameCtx, polyOut: Float32Array): number {
  const { pos } = st();
  const p = pos.m.get(ctx.player);
  if (!p) return 0;
  const rays = computeFov(ctx.map, p.x, p.y, FOV_RADIUS, polyOut);
  const { seen, visible, w, h } = ctx.map;
  for (let i = 0; i < w * h; i++) if (visible[i]) seen[i] = 1;
  ctx.map.fovVersion++;
  return rays;
}

/* ----------------------------------------------------------------- input */

export interface RepeatState {
  t: number;
  heldPrev: boolean;
}

/**
 * Hold-to-repeat movement + held mouse fire intent. Discrete keys are queued
 * by the Game on keydown (one step per press). Auto-repeat only kicks in
 * after an initial delay while the key stays held — this prevents the classic
 * "two steps per tap" bug where the repeat timer fires on the very first
 * frame after a fresh keydown.
 */
export function inputSystem(ctx: GameCtx, dt: number, keys: ReadonlySet<string>, rep: RepeatState): void {
  rep.t -= dt;
  if (ctx.state !== "playing") {
    rep.heldPrev = false;
    ctx.input.wantShoot = false;
    return;
  }
  let dx = 0;
  let dy = 0;
  if (keys.has("KeyW") || keys.has("ArrowUp")) dy = -1;
  else if (keys.has("KeyS") || keys.has("ArrowDown")) dy = 1;
  else if (keys.has("KeyA") || keys.has("ArrowLeft")) dx = -1;
  else if (keys.has("KeyD") || keys.has("ArrowRight")) dx = 1;
  const held = dx !== 0 || dy !== 0;
  if (held && !rep.heldPrev) rep.t = 0.3; // fresh press: the keydown intent already moved us once
  rep.heldPrev = held;
  if (held && rep.t <= 0) {
    queueMoveIntent(ctx, dx, dy);
    rep.t = 0.16;
  }
  ctx.input.wantShoot = ctx.input.lmbHeld;
}

export function queueMoveIntent(ctx: GameCtx, dx: number, dy: number): void {
  const inp = ctx.input;
  // Single-slot buffer: at most one pending step, so one input can never
  // translate into a multi-tile glide.
  if (inp.moveCount === 0) {
    inp.moveQueue[0] = dx;
    inp.moveQueue[1] = dy;
    inp.moveCount = 1;
  } else {
    // overwrite with the freshest direction so turning feels immediate
    inp.moveQueue[0] = dx;
    inp.moveQueue[1] = dy;
  }
}

/* -------------------------------------------------------- player actions */

export function runPlayerIntents(ctx: GameCtx): boolean {
  const inp = ctx.input;
  let acted = false;
  if (inp.moveCount > 0) {
    // Tween gate: don't start the next tile until the current step has
    // visually landed (t >= 0.5). Combined with the single-slot buffer this
    // guarantees exactly one tile per input — no double-step glides.
    const pa = st().anim.m.get(ctx.player);
    if (pa && pa.delay <= 0 && pa.t < 0.5) return false;
    const dx = inp.moveQueue[0];
    const dy = inp.moveQueue[1];
    inp.moveCount = 0;
    acted = tryMove(ctx, dx, dy);
  } else if (inp.wantShoot) {
    acted = tryShoot(ctx);
  } else if (inp.wantDash) {
    acted = tryDash(ctx);
  } else if (inp.wantAbility) {
    acted = tryUseAbility(ctx);
  } else if (inp.wantWait) {
    const s = ctx.stats;
    s.en = clamp(s.en + 6 + s.enRegen, 0, s.maxEn);
    ctx.fx.text(playerX(ctx), playerY(ctx) - 0.6, "VENT +6", "#7ef3ff", 11);
    acted = true;
  } else if (inp.wantDescend) {
    if (ctx.stats.onStairs) {
      ctx.descend();
      acted = false; // transition handles itself
    }
  }
  inp.wantDash = false;
  inp.wantAbility = false;
  inp.wantWait = false;
  inp.wantDescend = false;
  return acted;
}

function playerX(ctx: GameCtx): number {
  return st().pos.m.get(ctx.player)?.x ?? 0;
}
function playerY(ctx: GameCtx): number {
  return st().pos.m.get(ctx.player)?.y ?? 0;
}

function moveEntity(ctx: GameCtx, e: number, nx: number, ny: number, speed: number, delay: number): void {
  const { pos } = st();
  const p = pos.m.get(e);
  if (!p) return;
  ctx.hash.move(e, p.x, p.y, nx, ny);
  p.x = nx;
  p.y = ny;
  startTween(e, speed, delay);
}

function tryMove(ctx: GameCtx, dx: number, dy: number): boolean {
  const { pos, mark } = st();
  const p = pos.m.get(ctx.player);
  if (!p) return false;
  const s = ctx.stats;
  if (dx !== 0 || dy !== 0) {
    s.lastDx = dx;
    s.lastDy = dy;
  }
  const tx = p.x + dx;
  const ty = p.y + dy;

  const occ = ctx.hash.get(tx, ty);
  if (occ >= 0) {
    const m = mark.m.get(occ);
    if (m && m.tag === "enemy") {
      // bump-attack
      let dmg = Math.max(2, Math.round(s.weapon.melee * (0.85 + ctx.rng() * 0.4)));
      if (s.relics.includes("OVERCHARGE MATRIX")) {
        dmg = Math.round(dmg * 1.3);
        ctx.fx.ring(tx, ty, 0xfacc15, 1.8);
        ctx.fx.burst(tx + 0.5, ty + 0.5, 0xfacc15, 12, 3.5, 0.4, 0.12);
        ctx.sfx.play("shock");
      }
      ctx.damageEnemy(occ, dmg, dx, dy);
      s.en = clamp(s.en + 4, 0, s.maxEn); // melee vents energy back into the capacitor
      return true;
    }
    return false;
  }

  const tile = ctx.map.inBounds(tx, ty) ? ctx.map.tiles[ctx.map.idx(tx, ty)] : TileT.Wall;
  if (tile === TileT.Crate) {
    ctx.smashCrateAt(tx, ty);
    return true;
  }
  if (tile === TileT.Barrel) {
    ctx.smashBarrelAt(tx, ty);
    return true;
  }
  if (tile === TileT.TeslaNode) {
    ctx.shockNodeAt(tx, ty);
    return true;
  }
  if (tile === TileT.Shrine) {
    ctx.useShrineAt(tx, ty);
    return true;
  }
  if (tile === TileT.Wall || tile === TileT.Pillar) return false;

  moveEntity(ctx, ctx.player, tx, ty, 13, 0);
  if (tile === TileT.Acid) {
    ctx.damagePlayer(6, tx, ty);
    ctx.fx.text(tx, ty - 0.7, "-6 ACID", "#22c55e", 12);
    ctx.fx.burst(tx + 0.5, ty + 0.5, 0x22c55e, 12, 3, 0.4, 0.12);
  } else {
    ctx.fx.burst(p.x + dx * 0.4 + 0.1, p.y + dy * 0.4 + 0.5, 0x1a7f9e, 3, 1.6, 0.3, 0.08);
  }
  tryPickupAt(ctx, tx, ty);
  return true;
}

function tryPickupAt(ctx: GameCtx, x: number, y: number): void {
  const { pos, loot, mark } = st();
  for (let i = 0; i < ctx.world.count; i++) {
    const e = ctx.world.ids[i];
    const l = loot.m.get(e);
    if (!l) continue;
    const m = mark.m.get(e);
    if (!m || m.tag !== "loot") continue;
    const p = pos.m.get(e);
    if (!p || p.x !== x || p.y !== y) continue;
    applyLoot(ctx, l);
    ctx.removeEntity(e); // detach visual + light + hash entry, then destroy
    return;
  }
}

function applyLoot(ctx: GameCtx, l: LootComp): void {
  const s = ctx.stats;
  const px = playerX(ctx);
  const py = playerY(ctx);
  if (l.kind === "heal") {
    const amt = 22 + l.tier * 10;
    s.hp = clamp(s.hp + amt, 0, s.maxHp);
    ctx.fx.text(px, py - 0.6, `+${amt} HP`, "#46ffa6", 14);
    ctx.fx.ring(px, py, 0x46ffa6, 1.1);
    ctx.sfx.play("pickup");
  } else if (l.kind === "energy") {
    const amt = 35 + l.tier * 10;
    s.en = clamp(s.en + amt, 0, s.maxEn);
    ctx.fx.text(px, py - 0.6, `+${amt} EN`, "#ffe14d", 14);
    ctx.fx.ring(px, py, 0xffe14d, 1.0);
    ctx.sfx.play("pickup");
  } else if (l.kind === "weapon") {
    s.weapon = WEAPON_TABLE[clamp(l.tier, 0, WEAPON_TABLE.length - 1)];
    if (l.tier >= 4) s.pierce = true;
    ctx.fx.text(px, py - 0.6, l.name, "#aef6ff", 15);
    ctx.fx.ring(px, py, 0x00f0ff, 1.4);
    ctx.fx.burst(px + 0.5, py + 0.5, 0x00f0ff, 22, 4, 0.5, 0.14);
    ctx.sfx.play("weapon");
  } else {
    if (!s.relics.includes(l.name)) s.relics.push(l.name);
    // relics — permanent buffs
    if (l.tier === 0) {
      s.armor += 2;
      ctx.fx.text(px, py - 0.6, `${l.name}  ARMOR +2`, "#ff9df0", 13);
    } else if (l.tier === 1) {
      s.enRegen += 4;
      ctx.fx.text(px, py - 0.6, `${l.name}  REGEN +4`, "#ff9df0", 13);
    } else if (l.tier === 2) {
      s.lifesteal += 4;
      ctx.fx.text(px, py - 0.6, `${l.name}  LEECH +4`, "#ff9df0", 13);
    } else if (l.tier === 3) {
      s.maxHp += 30;
      s.hp += 30;
      ctx.fx.text(px, py - 0.6, `${l.name}  MAX HP +30`, "#ff9df0", 13);
    } else if (l.tier === 4) {
      s.maxEn += 30;
      s.en = s.maxEn;
      s.maxAbilityCd = Math.max(4.0, s.maxAbilityCd - 1.5);
      ctx.fx.text(px, py - 0.6, `${l.name}  MAX EN +30 / CD -1.5s`, "#ff9df0", 13);
    } else if (l.tier === 5) {
      s.weapon = { ...s.weapon, bolt: s.weapon.bolt + 8, melee: s.weapon.melee + 8 };
      ctx.fx.text(px, py - 0.6, `${l.name}  CRIT & SHOCK MATRIX ACTIVE`, "#facc15", 14);
    } else {
      s.weapon = { ...s.weapon, bolt: s.weapon.bolt + 6, melee: s.weapon.melee + 6 };
      ctx.fx.text(px, py - 0.6, `${l.name}  POWER +6`, "#ff9df0", 13);
    }
    ctx.fx.ring(px, py, 0xff2bd6, 1.3);
    ctx.sfx.play("weapon");
  }
  ctx.pushHud();
}

export const WEAPON_TABLE: WeaponStats[] = [
  { name: "PULSE SIDEARM", bolt: 14, melee: 10, cost: 10, color: 0x00f0ff, behavior: "beam" },
  { name: "SCATTER BLASTER", bolt: 11, melee: 14, cost: 12, color: 0xffb347, behavior: "scatter", spread: 0.18 },
  { name: "TESLA LANCE", bolt: 18, melee: 12, cost: 14, color: 0x4df3ff, behavior: "chain", chainCount: 2 },
  { name: "NOVA MORTAR", bolt: 28, melee: 18, cost: 18, color: 0xff2bd6, behavior: "aoe", aoeRadius: 1.5 },
  { name: "VOID SINGULARITY", bolt: 40, melee: 24, cost: 20, color: 0xb967ff, behavior: "rail" },
  { name: "CHRONO TACHYON", bolt: 48, melee: 28, cost: 22, color: 0x38bdf8, behavior: "chrono" },
];

export const WEAPON_PREFIX = ["IONIZED", "HEXED", "CHROME", "VIRAL", "PHANTOM", "OVERCLOCKED", "TACHYONIC"] as const;
export const RELIC_NAMES = [
  "AEGIS PLATING",
  "FLUX OVERCLOCK",
  "VAMPIRIC CIRCUIT",
  "TITAN CORE",
  "STATIC DISCHARGE",
  "OVERCHARGE MATRIX",
  "CRITICAL MATRIX",
] as const;

let shootDenyT = 0;

function castWeaponRay(
  ctx: GameCtx,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  maxDist: number,
  baseDmg: number,
  color: number,
  pierce: boolean,
): { hitCount: number; hitEnemies: number[]; endT: number; ex: number; ey: number } {
  const wallDist = rayToWall(ctx.map, ox, oy, ox + dx * maxDist, oy + dy * maxDist, maxDist);
  const { pos, mark } = st();
  let bestT = wallDist;
  const hitEnemies: number[] = [];

  // Check map props (barrels, tesla nodes, crates) along the ray
  const step = 0.5;
  for (let t = 0.5; t <= wallDist; t += step) {
    const gx = Math.floor(ox + dx * t);
    const gy = Math.floor(oy + dy * t);
    if (!ctx.map.inBounds(gx, gy)) break;
    const tile = ctx.map.tiles[ctx.map.idx(gx, gy)];
    if (tile === TileT.Barrel) {
      ctx.smashBarrelAt(gx, gy);
      if (!pierce) {
        bestT = Math.min(bestT, t);
        break;
      }
    } else if (tile === TileT.TeslaNode) {
      ctx.shockNodeAt(gx, gy);
      if (!pierce) {
        bestT = Math.min(bestT, t);
        break;
      }
    } else if (tile === TileT.Crate && pierce) {
      ctx.smashCrateAt(gx, gy);
    }
  }

  for (let i = 0; i < ctx.world.count; i++) {
    const e = ctx.world.ids[i];
    const m = mark.m.get(e);
    if (!m || m.tag !== "enemy") continue;
    const p = pos.m.get(e);
    if (!p) continue;
    if (ctx.map.visible[ctx.map.idx(p.x, p.y)] !== 1) continue;
    const rx = p.x + 0.5 - ox;
    const ry = p.y + 0.5 - oy;
    const tProj = rx * dx + ry * dy;
    if (tProj < 0.2 || tProj > wallDist) continue;
    const perp = Math.abs(rx * dy - ry * dx);
    if (perp < 0.47) {
      hitEnemies.push(e);
      if (tProj < bestT) bestT = tProj;
    }
  }

  const endT = pierce ? wallDist : Math.max(0.45, bestT - 0.32);
  const ex = ox + dx * endT;
  const ey = oy + dy * endT;

  ctx.fx.beam(ox - 0.5, oy - 0.5, ex - 0.5, ey - 0.5, color, pierce ? 3.0 : 2.1);
  ctx.fx.burst(ox + dx * 0.5, oy + dy * 0.5, color, 5, 2.4, 0.25, 0.1);

  for (const e of hitEnemies) {
    const p = pos.m.get(e);
    if (!p) continue;
    const tProj = (p.x + 0.5 - ox) * dx + (p.y + 0.5 - oy) * dy;
    if (pierce || tProj <= bestT + 0.01) {
      const dmg = Math.max(2, Math.round(baseDmg * (0.85 + ctx.rng() * 0.4)));
      ctx.damageEnemy(e, dmg, dx, dy);
    }
  }

  if (hitEnemies.length === 0) {
    ctx.fx.ring(ex - 0.5, ey - 0.5, color, 0.5);
  }

  return { hitCount: hitEnemies.length, hitEnemies, endT, ex, ey };
}

function tryShoot(ctx: GameCtx): boolean {
  const s = ctx.stats;
  if (s.fireCd > 0) return false;
  const px = playerX(ctx);
  const py = playerY(ctx);
  if (s.en < s.weapon.cost) {
    if (ctx.time - shootDenyT > 0.6) {
      shootDenyT = ctx.time;
      ctx.fx.text(px, py - 0.6, "NO ENERGY", "#ff4d5e", 12);
      ctx.sfx.play("denied");
    }
    return false;
  }
  s.en -= s.weapon.cost;
  s.fireCd = 0.23;

  const ox = px + 0.5;
  const oy = py + 0.5;
  let dx = ctx.input.aimX - ox;
  let dy = ctx.input.aimY - oy;
  const dl = Math.sqrt(dx * dx + dy * dy);
  if (dl < 0.45) {
    // Smart auto-aim: target closest visible enemy if neutral or touch tap
    const { pos, mark, hp } = st();
    let closestDist = Infinity;
    let bestDx = s.lastDx || 1;
    let bestDy = s.lastDy || 0;
    for (let i = 0; i < ctx.world.count; i++) {
      const e = ctx.world.ids[i];
      const m = mark.m.get(e);
      if (!m || m.tag !== "enemy") continue;
      const h = hp.m.get(e);
      if (!h || h.hp <= 0) continue;
      const p = pos.m.get(e);
      if (!p) continue;
      if (ctx.map.visible[ctx.map.idx(p.x, p.y)] !== 1) continue;
      const edx = p.x + 0.5 - ox;
      const edy = p.y + 0.5 - oy;
      const distSq = edx * edx + edy * edy;
      if (distSq < closestDist) {
        closestDist = distSq;
        bestDx = edx;
        bestDy = edy;
      }
    }
    const bestLen = Math.sqrt(bestDx * bestDx + bestDy * bestDy) || 1;
    dx = bestDx / bestLen;
    dy = bestDy / bestLen;
  } else {
    dx /= dl;
    dy /= dl;
  }

  const baseAngle = Math.atan2(dy, dx);
  const behavior = s.weapon.behavior ?? "beam";
  let shotDmg = s.weapon.bolt;

  // Check Overcharge Matrix crit
  if (s.relics.includes("OVERCHARGE MATRIX") && ctx.rng() < 0.28) {
    shotDmg = Math.round(shotDmg * 2.2);
    ctx.sfx.play("crit");
    ctx.fx.text(px, py - 0.7, "OVERCHARGE CRIT", "#facc15", 14);
    ctx.fx.flash(0xfacc15, 0.2);
  }

  if (behavior === "chrono") {
    ctx.sfx.play("chrono");
    ctx.fx.shake(5.2, dx, dy);
    ctx.fx.flash(0x38bdf8, 0.28);
    ctx.fx.chroma("chrono");
    ctx.fx.shockwave(px, py, 0x38bdf8, 2.4);
    const res = castWeaponRay(ctx, ox, oy, dx, dy, 24, shotDmg, 0x38bdf8, true);
    const { ai, pos } = st();
    for (const e of res.hitEnemies) {
      const comp = ai.m.get(e);
      if (comp) comp.cd = Math.max(comp.cd, 2);
      const ep = pos.m.get(e);
      if (ep) {
        ctx.fx.text(ep.x, ep.y - 0.7, "TIME-LOCKED", "#38bdf8", 12);
        ctx.fx.ring(ep.x, ep.y, 0x38bdf8, 1.2);
      }
    }
    return true;
  }

  if (behavior === "scatter") {
    ctx.sfx.play("scatter");
    ctx.fx.shake(3.5, dx, dy);
    const spread = s.weapon.spread ?? 0.18;
    ctx.fx.spray(ox, oy, baseAngle, spread * 2.6, s.weapon.color, 16, 5.2, 0.2, 0.11);
    for (const offset of [-spread, 0, spread]) {
      const a = baseAngle + offset;
      castWeaponRay(ctx, ox, oy, Math.cos(a), Math.sin(a), 14, Math.round(shotDmg * 0.85), s.weapon.color, false);
    }
    return true;
  }

  if (behavior === "aoe") {
    ctx.sfx.play("shoot");
    ctx.fx.shake(4, dx, dy);
    const res = castWeaponRay(ctx, ox, oy, dx, dy, 16, Math.round(shotDmg * 0.6), s.weapon.color, false);
    const nx = Math.floor(res.ex);
    const ny = Math.floor(res.ey);
    ctx.fx.shockwave(nx, ny, s.weapon.color, (s.weapon.aoeRadius ?? 1.5) * 1.6);
    ctx.explodeAt(nx, ny, s.weapon.aoeRadius ?? 1.5, shotDmg, s.weapon.color);
    return true;
  }

  if (behavior === "chain") {
    ctx.sfx.play("shoot");
    ctx.fx.shake(2.5, dx, dy);
    const res = castWeaponRay(ctx, ox, oy, dx, dy, 18, shotDmg, s.weapon.color, false);
    if (res.hitEnemies.length > 0) {
      const primaryE = res.hitEnemies[0];
      const pp = st().pos.m.get(primaryE);
      if (pp) {
        const { pos, mark } = st();
        let chains = 0;
        const maxChains = s.weapon.chainCount ?? 2;
        for (let i = 0; i < ctx.world.count && chains < maxChains; i++) {
          const ce = ctx.world.ids[i];
          if (ce === primaryE) continue;
          const cm = mark.m.get(ce);
          if (!cm || cm.tag !== "enemy") continue;
          const cp = pos.m.get(ce);
          if (!cp) continue;
          if (ctx.map.visible[ctx.map.idx(cp.x, cp.y)] !== 1) continue;
          const cdx = cp.x - pp.x;
          const cdy = cp.y - pp.y;
          const distSq = cdx * cdx + cdy * cdy;
          if (distSq > 20) continue;
          ctx.fx.beam(pp.x, pp.y, cp.x, cp.y, 0x4df3ff, 2.5);
          ctx.fx.beam(pp.x, pp.y + 0.14, cp.x, cp.y - 0.1, 0xffffff, 0.85);
          ctx.fx.spray(cp.x + 0.5, cp.y + 0.5, Math.atan2(cdy, cdx), 0.9, 0x4df3ff, 6, 3.2, 0.2, 0.08);
          ctx.damageEnemy(ce, Math.round(shotDmg * 0.65), cdx, cdy);
          chains++;
        }
        if (chains > 0) ctx.sfx.play("shock");
      }
    }
    return true;
  }

  if (behavior === "rail") {
    ctx.sfx.play("shoot");
    ctx.fx.shake(5, dx, dy);
    ctx.fx.flash(s.weapon.color, 0.22);
    ctx.fx.spray(ox, oy, baseAngle, 0.35, s.weapon.color, 8, 4.8, 0.16, 0.1);
    castWeaponRay(ctx, ox, oy, dx, dy, 22, shotDmg, s.weapon.color, true);
    return true;
  }

  // Standard beam
  ctx.sfx.play("shoot");
  ctx.fx.shake(2.2, dx, dy);
  ctx.fx.spray(ox, oy, baseAngle, 0.4, s.weapon.color, 5, 3.6, 0.16, 0.08);
  castWeaponRay(ctx, ox, oy, dx, dy, 20, shotDmg, s.weapon.color, s.pierce);
  return true;
}

function tryUseAbility(ctx: GameCtx): boolean {
  const s = ctx.stats;
  if (s.abilityCd > 0) return false;
  const px = playerX(ctx);
  const py = playerY(ctx);
  if (s.en < 30) {
    ctx.fx.text(px, py - 0.6, "NO ENERGY", "#ff4d5e", 12);
    ctx.sfx.play("denied");
    return false;
  }
  s.en -= 30;
  s.abilityCd = s.maxAbilityCd;
  ctx.sfx.play("emp");
  ctx.fx.shockwave(px, py, 0x00f0ff, 6.2);
  ctx.fx.chroma("emp");
  ctx.fx.flash(0x00f0ff, 0.28);
  ctx.fx.shake(7.5);
  ctx.fx.text(px, py - 0.8, "EMP SHOCKWAVE", "#00f0ff", 14);

  const { pos, mark, ai } = st();
  for (let i = 0; i < ctx.world.count; i++) {
    const e = ctx.world.ids[i];
    const m = mark.m.get(e);
    if (!m || m.tag !== "enemy") continue;
    const p = pos.m.get(e);
    if (!p) continue;
    if (ctx.map.visible[ctx.map.idx(p.x, p.y)] !== 1) continue;
    const dx = p.x - px;
    const dy = p.y - py;
    if (dx * dx + dy * dy > 38) continue;

    const comp = ai.m.get(e);
    if (comp) comp.cd = Math.max(comp.cd, 2);
    ctx.damageEnemy(e, 14 + ctx.floor * 2, dx, dy);
    ctx.fx.text(p.x, p.y - 0.7, "STUNNED", "#7ef3ff", 12);
    ctx.fx.burst(p.x + 0.5, p.y + 0.5, 0x4df3ff, 12, 3.2, 0.35, 0.12);
  }
  return true;
}

const hitScratch: number[] = new Array(16).fill(0);

function tryDash(ctx: GameCtx): boolean {
  const s = ctx.stats;
  if (s.dashCd > 0) return false;
  const dx = s.lastDx;
  const dy = s.lastDy;
  if (dx === 0 && dy === 0) return false;
  if (s.en < 20) {
    ctx.fx.text(playerX(ctx), playerY(ctx) - 0.6, "NO ENERGY", "#ff4d5e", 12);
    ctx.sfx.play("denied");
    return false;
  }
  s.en -= 20;
  s.dashCd = 1.15;
  s.invuln = 0.32;
  const { pos } = st();
  const p = pos.m.get(ctx.player);
  if (!p) return false;
  const startX = p.x;
  const startY = p.y;
  let steps = 0;
  for (let i = 0; i < 2; i++) {
    const nx = p.x + dx;
    const ny = p.y + dy;
    if (!ctx.map.walkable(nx, ny) || ctx.hash.get(nx, ny) >= 0) break;
    moveEntity(ctx, ctx.player, nx, ny, 22, 0);
    steps++;
  }
  if (steps === 0) {
    s.dashCd = 0.2;
    return false;
  }
  const pa = st().anim.m.get(ctx.player);
  if (pa) pa.punch = 1.22;
  for (let i = 0; i <= steps; i++) {
    const gx = startX + dx * i;
    const gy = startY + dy * i;
    ctx.fx.ghost(gx, gy, 0x00f0ff);
    ctx.fx.burst(gx + 0.5, gy + 0.5, 0x00f0ff, 4, 2.0, 0.28, 0.1);
  }
  ctx.sfx.play("dash");
  ctx.fx.shake(3.4, dx, dy);
  tryPickupAt(ctx, p.x, p.y);
  return true;
}

/* --------------------------------------------------------- enemy utility AI */

type EnemyAction = "attack" | "shoot" | "advance" | "retreat" | "charge" | "shield_ally" | "boss_barrage" | "boss_summon" | "wait";

function decideAction(ctx: GameCtx, e: number, ai: AIComp, dist: number, los: boolean, hpRatio: number): EnemyAction {
  let best: EnemyAction = "wait";
  let bestScore = -1;
  const consider = (a: EnemyAction, score: number): void => {
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  };

  if (ai.kind === "stalker") {
    if (dist === 1) consider("attack", 100);
    const aggro = ai.aggro || dist <= 8 || ai.hurtT > 0;
    if (aggro) consider("advance", 82);
    else consider("advance", 38);
  } else if (ai.kind === "sentinel") {
    if (hpRatio < 0.32 && dist <= 3) consider("retreat", 96);
    else if (dist <= 2) consider("retreat", 90);
    if (los && dist <= 7 && ai.cd <= 0) consider("shoot", 93);
    if (!los) consider("advance", 76);
    consider("wait", 28);
  } else if (ai.kind === "goliath") {
    if (dist === 1) consider("attack", 100);
    if (ai.cd <= 0 && dist >= 3 && dist <= 5 && los && straightLane(ctx, e, dist)) consider("charge", 92);
    if (ai.moveTick === 0) consider("advance", 70);
    consider("wait", 30);
  } else if (ai.kind === "skitterer") {
    if (dist === 1) consider("attack", 100);
    consider("advance", 90);
  } else if (ai.kind === "phantom") {
    if (dist === 1) consider("attack", 100);
    if (dist <= 10) consider("advance", 85);
    consider("wait", 30);
  } else if (ai.kind === "sentry") {
    if (ai.cd <= 0 && dist <= 6) consider("shield_ally", 94);
    if (dist <= 2) consider("retreat", 88);
    consider("wait", 30);
  } else if (ai.kind === "boss_warden") {
    if (dist === 1) consider("attack", 100);
    if (ai.cd <= 0 && los && dist <= 8) consider("boss_barrage", 95);
    if (hpRatio < 0.5 && ai.cd <= 1 && ctx.rng() < 0.4) consider("boss_summon", 90);
    consider("advance", 75);
  }
  return best;
}

function straightLane(ctx: GameCtx, e: number, dist: number): boolean {
  const { pos } = st();
  const p = pos.m.get(e);
  const pp = pos.m.get(ctx.player);
  if (!p || !pp) return false;
  const dx = Math.sign(pp.x - p.x);
  const dy = Math.sign(pp.y - p.y);
  if (dx !== 0 && dy !== 0) return false;
  for (let i = 1; i < dist; i++) {
    const x = p.x + dx * i;
    const y = p.y + dy * i;
    if (!ctx.map.walkable(x, y) || ctx.hash.get(x, y) >= 0) return false;
  }
  return true;
}

export function enemyTurnSystem(ctx: GameCtx): void {
  if (ctx.state !== "playing") return;
  const { pos, ai, hp, mark } = st();
  const pp = pos.m.get(ctx.player);
  if (!pp) return;
  let order = 0;
  for (let i = 0; i < ctx.world.count; i++) {
    const e = ctx.world.ids[i];
    const aiC = ai.m.get(e);
    if (!aiC) continue;
    const h = hp.m.get(e);
    if (!h || h.hp <= 0) continue;
    const p = pos.m.get(e);
    if (!p) continue;

    const dist = manhattan(p.x, p.y, pp.x, pp.y);
    if (dist > 16) {
      aiC.cd = Math.max(0, aiC.cd - 1);
      continue;
    }
    const los = dist <= 9 ? hasLoS(ctx.map, p.x, p.y, pp.x, pp.y) : false;
    const passes = aiC.elite === "hasted" ? 2 : 1;

    for (let pass = 0; pass < passes; pass++) {
      if (h.hp <= 0) break;
      const currentDist = manhattan(p.x, p.y, pp.x, pp.y);
      const action = decideAction(ctx, e, aiC, currentDist, los, h.hp / h.max);
      const delay = order * 0.04;
      order++;

      switch (action) {
        case "attack": {
          let dmg = 7 + ctx.floor;
          if (aiC.kind === "boss_warden") dmg = 20 + ctx.floor * 3;
          else if (aiC.kind === "goliath") dmg = 16 + ctx.floor * 2;
          else if (aiC.kind === "phantom") dmg = 12 + ctx.floor * 2;
          else if (aiC.kind === "skitterer") dmg = 14 + ctx.floor;

          ctx.damagePlayer(dmg, p.x, p.y);
          const v = st().vis.m.get(e);
          if (v) v.flash = Math.max(v.flash, 0.4);
          ctx.fx.burst(pp.x + 0.5, pp.y + 0.5, 0xff2bd6, 10, 3.4, 0.4, 0.12);

          if (aiC.kind === "skitterer") {
            ctx.explodeAt(p.x, p.y, 1.2, 12 + ctx.floor * 2, 0x38bdf8);
            ctx.removeEntity(e);
            return;
          }
          break;
        }
        case "shoot": {
          aiC.cd = 2;
          const dmg = 9 + ctx.floor * 2;
          ctx.fx.beam(p.x, p.y, pp.x, pp.y, 0xb967ff, 1.8);
          ctx.fx.burst(pp.x + 0.5, pp.y + 0.5, 0xb967ff, 12, 3, 0.4, 0.12);
          ctx.sfx.play("enemyshoot");
          ctx.damagePlayer(dmg, p.x, p.y);
          break;
        }
        case "shield_ally": {
          aiC.cd = 3;
          let shielded = false;
          for (let j = 0; j < ctx.world.count; j++) {
            const oe = ctx.world.ids[j];
            if (oe === e) continue;
            const om = mark.m.get(oe);
            if (!om || om.tag !== "enemy") continue;
            const oai = ai.m.get(oe);
            if (!oai || (oai.shieldHits && oai.shieldHits > 0)) continue;
            const op = pos.m.get(oe);
            if (!op || manhattan(p.x, p.y, op.x, op.y) > 5) continue;
            oai.shieldHits = 1;
            ctx.fx.beam(p.x, p.y, op.x, op.y, 0x2dd4bf, 2.2);
            ctx.fx.text(op.x, op.y - 0.7, "SHIELDED", "#2dd4bf", 12);
            ctx.fx.burst(op.x + 0.5, op.y + 0.5, 0x2dd4bf, 8, 2.5, 0.3, 0.1);
            shielded = true;
            break;
          }
          if (!shielded) stepToward(ctx, e, aiC, pp.x, pp.y, delay, 7);
          break;
        }
        case "boss_barrage": {
          aiC.cd = 3;
          ctx.sfx.play("enemyshoot");
          ctx.fx.shake(8);
          ctx.fx.beam(p.x, p.y, pp.x, pp.y, 0xff0055, 3.2);
          ctx.fx.beam(p.x, p.y, pp.x + 1, pp.y, 0xff0055, 2.0);
          ctx.fx.beam(p.x, p.y, pp.x - 1, pp.y, 0xff0055, 2.0);
          ctx.damagePlayer(18 + ctx.floor * 2, p.x, p.y);
          ctx.fx.burst(pp.x + 0.5, pp.y + 0.5, 0xff0055, 18, 4.5, 0.5, 0.15);
          break;
        }
        case "boss_summon": {
          aiC.cd = 4;
          ctx.fx.ring(p.x, p.y, 0x38bdf8, 3.5);
          ctx.fx.text(p.x, p.y - 0.8, "SUMMON // ADDS", "#38bdf8", 13);
          for (let s = 0; s < 2; s++) {
            const sx = p.x + (s === 0 ? 1 : -1);
            const sy = p.y;
            if (ctx.map.walkable(sx, sy) && ctx.hash.get(sx, sy) < 0) {
              ctx.spawnEnemy("skitterer", sx, sy);
              ctx.fx.burst(sx + 0.5, sy + 0.5, 0x38bdf8, 12, 3, 0.35, 0.12);
            }
          }
          break;
        }
        case "advance": {
          const speed = aiC.kind === "goliath" ? 5.5 : aiC.kind === "skitterer" ? 11 : 8;
          stepToward(ctx, e, aiC, pp.x, pp.y, delay, speed);
          break;
        }
        case "retreat":
          stepAway(ctx, e, p, pp, delay);
          break;
        case "charge": {
          aiC.cd = 3;
          const dx = Math.sign(pp.x - p.x);
          const dy = Math.sign(pp.y - p.y);
          let last = 0;
          for (let k = 1; k < dist; k++) {
            const x = p.x + dx * k;
            const y = p.y + dy * k;
            if (!ctx.map.walkable(x, y) || ctx.hash.get(x, y) >= 0) break;
            last = k;
          }
          const qx = p.x + dx * last;
          const qy = p.y + dy * last;
          if (last > 0) {
            moveEntity(ctx, e, qx, qy, 15, delay);
            ctx.fx.shake(5);
            ctx.sfx.play("charge");
          }
          if (manhattan(qx, qy, pp.x, pp.y) === 1) {
            ctx.damagePlayer(14 + ctx.floor * 2, qx, qy);
            ctx.fx.burst(pp.x + 0.5, pp.y + 0.5, 0xff5c33, 16, 4, 0.45, 0.13);
          }
          break;
        }
        case "wait":
          break;
      }
    }
    if (aiC.hurtT > 0) aiC.hurtT--;
    aiC.cd = Math.max(0, aiC.cd - 1);
    if (aiC.kind === "goliath") aiC.moveTick = (aiC.moveTick + 1) % 2;
  }
}

function stepToward(ctx: GameCtx, e: number, aiC: AIComp, tx: number, ty: number, delay: number, speed: number): void {
  const { pos } = st();
  const p = pos.m.get(e);
  if (!p) return;
  if (aiC.pathIdx >= aiC.pathLen) {
    aiC.pathLen = findPath(ctx.map, ctx.hash, p.x, p.y, tx, ty, 900, aiC.path);
    aiC.pathIdx = 0;
    if (aiC.pathLen === 0) return;
  }
  const nx = aiC.path[aiC.pathIdx * 2];
  const ny = aiC.path[aiC.pathIdx * 2 + 1];
  aiC.pathIdx++;
  const occ = ctx.hash.get(nx, ny);
  if (occ === ctx.player) {
    aiC.pathIdx = aiC.pathLen; // adjacent already — never step onto the player
    return;
  }
  if (occ >= 0) {
    aiC.pathIdx = aiC.pathLen; // force repath next turn — lane blocked
    return;
  }
  if (!ctx.map.walkable(nx, ny)) {
    aiC.pathIdx = aiC.pathLen;
    return;
  }
  moveEntity(ctx, e, nx, ny, speed, delay);
}

function stepAway(ctx: GameCtx, e: number, p: GridPos, pp: GridPos, delay: number): void {
  const base = manhattan(p.x, p.y, pp.x, pp.y);
  let bx = p.x;
  let by = p.y;
  let best = base;
  for (let d = 0; d < 4; d++) {
    const nx = p.x + (d === 0 ? 1 : d === 1 ? -1 : 0);
    const ny = p.y + (d === 2 ? 1 : d === 3 ? -1 : 0);
    if (!ctx.map.walkable(nx, ny)) continue;
    if (ctx.hash.get(nx, ny) >= 0) continue;
    const nd = manhattan(nx, ny, pp.x, pp.y);
    if (nd > best) {
      best = nd;
      bx = nx;
      by = ny;
    }
  }
  if (bx !== p.x || by !== p.y) moveEntity(ctx, e, bx, by, 8, delay);
}
