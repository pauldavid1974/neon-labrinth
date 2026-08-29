/**
 * Pooled CPU-integrated particle system rendered by PixiJS sprites.
 *
 * Structure-of-Arrays layout over a fixed capacity; dead particles are
 * recycled through an index free-stack. `update()` walks flat typed arrays
 * and writes straight into preallocated Sprite transforms — zero
 * allocations per frame, capped worst-case cost.
 *
 * Coordinates are in TILE units; converted to px when written to sprites.
 */
import { Container, Sprite, type Texture } from "pixi.js";
import { TAU, clamp } from "../core/utils";
import { TILE } from "../game/types";
import type { TexSet } from "./textures";

const CAP = 2200;

export class ParticlePool {
  private x = new Float32Array(CAP);
  private y = new Float32Array(CAP);
  private vx = new Float32Array(CAP);
  private vy = new Float32Array(CAP);
  private life = new Float32Array(CAP);
  private maxLife = new Float32Array(CAP);
  private size = new Float32Array(CAP);
  private grow = new Float32Array(CAP);
  private drag = new Float32Array(CAP);
  private grav = new Float32Array(CAP);
  private alphaScale = new Float32Array(CAP);
  private rot = new Float32Array(CAP);
  private rv = new Float32Array(CAP);
  private sprites: Sprite[] = [];
  private free = new Int32Array(CAP);
  private freeLen = 0;
  private textures: Texture[] = [];
  layer = new Container();

  get alive(): number {
    return CAP - this.freeLen;
  }

  init(tex: TexSet): void {
    this.textures = [tex.soft, tex.dot, tex.shard];
    for (let i = 0; i < CAP; i++) {
      const s = new Sprite(tex.soft);
      s.anchor.set(0.5);
      s.visible = false;
      s.blendMode = "add";
      this.layer.addChild(s);
      this.sprites.push(s);
      this.free[i] = CAP - 1 - i;
    }
    this.freeLen = CAP;
  }

  private spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    size: number,
    color: number,
    texIdx: number,
    grav: number,
    drag: number,
    grow: number,
    alphaScale: number,
  ): void {
    if (this.freeLen === 0) return; // pool exhausted — drop particle
    const i = this.free[--this.freeLen];
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.grow[i] = grow;
    this.drag[i] = drag;
    this.grav[i] = grav;
    this.alphaScale[i] = alphaScale;
    this.rot[i] = Math.random() * TAU;
    this.rv[i] = (Math.random() - 0.5) * 10;
    const s = this.sprites[i];
    s.texture = this.textures[texIdx];
    s.tint = color;
    s.rotation = this.rot[i];
    s.visible = true;
  }

  /** Radial burst of glow motes (tile units). */
  burst(x: number, y: number, color: number, count: number, speed: number, life: number, size: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = speed * (0.25 + Math.random() * 0.75);
      this.spawn(
        x, y,
        Math.cos(a) * sp,
        Math.sin(a) * sp,
        life * (0.55 + Math.random() * 0.45),
        size * (0.6 + Math.random() * 0.8),
        color,
        Math.random() < 0.3 ? 1 : 0,
        0, 2.6, 0, 0.9,
      );
    }
  }

  /** Triangular debris with gravity — crates, kills. */
  shards(x: number, y: number, color: number, count: number, power: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = power * (0.4 + Math.random() * 0.9);
      this.spawn(
        x, y,
        Math.cos(a) * sp,
        Math.sin(a) * sp - power * 0.35,
        0.5 + Math.random() * 0.5,
        0.14 + Math.random() * 0.16,
        color,
        2,
        7.5, 1.8, -0.1, 1,
      );
    }
  }

  /** Directional spray (muzzle flash, impacts). */
  spray(x: number, y: number, ang: number, spread: number, color: number, count: number, speed: number, life: number, size: number): void {
    for (let i = 0; i < count; i++) {
      const a = ang + (Math.random() - 0.5) * spread;
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.spawn(
        x, y,
        Math.cos(a) * sp,
        Math.sin(a) * sp,
        life * (0.5 + Math.random() * 0.5),
        size * (0.5 + Math.random()),
        color,
        1,
        0, 3.2, -0.2, 0.85,
      );
    }
  }

  /** Slow ambient dust mote. */
  dust(x: number, y: number, color: number): void {
    this.spawn(
      x, y,
      (Math.random() - 0.5) * 0.18,
      -0.1 - Math.random() * 0.22,
      2.2 + Math.random() * 2.4,
      0.05 + Math.random() * 0.06,
      color,
      0,
      0, 0.2, 0, 0.35,
    );
  }

  update(dt: number): void {
    const sprites = this.sprites;
    for (let i = 0; i < CAP; i++) {
      let l = this.life[i];
      if (l <= 0) continue;
      l -= dt;
      if (l <= 0) {
        this.life[i] = 0;
        sprites[i].visible = false;
        this.free[this.freeLen++] = i;
        continue;
      }
      this.life[i] = l;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= d;
      this.vy[i] = this.vy[i] * d + this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      const t = l / this.maxLife[i];
      const sz = Math.max(0.01, this.size[i] + this.grow[i] * (1 - t));
      const s = sprites[i];
      s.x = this.x[i] * TILE;
      s.y = this.y[i] * TILE;
      s.alpha = clamp(t * 1.4, 0, 1) * this.alphaScale[i];
      s.width = sz * TILE;
      s.height = sz * TILE;
      s.rotation = this.rot[i] + this.rv[i] * (1 - t);
    }
  }

  /** Kill everything instantly (floor transitions). */
  clearAll(): void {
    for (let i = 0; i < CAP; i++) {
      if (this.life[i] > 0) {
        this.life[i] = 0;
        this.sprites[i].visible = false;
        this.free[this.freeLen++] = i;
      }
    }
  }
}
