/**
 * PixiJS renderer.
 *
 * RENDER-ONLY: this module reads component data and draws. It never mutates
 * game state, spawns entities, or dispatches gameplay events (the IFx methods
 * are pure visual effects fed by systems).
 *
 * Scene graph:
 *   stage
 *   ├─ worldC (camera-transformed)
 *   │   ├─ backplate, tilesDim (memory), tilesLit (masked by FoV polygon)
 *   │   ├─ props (crates), stairs pulse
 *   │   ├─ entityLayer, beamLayer, ringLayer, lightLayer (additive)
 *   │   ├─ particleLayer, textLayer, aimLine, crosshair
 *   │   └─ fovMask (stencil polygon, not rendered)
 *   └─ screenC: vignette, damage flash, minimap
 */
import { Application, Container, Graphics, Sprite, Text } from "pixi.js";
import type { TexSet } from "./textures";
import { makeTextures } from "./textures";
import { ParticlePool } from "./particles";
import { castLightPoly, rayToWall } from "../game/fov";
import { TAU, clamp, damp, hash2, lerp } from "../core/utils";
import {
  TILE,
  MAP_W,
  MAP_H,
  LIGHT_RAYS,
  TileT,
  type Anim,
  type DungeonMap,
  type GameCtx,
  type GridPos,
  type Health,
  type IFx,
  type LightComp,
  type Marker,
  type VisualComp,
} from "../game/types";

const C_CYAN = 0x00f0ff;
const C_MAGENTA = 0xff2bd6;

function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = (ar + (br - ar) * t) | 0;
  const g = (ag + (bg - ag) * t) | 0;
  const bl = (ab + (bb - ab) * t) | 0;
  return (r << 16) | (g << 8) | bl;
}

interface LightSlot {
  entity: number;
  gfx: Graphics;
  glow: Sprite;
}

interface BeamSlot {
  g: Graphics;
  life: number;
}

interface RingSlot {
  g: Graphics;
  life: number;
  maxLife: number;
  radius: number;
  x: number;
  y: number;
}

interface TextSlot {
  t: Text;
  life: number;
  maxLife: number;
}

export class Renderer implements IFx {
  private app: Application | null = null;
  private host: HTMLElement | null = null;
  private worldC = new Container();
  private screenC = new Container();
  private entityLayer = new Container();
  private beamLayer = new Container();
  private ringLayer = new Container();
  private lightLayer = new Container();
  private textLayer = new Container();
  private backplate = new Graphics();
  private tilesDim = new Graphics();
  private tilesLit = new Graphics();
  private props = new Graphics();
  private stairsGfx = new Graphics();
  private fovMask = new Graphics();
  private aimLine = new Graphics();
  private crosshair = new Graphics();
  private vignette: Sprite | null = null;
  private flashGfx = new Graphics();
  private mmBase = new Graphics();
  private mmDyn = new Graphics();
  private mmFrame = new Graphics();

  particles = new ParticlePool();
  private tex: TexSet | null = null;

  private camX = 0;
  private camY = 0;
  private zoom = 1.6;
  private shakeMag = 0;
  private snapCam = true;
  private flashAlpha = 0;
  private time = 0;
  private mmTimer = 0;

  private mouseSx = 0;
  private mouseSy = 0;
  private mouseLmb = false;
  private listeners: { el: EventTarget; type: string; fn: EventListener }[] = [];

  private lightSlots: LightSlot[] = [];
  private beams: BeamSlot[] = [];
  private rings: RingSlot[] = [];
  private texts: TextSlot[] = [];

  get canvas(): HTMLCanvasElement | null {
    return this.app?.canvas ?? null;
  }

  /* ----------------------------------------------------------- lifecycle */

  async init(host: HTMLElement): Promise<void> {
    this.host = host;
    const app = new Application();
    try {
      await app.init({
        background: "#04050c",
        antialias: true,
        width: window.innerWidth,
        height: window.innerHeight,
      });
    } catch (e) {
      throw new Error("WebGL initialization failed: " + String(e));
    }
    this.app = app;
    host.appendChild(app.canvas);
    app.canvas.style.display = "block";
    app.canvas.style.cursor = "none";
    app.ticker.stop(); // we drive rendering from our own rAF loop

    this.tex = await makeTextures();
    this.particles.init(this.tex);

    const stage = app.stage;
    stage.addChild(this.worldC);
    stage.addChild(this.screenC);
    const w = this.worldC;
    w.addChild(this.backplate);
    w.addChild(this.tilesDim);
    w.addChild(this.tilesLit);
    w.addChild(this.props);
    w.addChild(this.stairsGfx);
    w.addChild(this.entityLayer);
    w.addChild(this.lightLayer);
    w.addChild(this.beamLayer);
    w.addChild(this.ringLayer);
    w.addChild(this.particles.layer);
    w.addChild(this.textLayer);
    w.addChild(this.aimLine);
    w.addChild(this.crosshair);
    w.addChild(this.fovMask);
    this.tilesLit.mask = this.fovMask;
    const sc = this.screenC;
    sc.addChild(this.flashGfx);
    const vg = new Sprite(this.tex.vignette);
    this.vignette = vg;
    sc.addChild(vg);
    sc.addChild(this.mmFrame);
    sc.addChild(this.mmBase);
    sc.addChild(this.mmDyn);

    // effect pools (preallocated)
    for (let i = 0; i < 20; i++) {
      const gfx = new Graphics();
      const glow = new Sprite(this.tex.soft);
      glow.anchor.set(0.5);
      glow.blendMode = "add";
      this.lightLayer.addChild(gfx);
      this.lightLayer.addChild(glow);
      gfx.blendMode = "add";
      this.lightSlots.push({ entity: -1, gfx, glow });
    }
    for (let i = 0; i < 26; i++) {
      const g = new Graphics();
      g.blendMode = "add";
      g.visible = false;
      this.beamLayer.addChild(g);
      this.beams.push({ g, life: 0 });
    }
    for (let i = 0; i < 14; i++) {
      const g = new Graphics();
      g.blendMode = "add";
      g.visible = false;
      g.circle(0, 0, 1).stroke({ color: 0xffffff, width: 0.09, alpha: 1 });
      this.ringLayer.addChild(g);
      this.rings.push({ g, life: 0, maxLife: 1, radius: 1, x: 0, y: 0 });
    }
    for (let i = 0; i < 26; i++) {
      const t = new Text({
        text: "",
        style: {
          fontFamily: "Orbitron",
          fontSize: 15,
          fontWeight: "700",
          fill: 0xffffff,
        },
      });
      t.anchor.set(0.5);
      t.visible = false;
      this.textLayer.addChild(t);
      this.texts.push({ t, life: 0, maxLife: 1 });
    }

    const onMove = (e: Event): void => {
      const me = e as MouseEvent;
      this.mouseSx = me.clientX;
      this.mouseSy = me.clientY;
    };
    const onDown = (e: Event): void => {
      if ((e as MouseEvent).button === 0) this.mouseLmb = true;
    };
    const onUp = (): void => {
      this.mouseLmb = false;
    };
    const onCtx = (e: Event): void => e.preventDefault();
    const onResize = (): void => this.resize();
    this.listen(window, "mousemove", onMove);
    this.listen(window, "mousedown", onDown);
    this.listen(window, "mouseup", onUp);
    this.listen(app.canvas, "contextmenu", onCtx);
    this.listen(window, "resize", onResize);
    this.resize();
  }

  private listen(el: EventTarget, type: string, fn: EventListener): void {
    el.addEventListener(type, fn);
    this.listeners.push({ el, type, fn });
  }

  resize(): void {
    if (!this.app || !this.host) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.app.renderer.resize(w, h);
    this.zoom = clamp(w / (26 * TILE), 1.15, 2.2);
    if (this.vignette) {
      this.vignette.width = w;
      this.vignette.height = h;
    }
    this.flashGfx.clear().rect(0, 0, w, h).fill(0xffffff);
    this.flashGfx.alpha = 0;
    // minimap frame
    const S = 3;
    const mw = MAP_W * S;
    const mh = MAP_H * S;
    const mx = w - mw - 22;
    const my = 22;
    this.mmBase.x = mx;
    this.mmBase.y = my;
    this.mmDyn.x = mx;
    this.mmDyn.y = my;
    this.mmFrame.x = mx;
    this.mmFrame.y = my;
    this.mmFrame
      .clear()
      .rect(-1, -1, mw + 2, mh + 2)
      .fill({ color: 0x04060e, alpha: 0.85 })
      .rect(-6, -6, mw + 12, mh + 12)
      .stroke({ color: C_CYAN, width: 1, alpha: 0.35 });
  }

  destroy(): void {
    for (const l of this.listeners) l.el.removeEventListener(l.type, l.fn);
    this.listeners.length = 0;
    if (this.app) {
      try {
        this.app.destroy(true, { children: true, texture: false });
      } catch {
        /* already gone */
      }
      this.app = null;
    }
  }

  /* ------------------------------------------------------ floor building */

  beginFloor(map: DungeonMap): void {
    this.drawBackplate(map);
    this.redrawLit(map);
    this.redrawCrates(map);
    this.redrawMemory(map);
    this.redrawMinimapBase(map);
    this.stairsGfx.x = (map.stairsX + 0.5) * TILE;
    this.stairsGfx.y = (map.stairsY + 0.5) * TILE;
    this.snapCam = true;
    this.particles.clearAll();
    for (const b of this.beams) {
      b.life = 0;
      b.g.visible = false;
    }
    for (const r of this.rings) {
      r.life = 0;
      r.g.visible = false;
    }
    for (const t of this.texts) {
      t.life = 0;
      t.t.visible = false;
    }
  }

  private drawBackplate(map: DungeonMap): void {
    const wpx = map.w * TILE;
    const hpx = map.h * TILE;
    this.backplate
      .clear()
      .rect(-400, -400, wpx + 800, hpx + 800)
      .fill(0x020308)
      .rect(-10, -10, wpx + 20, hpx + 20)
      .stroke({ color: C_CYAN, width: 2, alpha: 0.14 });
  }

  private tileBaseColor(x: number, y: number, seed: number): number {
    const h = hash2(x, y, seed);
    const v = 13 + (h * 7) | 0;
    return (v << 16) | ((v + 6) << 8) | (v + 20);
  }

  private redrawLit(map: DungeonMap): void {
    const g = this.tilesLit;
    g.clear();
    const seed = map.floorSeed;
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const t = map.tiles[map.idx(x, y)];
        const px = x * TILE;
        const py = y * TILE;
        if (t === TileT.Wall) {
          g.rect(px, py, TILE, TILE).fill(0x070a16);
          const rim = hash2(x, y, seed + 7) < 0.5 ? C_CYAN : C_MAGENTA;
          // neon rim on faces adjacent to floor
          if (y + 1 < map.h && map.tiles[map.idx(x, y + 1)] !== TileT.Wall) {
            g.rect(px, py + TILE - 3, TILE, 3).fill({ color: rim, alpha: 0.5 });
            g.rect(px, py + TILE - 7, TILE, 4).fill({ color: rim, alpha: 0.1 });
          }
          if (x + 1 < map.w && map.tiles[map.idx(x + 1, y)] !== TileT.Wall) {
            g.rect(px + TILE - 3, py, 3, TILE).fill({ color: rim, alpha: 0.3 });
          }
          if (x - 1 >= 0 && map.tiles[map.idx(x - 1, y)] !== TileT.Wall) {
            g.rect(px, py, 3, TILE).fill({ color: rim, alpha: 0.3 });
          }
          if (y - 1 >= 0 && map.tiles[map.idx(x, y - 1)] !== TileT.Wall) {
            g.rect(px, py, TILE, 3).fill({ color: rim, alpha: 0.3 });
          }
        } else {
          g.rect(px, py, TILE, TILE).fill(this.tileBaseColor(x, y, seed));
          // faint circuit grid
          g.rect(px + TILE - 1, py, 1, TILE).fill({ color: C_CYAN, alpha: 0.045 });
          g.rect(px, py + TILE - 1, TILE, 1).fill({ color: C_CYAN, alpha: 0.045 });
          const h = hash2(x, y, seed + 31);
          if (h < 0.06) {
            g.circle(px + TILE / 2, py + TILE / 2, 2.4).fill({ color: C_CYAN, alpha: 0.22 });
          } else if (h > 0.965) {
            g.rect(px + 8, py + 8, TILE - 16, TILE - 16).stroke({ color: C_MAGENTA, width: 1, alpha: 0.12 });
          }
          if (t === TileT.Door) {
            g.rect(px + 2, py + TILE / 2 - 2, TILE - 4, 4).fill({ color: 0xffb347, alpha: 0.4 });
          } else if (t === TileT.Stairs) {
            g.rect(px + 2, py + 2, TILE - 4, TILE - 4).fill({ color: 0x0a1a26, alpha: 1 });
            g.rect(px + 5, py + 5, TILE - 10, TILE - 10).stroke({ color: C_CYAN, width: 2, alpha: 0.55 });
          } else if (t === TileT.Pillar) {
            g.rect(px + 4, py + 4, TILE - 8, TILE - 8).fill(0x0b101f);
            g.rect(px + 4, py + 4, TILE - 8, TILE - 8).stroke({ color: C_CYAN, width: 1.5, alpha: 0.35 });
            g.circle(px + TILE / 2, py + TILE / 2, 3.4).fill({ color: C_MAGENTA, alpha: 0.5 });
          }
        }
      }
    }
  }

  redrawCrates(map: DungeonMap): void {
    const g = this.props;
    g.clear();
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        if (map.tiles[map.idx(x, y)] !== TileT.Crate) continue;
        const px = x * TILE;
        const py = y * TILE;
        g.rect(px, py, TILE, TILE).fill(this.tileBaseColor(x, y, map.floorSeed));
        g.rect(px + 4, py + 4, TILE - 8, TILE - 8).fill(0x171126);
        g.rect(px + 4, py + 4, TILE - 8, TILE - 8).stroke({ color: 0xffb347, width: 1.5, alpha: 0.7 });
        g.moveTo(px + 6, py + 6).lineTo(px + TILE - 6, py + TILE - 6).stroke({ color: 0xffb347, width: 1, alpha: 0.4 });
        g.moveTo(px + TILE - 6, py + 6).lineTo(px + 6, py + TILE - 6).stroke({ color: 0xffb347, width: 1, alpha: 0.4 });
      }
    }
  }

  private redrawMemory(map: DungeonMap): void {
    const g = this.tilesDim;
    g.clear();
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        if (!map.seen[map.idx(x, y)]) continue;
        const t = map.tiles[map.idx(x, y)];
        const px = x * TILE;
        const py = y * TILE;
        if (t === TileT.Wall) {
          g.rect(px, py, TILE, TILE).fill(0x04060d);
        } else {
          g.rect(px, py, TILE, TILE).fill(0x0a0e19);
          g.rect(px + TILE - 1, py, 1, TILE).fill({ color: C_CYAN, alpha: 0.02 });
          if (t === TileT.Stairs) {
            g.rect(px + 5, py + 5, TILE - 10, TILE - 10).stroke({ color: C_CYAN, width: 1.5, alpha: 0.2 });
          }
        }
      }
    }
  }

  private redrawMinimapBase(map: DungeonMap): void {
    const g = this.mmBase;
    const S = 3;
    g.clear();
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const i = map.idx(x, y);
        if (!map.seen[i]) continue;
        const t = map.tiles[i];
        if (t === TileT.Wall) g.rect(x * S, y * S, S, S).fill(0x1c2740);
        else if (t === TileT.Stairs) g.rect(x * S, y * S, S, S).fill(0x00f0ff);
        else g.rect(x * S, y * S, S, S).fill(0x31415f);
      }
    }
  }

  /** Called by the game whenever FoV is recomputed. */
  onFovChanged(map: DungeonMap, poly: Float32Array, rays: number): void {
    const g = this.fovMask;
    g.clear();
    // polygon is in tile units → scale to px (turn-paced allocation, not per-frame)
    const pts: number[] = new Array(rays * 2);
    for (let i = 0; i < rays * 2; i++) pts[i] = poly[i] * TILE;
    g.poly(pts).fill(0xffffff);
    this.redrawMemory(map);
    this.redrawMinimapBase(map);
  }

  /* ------------------------------------------------- entity visual factory */

  makeVisual(tag: Marker["tag"], tint: number, withBar: boolean): VisualComp {
    const root = new Container();
    const glow = new Sprite(this.tex ? this.tex.soft : undefined);
    glow.anchor.set(0.5);
    glow.blendMode = "add";
    glow.tint = tint;
    let glowSize = 2.1;
    let glowAlpha = 0.4;

    const body = new Graphics();
    let ring: Graphics | null = null;
    let bobAmp = 2.2;

    if (tag === "player") {
      glowSize = 2.6;
      glowAlpha = 0.5;
      body
        .poly([0, -11, 9.5, -5.5, 9.5, 5.5, 0, 11, -9.5, 5.5, -9.5, -5.5])
        .fill({ color: 0xffffff, alpha: 0.96 })
        .poly([0, -11, 9.5, -5.5, 9.5, 5.5, 0, 11, -9.5, 5.5, -9.5, -5.5])
        .stroke({ color: C_CYAN, width: 2, alpha: 1 })
        .poly([0, -5, 4.6, 3.4, -4.6, 3.4])
        .fill({ color: C_CYAN, alpha: 0.9 });
      ring = new Graphics();
      ring
        .arc(0, 0, 15.5, 0, 1.9)
        .stroke({ color: C_CYAN, width: 2, alpha: 0.8 })
        .arc(0, 0, 15.5, 2.6, 4.0)
        .stroke({ color: C_MAGENTA, width: 2, alpha: 0.55 });
      bobAmp = 1.4;
    } else if (tag === "enemy") {
      body
        .poly([0, -11, 10, 8, 0, 3.5, -10, 8])
        .fill({ color: 0xffffff, alpha: 0.95 })
        .circle(0, -1, 3)
        .fill(0x04050c);
    } else if (tag === "loot") {
      glowSize = 1.5;
      glowAlpha = 0.5;
      body
        .poly([0, -8, 7, 0, 0, 8, -7, 0])
        .fill({ color: 0xffffff, alpha: 0.95 })
        .poly([0, -8, 7, 0, 0, 8, -7, 0])
        .stroke({ color: tint, width: 2, alpha: 1 })
        .circle(0, 0, 2.4)
        .fill(tint);
      bobAmp = 3.4;
    }

    glow.width = glowSize * TILE;
    glow.height = glowSize * TILE;
    glow.alpha = glowAlpha;
    root.addChild(glow);
    root.addChild(body);
    if (ring) root.addChild(ring);

    let bar: Graphics | null = null;
    if (withBar) {
      bar = new Graphics();
      bar.y = -19;
      root.addChild(bar);
    }

    this.entityLayer.addChild(root);
    return {
      root,
      body,
      bar,
      barHp: -1,
      tint,
      flash: 0,
      bobPhase: Math.random() * TAU,
      bobAmp,
      ring,
    };
  }

  /** Recolor an enemy visual per archetype (called after makeVisual). */
  restyleEnemy(v: VisualComp, kind: "stalker" | "sentinel" | "goliath", tint: number): void {
    const body = v.body as Graphics;
    body.clear();
    v.tint = tint;
    if (kind === "sentinel") {
      body
        .poly([0, -12, 9, 0, 0, 12, -9, 0])
        .fill({ color: 0xffffff, alpha: 0.95 })
        .poly([0, -12, 9, 0, 0, 12, -9, 0])
        .stroke({ color: tint, width: 1.5, alpha: 0.9 })
        .circle(0, 0, 3.4)
        .fill(tint);
      v.bobAmp = 3.2;
    } else if (kind === "goliath") {
      body
        .rect(-12, -12, 24, 24)
        .fill({ color: 0xffffff, alpha: 0.95 })
        .rect(-12, -12, 24, 24)
        .stroke({ color: tint, width: 2, alpha: 1 })
        .rect(-6, -6, 12, 12)
        .fill(tint)
        .rect(-2.5, -12, 5, 24)
        .fill({ color: 0x04050c, alpha: 0.8 });
      v.bobAmp = 1.2;
      v.root.scale.set(1.22);
    } else {
      body
        .poly([0, -11, 10, 8, 0, 3.5, -10, 8])
        .fill({ color: 0xffffff, alpha: 0.95 })
        .poly([0, -11, 10, 8, 0, 3.5, -10, 8])
        .stroke({ color: tint, width: 1.5, alpha: 0.8 })
        .circle(0, -1, 3)
        .fill(0x04050c);
    }
    // refresh glow tint
    const glow = v.root.children[0] as Sprite;
    glow.tint = tint;
  }

  detachVisual(e: number, visualStore: { get(id: number): VisualComp | undefined }): void {
    const v = visualStore.get(e);
    if (v) {
      this.entityLayer.removeChild(v.root);
      v.root.destroy({ children: true });
    }
  }

  /* ------------------------------------------------------------- lights */

  bindLight(e: number): void {
    for (const s of this.lightSlots) {
      if (s.entity === -1) {
        s.entity = e;
        return;
      }
    }
  }

  unbindLight(e: number): void {
    for (const s of this.lightSlots) {
      if (s.entity === e) {
        s.entity = -1;
        s.gfx.clear();
        s.glow.visible = false;
        return;
      }
    }
  }

  /* --------------------------------------------------------------- IFx */

  beam(x0: number, y0: number, x1: number, y1: number, color: number, width: number): void {
    for (const b of this.beams) {
      if (b.life > 0) continue;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy) * TILE;
      const g = b.g;
      g.clear()
        .rect(0, -width * 2.4, len, width * 4.8)
        .fill({ color, alpha: 0.22 })
        .rect(0, -width, len, width * 2)
        .fill({ color: 0xffffff, alpha: 0.85 })
        .rect(0, -width * 0.5, len, width)
        .fill({ color, alpha: 1 });
      g.x = (x0 + 0.5) * TILE;
      g.y = (y0 + 0.5) * TILE;
      g.rotation = Math.atan2(dy, dx);
      g.visible = true;
      g.alpha = 1;
      b.life = 0.16;
      return;
    }
  }

  ring(x: number, y: number, color: number, radius: number): void {
    for (const r of this.rings) {
      if (r.life > 0) continue;
      r.x = (x + 0.5) * TILE;
      r.y = (y + 0.5) * TILE;
      r.radius = Math.max(4, radius * TILE);
      r.life = 0.38;
      r.maxLife = 0.38;
      r.g.tint = color;
      r.g.visible = true;
      return;
    }
  }

  burst(x: number, y: number, color: number, count: number, speed: number, life: number, size: number): void {
    this.particles.burst(x, y, color, count, speed, life, size);
  }

  shards(x: number, y: number, color: number, count: number, power: number): void {
    this.particles.shards(x, y, color, count, power);
  }

  text(x: number, y: number, str: string, color: string, size = 15): void {
    for (const s of this.texts) {
      if (s.life > 0) continue;
      s.t.text = str;
      s.t.style.fill = color;
      s.t.style.fontSize = size;
      s.t.x = (x + 0.5) * TILE + (Math.random() - 0.5) * 10;
      s.t.y = y * TILE - 6;
      s.t.alpha = 1;
      s.t.visible = true;
      s.t.scale.set(1.25);
      s.life = 0.85;
      s.maxLife = 0.85;
      return;
    }
  }

  flash(color: number, alpha: number): void {
    this.flashGfx.tint = color;
    this.flashAlpha = Math.max(this.flashAlpha, alpha);
  }

  shake(mag: number): void {
    this.shakeMag = Math.min(26, Math.max(this.shakeMag, mag));
  }

  /* ----------------------------------------------------------- per-frame */

  update(ctx: GameCtx, dtRaw: number, dtSim: number): void {
    this.time += dtSim;
    const app = this.app;
    if (!app) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const map = ctx.map;

    /* camera */
    const posS = ctx.world.s<GridPos>("pos");
    const animS = ctx.world.s<Anim>("anim");
    const pp = posS.get(ctx.player);
    const pa = animS.get(ctx.player);
    let tx: number;
    let ty: number;
    if (ctx.state === "title") {
      tx = (map.w / 2 + Math.sin(this.time * 0.13) * map.w * 0.22) * TILE;
      ty = (map.h / 2 + Math.cos(this.time * 0.09) * map.h * 0.2) * TILE;
    } else {
      const rx = pa ? pa.rx : pp ? pp.x : map.spawnX;
      const ry = pa ? pa.ry : pp ? pp.y : map.spawnY;
      tx = (rx + 0.5) * TILE;
      ty = (ry + 0.5) * TILE;
    }
    if (this.snapCam) {
      this.camX = tx;
      this.camY = ty;
      this.snapCam = false;
    } else {
      this.camX = damp(this.camX, tx, 9, dtSim);
      this.camY = damp(this.camY, ty, 9, dtSim);
    }
    const mapPxW = map.w * TILE;
    const mapPxH = map.h * TILE;
    const halfW = w / 2 / this.zoom;
    const halfH = h / 2 / this.zoom;
    this.camX = mapPxW > halfW * 2 ? clamp(this.camX, halfW, mapPxW - halfW) : mapPxW / 2;
    this.camY = mapPxH > halfH * 2 ? clamp(this.camY, halfH, mapPxH - halfH) : mapPxH / 2;
    this.shakeMag *= Math.exp(-6.5 * dtRaw);
    if (this.shakeMag < 0.08) this.shakeMag = 0;
    const sx = (Math.random() - 0.5) * 2 * this.shakeMag;
    const sy = (Math.random() - 0.5) * 2 * this.shakeMag;
    this.worldC.position.set(w / 2 - this.camX * this.zoom + sx, h / 2 - this.camY * this.zoom + sy);
    this.worldC.scale.set(this.zoom);

    /* pointer → aim tile */
    const worldPxX = (this.mouseSx - this.worldC.position.x) / this.zoom;
    const worldPxY = (this.mouseSy - this.worldC.position.y) / this.zoom;
    ctx.input.aimX = worldPxX / TILE - 0.5;
    ctx.input.aimY = worldPxY / TILE - 0.5;
    ctx.input.lmbHeld = this.mouseLmb;

    /* entities */
    const visS = ctx.world.s<VisualComp>("visual");
    const markS = ctx.world.s<Marker>("marker");
    const hpS = ctx.world.s<Health>("hp");
    const lootPulse = 1 + Math.sin(this.time * 4.4) * 0.1;
    for (let i = 0; i < ctx.world.count; i++) {
      const e = ctx.world.ids[i];
      const v = visS.m.get(e);
      if (!v) continue;
      const p = posS.m.get(e);
      if (!p) continue;
      const a = animS.m.get(e);
      const rx = a ? a.rx : p.x;
      const ry = a ? a.ry : p.y;
      const m = markS.m.get(e);
      const tag = m ? m.tag : "";
      let targetAlpha = 1;
      if (tag === "enemy" || tag === "loot") {
        targetAlpha = map.visible[map.idx(p.x, p.y)] === 1 ? 1 : 0;
      }
      v.root.alpha = damp(v.root.alpha, targetAlpha, 14, dtSim);
      v.root.visible = v.root.alpha > 0.03;
      const bob = Math.sin(this.time * 3.1 + v.bobPhase) * v.bobAmp;
      v.root.x = (rx + 0.5) * TILE;
      v.root.y = (ry + 0.5) * TILE + bob;
      const punch = a ? a.punch : 0;
      v.body.scale.set(1 + punch * 0.35);
      if (tag === "loot") v.body.scale.set((1 + punch * 0.35) * lootPulse);
      v.flash = Math.max(0, v.flash - dtSim * 5);
      (v.body as Graphics).tint = mixColor(v.tint, 0xffffff, v.flash);
      if (v.ring) v.ring.rotation += dtSim * 2.6;
      if (tag === "enemy") {
        const hp = hpS.m.get(e);
        if (hp && v.bar && hp.hp !== v.barHp) {
          v.barHp = hp.hp;
          const bar = v.bar as Graphics;
          const frac = clamp(hp.hp / hp.max, 0, 1);
          bar
            .clear()
            .rect(-14, 0, 28, 4)
            .fill({ color: 0x04050c, alpha: 0.85 })
            .rect(-13, 0.8, 26 * frac, 2.4)
            .fill(frac > 0.45 ? C_MAGENTA : 0xff4d5e);
          bar.visible = hp.hp < hp.max;
        }
      }
    }

    /* lights */
    const lightS = ctx.world.s<LightComp>("light");
    for (const slot of this.lightSlots) {
      if (slot.entity === -1) continue;
      const lc = lightS.m.get(slot.entity);
      const p = posS.m.get(slot.entity);
      if (!lc || !p) {
        slot.entity = -1;
        slot.gfx.clear();
        slot.glow.visible = false;
        continue;
      }
      const a = animS.m.get(slot.entity);
      const cx = (a ? a.rx : p.x) + 0.5;
      const cy = (a ? a.ry : p.y) + 0.5;
      const flick = 0.86 + 0.14 * Math.sin(this.time * 7.3 + lc.phase);
      castLightPoly(map, cx, cy, lc.r, lc.poly);
      slot.gfx.clear().poly(lc.poly).fill({ color: lc.color, alpha: 0.13 * lc.base * flick });
      slot.glow.visible = true;
      slot.glow.tint = lc.color;
      slot.glow.x = cx * TILE;
      slot.glow.y = cy * TILE;
      slot.glow.width = lc.r * TILE * 1.9;
      slot.glow.height = lc.r * TILE * 1.9;
      slot.glow.alpha = 0.3 * lc.base * flick;
    }

    /* stairs pulse */
    const sp = this.stairsGfx;
    sp.clear();
    const pulse = (Math.sin(this.time * 3.2) + 1) / 2;
    sp.circle(0, 0, 6 + pulse * 3).stroke({ color: C_CYAN, width: 2, alpha: 0.7 });
    sp.circle(0, 0, 11 + pulse * 4).stroke({ color: C_MAGENTA, width: 1.5, alpha: 0.35 });
    sp.poly([0, -5, 4.5, 2.8, -4.5, 2.8]).fill({ color: C_CYAN, alpha: 0.85 });

    /* aim line + crosshair */
    const playing = ctx.state === "playing";
    this.aimLine.visible = playing;
    this.crosshair.visible = playing;
    if (playing && pp) {
      const ax = ctx.input.aimX;
      const ay = ctx.input.aimY;
      const px = pp.x + 0.5;
      const py = pp.y + 0.5;
      const d = rayToWall(map, px, py, ax, ay, 13);
      let dx = ax - px;
      let dy = ay - py;
      const dl = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= dl;
      dy /= dl;

      // snap the reticle onto the nearest visible enemy lying on the aim ray,
      // mirroring the beam's hit test so aim feedback == actual shot result
      let bestT = d;
      let locked = false;
      for (let i = 0; i < ctx.world.count; i++) {
        const e = ctx.world.ids[i];
        const m = markS.m.get(e);
        if (!m || m.tag !== "enemy") continue;
        const ep = posS.m.get(e);
        if (!ep || map.visible[map.idx(ep.x, ep.y)] !== 1) continue;
        const rx = ep.x + 0.5 - px;
        const ry = ep.y + 0.5 - py;
        const tProj = rx * dx + ry * dy;
        if (tProj < 0.2 || tProj > d) continue;
        if (Math.abs(rx * dy - ry * dx) < 0.47 && tProj < bestT) {
          bestT = tProj;
          locked = true;
        }
      }

      const lx = (px + dx * d) * TILE;
      const ly = (py + dy * d) * TILE;
      const al = this.aimLine.clear().moveTo(px * TILE, py * TILE);
      if (locked) {
        al.lineTo((px + dx * bestT) * TILE, (py + dy * bestT) * TILE)
          .stroke({ color: C_MAGENTA, width: 1.8, alpha: 0.42 })
          .moveTo(px * TILE, py * TILE)
          .lineTo(lx, ly)
          .stroke({ color: C_CYAN, width: 1.5, alpha: 0.1 });
      } else {
        al.lineTo(lx, ly).stroke({ color: C_CYAN, width: 1.5, alpha: 0.16 });
      }

      const chx = (px + dx * bestT) * TILE;
      const chy = (py + dy * bestT) * TILE;
      this.crosshair.clear();
      if (locked) {
        // target-lock reticle: pulsing ring + spinning corner brackets
        const pulse = 10.5 + Math.sin(this.time * 9) * 1.3;
        this.crosshair.circle(chx, chy, pulse).stroke({ color: C_MAGENTA, width: 1.8, alpha: 0.95 });
        this.crosshair.circle(chx, chy, 1.9).fill({ color: C_MAGENTA, alpha: 1 });
        const spin = this.time * 3.2;
        for (let k = 0; k < 4; k++) {
          const a0 = spin + (k * TAU) / 4;
          this.crosshair.arc(chx, chy, 15.5, a0, a0 + 0.75).stroke({ color: 0xffffff, width: 2.2, alpha: 0.9 });
        }
      } else {
        this.crosshair.circle(chx, chy, 7).stroke({ color: C_CYAN, width: 1.6, alpha: 0.9 });
        this.crosshair.circle(chx, chy, 1.8).fill({ color: C_MAGENTA, alpha: 0.95 });
      }
    }

    /* beams / rings / texts */
    for (const b of this.beams) {
      if (b.life <= 0) continue;
      b.life -= dtSim;
      if (b.life <= 0) {
        b.g.visible = false;
        continue;
      }
      b.g.alpha = b.life / 0.16;
    }
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dtSim;
      if (r.life <= 0) {
        r.g.visible = false;
        continue;
      }
      const t = 1 - r.life / r.maxLife;
      const s = r.radius * (0.25 + t * 0.75);
      r.g.x = r.x;
      r.g.y = r.y;
      r.g.scale.set(s);
      r.g.alpha = (1 - t) * 0.9;
    }
    for (const s of this.texts) {
      if (s.life <= 0) continue;
      s.life -= dtSim;
      if (s.life <= 0) {
        s.t.visible = false;
        continue;
      }
      const t = 1 - s.life / s.maxLife;
      s.t.y -= dtSim * 34;
      s.t.alpha = 1 - t * t;
      s.t.scale.set(1.25 - 0.25 * Math.min(1, t * 4));
    }

    /* particles & ambient dust */
    this.particles.update(dtSim);
    if (playing && Math.random() < dtSim * 26) {
      const px = pp ? pp.x : map.spawnX;
      const py = pp ? pp.y : map.spawnY;
      this.particles.dust(
        px + 0.5 + (Math.random() - 0.5) * 15,
        py + 0.5 + (Math.random() - 0.5) * 11,
        Math.random() < 0.75 ? 0x3fd9ff : 0xff77e8,
      );
    }

    /* minimap dynamic blips (throttled) */
    this.mmTimer -= dtRaw;
    if (this.mmTimer <= 0) {
      this.mmTimer = 0.12;
      const g = this.mmDyn;
      const S = 3;
      g.clear();
      for (let i = 0; i < ctx.world.count; i++) {
        const e = ctx.world.ids[i];
        const mk = markS.m.get(e);
        if (!mk || mk.tag !== "enemy") continue;
        const p = posS.m.get(e);
        if (!p) continue;
        if (map.visible[map.idx(p.x, p.y)] !== 1) continue;
        g.rect(p.x * S, p.y * S, S, S).fill(0xff2bd6);
      }
      if (pp) g.rect(pp.x * S - 0.5, pp.y * S - 0.5, S + 1, S + 1).fill(0x00f0ff);
    }

    /* screen flash decay */
    this.flashAlpha = Math.max(0, this.flashAlpha - dtRaw * 2.4);
    this.flashGfx.alpha = this.flashAlpha;

    app.render();
  }
}
