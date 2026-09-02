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
import { Application, ColorMatrixFilter, Container, Graphics, Sprite, Text } from "pixi.js";
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
  getBiome,
  type Anim,
  type DungeonMap,
  type EnemyKind,
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
  maxLife: number;
  travel: number;
  travelDur: number;
}

interface RingSlot {
  g: Graphics;
  life: number;
  maxLife: number;
  radius: number;
  x: number;
  y: number;
  style: number; // 0 normal, 1 shockwave, 2 scorch
}

interface TextSlot {
  t: Text;
  life: number;
  maxLife: number;
}

interface GhostSlot {
  g: Graphics;
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
  private shakeDx = 0;
  private shakeDy = 0;
  private rotTrauma = 0;
  private zoomPunch = 0;
  private chromaT = 0;
  private chromaKind: "emp" | "chrono" | "kill" = "emp";
  private chromaFilter: ColorMatrixFilter | null = null;
  private snapCam = true;
  private flashAlpha = 0;
  private time = 0;
  private mmTimer = 0;

  private mouseSx = typeof window !== "undefined" ? window.innerWidth / 2 : 0;
  private mouseSy = typeof window !== "undefined" ? window.innerHeight / 2 : 0;
  private mouseLmb = false;
  private listeners: { el: EventTarget; type: string; fn: EventListener }[] = [];

  private lightSlots: LightSlot[] = [];
  private beams: BeamSlot[] = [];
  private rings: RingSlot[] = [];
  private texts: TextSlot[] = [];
  private ghosts: GhostSlot[] = [];

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

    const litC = new Container();
    litC.addChild(this.tilesLit);
    litC.addChild(this.props);
    litC.addChild(this.stairsGfx);
    w.addChild(litC);

    w.addChild(this.entityLayer);
    w.addChild(this.lightLayer);
    w.addChild(this.beamLayer);
    w.addChild(this.ringLayer);
    w.addChild(this.particles.layer);
    w.addChild(this.textLayer);
    w.addChild(this.aimLine);
    w.addChild(this.crosshair);
    w.addChild(this.fovMask);
    litC.mask = this.fovMask;
    this.chromaFilter = new ColorMatrixFilter();
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
      gfx.scale.set(TILE);
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
      this.beams.push({ g, life: 0, maxLife: 0.18, travel: 1, travelDur: 0.06 });
    }
    for (let i = 0; i < 14; i++) {
      const g = new Graphics();
      g.blendMode = "add";
      g.visible = false;
      g.circle(0, 0, 1).stroke({ color: 0xffffff, width: 0.09, alpha: 1 });
      this.ringLayer.addChild(g);
      this.rings.push({ g, life: 0, maxLife: 1, radius: 1, x: 0, y: 0, style: 0 });
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
    for (let i = 0; i < 8; i++) {
      const g = new Graphics();
      g.blendMode = "add";
      g.visible = false;
      g.poly([0, -11, 9.5, -5.5, 9.5, 5.5, 0, 11, -9.5, 5.5, -9.5, -5.5])
        .stroke({ color: C_CYAN, width: 2, alpha: 0.85 });
      this.entityLayer.addChild(g);
      this.ghosts.push({ g, life: 0, maxLife: 0.22 });
    }

    this.mouseSx = window.innerWidth / 2;
    this.mouseSy = window.innerHeight / 2;

    const isOverlay = (e: Event): boolean => {
      const t = e.target;
      if (!t) return false;
      if (this.app && t === this.app.canvas) return false;
      return t instanceof HTMLElement;
    };
    const onMove = (e: Event): void => {
      if (isOverlay(e)) return;
      const me = e as MouseEvent | PointerEvent;
      this.mouseSx = me.clientX;
      this.mouseSy = me.clientY;
    };
    const onDown = (e: Event): void => {
      if (isOverlay(e)) return;
      const me = e as MouseEvent | PointerEvent;
      if (me.button === 0 || me.button === undefined) {
        this.mouseSx = me.clientX;
        this.mouseSy = me.clientY;
        this.mouseLmb = true;
      }
    };
    const onUp = (): void => {
      this.mouseLmb = false;
    };
    const onCtx = (e: Event): void => e.preventDefault();
    const onResize = (): void => this.resize();
    this.listen(window, "pointermove", onMove);
    this.listen(window, "pointerdown", onDown);
    this.listen(window, "pointerup", onUp);
    this.listen(window, "pointercancel", onUp);
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
    this.shakeMag = 0;
    this.rotTrauma = 0;
    this.zoomPunch = 0;
    this.chromaT = 0;
    this.worldC.rotation = 0;
    this.lightLayer.filters = null;
    this.beamLayer.filters = null;
    this.particles.clearAll();
    for (const b of this.beams) {
      b.life = 0;
      b.g.visible = false;
      b.g.scale.set(1);
    }
    for (const r of this.rings) {
      r.life = 0;
      r.g.visible = false;
    }
    for (const t of this.texts) {
      t.life = 0;
      t.t.visible = false;
    }
    for (const gh of this.ghosts) {
      gh.life = 0;
      gh.g.visible = false;
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
        const cx = px + TILE / 2;
        const cy = py + TILE / 2;

        if (t === TileT.Wall) {
          // Armored high-tech bulkhead wall
          g.rect(px, py, TILE, TILE).fill(0x060914);
          g.rect(px + 2, py + 2, TILE - 4, TILE - 4).fill(0x090e1e);
          g.rect(px + 4, py + 4, TILE - 8, TILE - 8).stroke({ color: 0x141f38, width: 1, alpha: 0.6 });

          const rim = hash2(x, y, seed + 7) < 0.5 ? C_CYAN : C_MAGENTA;
          // neon rim on faces adjacent to floor
          if (y + 1 < map.h && map.tiles[map.idx(x, y + 1)] !== TileT.Wall) {
            g.rect(px, py + TILE - 3, TILE, 3).fill({ color: rim, alpha: 0.85 });
            g.rect(px, py + TILE - 6, TILE, 3).fill({ color: rim, alpha: 0.2 });
          }
          if (x + 1 < map.w && map.tiles[map.idx(x + 1, y)] !== TileT.Wall) {
            g.rect(px + TILE - 3, py, 3, TILE).fill({ color: rim, alpha: 0.5 });
          }
          if (x - 1 >= 0 && map.tiles[map.idx(x - 1, y)] !== TileT.Wall) {
            g.rect(px, py, 3, TILE).fill({ color: rim, alpha: 0.5 });
          }
          if (y - 1 >= 0 && map.tiles[map.idx(x, y - 1)] !== TileT.Wall) {
            g.rect(px, py, TILE, 3).fill({ color: rim, alpha: 0.5 });
          }
        } else {
          // Cyberpunk floor tiles
          g.rect(px, py, TILE, TILE).fill(this.tileBaseColor(x, y, seed));
          // Grid panel seams
          g.rect(px + TILE - 1, py, 1, TILE).fill({ color: C_CYAN, alpha: 0.06 });
          g.rect(px, py + TILE - 1, TILE, 1).fill({ color: C_CYAN, alpha: 0.06 });

          const h = hash2(x, y, seed + 31);
          if (h < 0.08) {
            // Floor vent grate with underglow
            g.rect(px + 5, py + 7, TILE - 10, TILE - 14).fill(0x04060e).stroke({ color: C_CYAN, width: 1, alpha: 0.25 });
            for (let i = 9; i < TILE - 9; i += 3) {
              g.moveTo(px + 7, py + i).lineTo(px + TILE - 7, py + i).stroke({ color: C_CYAN, width: 1, alpha: 0.2 });
            }
          } else if (h < 0.16) {
            // Circuit trace nexus
            g.circle(cx, cy, 2.6).fill({ color: C_CYAN, alpha: 0.35 });
            g.moveTo(cx, cy).lineTo(cx + 8, cy).stroke({ color: C_CYAN, width: 1, alpha: 0.18 });
            g.moveTo(cx, cy).lineTo(cx, cy + 8).stroke({ color: C_CYAN, width: 1, alpha: 0.18 });
          } else if (h > 0.94) {
            // Neon floor decal bracket
            g.rect(px + 7, py + 7, TILE - 14, TILE - 14).stroke({ color: C_MAGENTA, width: 1, alpha: 0.18 });
          }

          if (t === TileT.Door) {
            // Pressurized security airlock door
            g.rect(px + 2, py + TILE / 2 - 3.5, TILE - 4, 7).fill(0x2a1705);
            g.rect(px + 2, py + TILE / 2 - 3.5, TILE - 4, 7).stroke({ color: 0xffb347, width: 1.5, alpha: 0.9 });
            g.rect(cx - 3, cy - 1.5, 6, 3).fill({ color: 0xffe066, alpha: 1 });
          } else if (t === TileT.Stairs) {
            // Descent stairwell
            g.rect(px + 2, py + 2, TILE - 4, TILE - 4).fill(0x06141f);
            g.rect(px + 4, py + 4, TILE - 8, TILE - 8).stroke({ color: C_CYAN, width: 2, alpha: 0.8 });
            g.rect(px + 8, py + 8, TILE - 16, TILE - 16).stroke({ color: C_MAGENTA, width: 1.5, alpha: 0.6 });
          } else if (t === TileT.Pillar) {
            // Heavy power conduit pillar
            g.poly([
              px + 6, py + 9,
              px + 9, py + 6,
              px + TILE - 9, py + 6,
              px + TILE - 6, py + 9,
              px + TILE - 6, py + TILE - 9,
              px + TILE - 9, py + TILE - 6,
              px + 9, py + TILE - 6,
              px + 6, py + TILE - 9
            ]).fill(0x080e1e);

            g.poly([
              px + 6, py + 9,
              px + 9, py + 6,
              px + TILE - 9, py + 6,
              px + TILE - 6, py + 9,
              px + TILE - 6, py + TILE - 9,
              px + TILE - 9, py + TILE - 6,
              px + 9, py + TILE - 6,
              px + 6, py + TILE - 9
            ]).stroke({ color: C_CYAN, width: 2, alpha: 0.8 });

            g.circle(cx, cy, 4).fill({ color: C_MAGENTA, alpha: 0.8 });
            g.circle(cx, cy, 1.8).fill(0xffffff);
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
        const t = map.tiles[map.idx(x, y)];
        if (
          t !== TileT.Crate &&
          t !== TileT.Barrel &&
          t !== TileT.TeslaNode &&
          t !== TileT.Acid &&
          t !== TileT.Shrine
        ) {
          continue;
        }
        const px = x * TILE;
        const py = y * TILE;
        const cx = px + TILE / 2;
        const cy = py + TILE / 2;
        g.rect(px, py, TILE, TILE).fill(this.tileBaseColor(x, y, map.floorSeed));

        if (t === TileT.Crate) {
          // Cyberpunk Heavy Cargo Crate with reinforced armor plating & glowing holographic lock
          g.poly([
            px + 4, py + 7,
            px + 7, py + 4,
            px + TILE - 7, py + 4,
            px + TILE - 4, py + 7,
            px + TILE - 4, py + TILE - 7,
            px + TILE - 7, py + TILE - 4,
            px + 7, py + TILE - 4,
            px + 4, py + TILE - 7
          ]).fill(0x130d22);

          // Outer amber frame
          g.poly([
            px + 4, py + 7,
            px + 7, py + 4,
            px + TILE - 7, py + 4,
            px + TILE - 4, py + 7,
            px + TILE - 4, py + TILE - 7,
            px + TILE - 7, py + TILE - 4,
            px + 7, py + TILE - 4,
            px + 4, py + TILE - 7
          ]).stroke({ color: 0xf59e0b, width: 1.8, alpha: 0.9 });

          // Reinforced corner brackets
          g.rect(px + 4, py + 4, 4, 4).fill({ color: 0xf59e0b, alpha: 0.9 });
          g.rect(px + TILE - 8, py + 4, 4, 4).fill({ color: 0xf59e0b, alpha: 0.9 });
          g.rect(px + 4, py + TILE - 8, 4, 4).fill({ color: 0xf59e0b, alpha: 0.9 });
          g.rect(px + TILE - 8, py + TILE - 8, 4, 4).fill({ color: 0xf59e0b, alpha: 0.9 });

          // Diagonal structural trusses
          g.moveTo(px + 8, py + 8).lineTo(px + TILE - 8, py + TILE - 8).stroke({ color: 0xf59e0b, width: 1.2, alpha: 0.35 });
          g.moveTo(px + TILE - 8, py + 8).lineTo(px + 8, py + TILE - 8).stroke({ color: 0xf59e0b, width: 1.2, alpha: 0.35 });

          // Central electronic lock mechanism
          g.rect(cx - 4, cy - 4, 8, 8).fill(0x040814).stroke({ color: 0x00f0ff, width: 1.2, alpha: 0.85 });
          g.circle(cx, cy, 2).fill({ color: 0x00f0ff, alpha: 1 });

        } else if (t === TileT.Barrel) {
          // Volatile Cyber-Canister: Octagonal containment vessel with hazard markings & glowing plasma core
          g.poly([
            px + 5, py + 8,
            px + 8, py + 5,
            px + TILE - 8, py + 5,
            px + TILE - 5, py + 8,
            px + TILE - 5, py + TILE - 8,
            px + TILE - 8, py + TILE - 5,
            px + 8, py + TILE - 5,
            px + 5, py + TILE - 8
          ]).fill(0x20070e);

          // Glowing crimson hazard frame
          g.poly([
            px + 5, py + 8,
            px + 8, py + 5,
            px + TILE - 8, py + 5,
            px + TILE - 5, py + 8,
            px + TILE - 5, py + TILE - 8,
            px + TILE - 8, py + TILE - 5,
            px + 8, py + TILE - 5,
            px + 5, py + TILE - 8
          ]).stroke({ color: 0xff2244, width: 2, alpha: 1 });

          // Top and bottom hazard warning bars
          g.rect(px + 9, py + 6, TILE - 18, 2.5).fill({ color: 0xffa500, alpha: 0.95 });
          g.rect(px + 9, py + TILE - 8.5, TILE - 18, 2.5).fill({ color: 0xffa500, alpha: 0.95 });

          // Side reinforcement struts
          g.moveTo(px + 6, py + 11).lineTo(px + 6, py + TILE - 11).stroke({ color: 0xff3b4e, width: 1.5, alpha: 0.8 });
          g.moveTo(px + TILE - 6, py + 11).lineTo(px + TILE - 6, py + TILE - 11).stroke({ color: 0xff3b4e, width: 1.5, alpha: 0.8 });

          // High-energy plasma core chamber
          g.circle(cx, cy, 6.5).fill(0x380a14).stroke({ color: 0xff4422, width: 1.2, alpha: 0.9 });
          g.circle(cx, cy, 4.2).fill({ color: 0xff5511, alpha: 0.95 });
          g.circle(cx, cy, 2.2).fill({ color: 0xfff066, alpha: 1 });

        } else if (t === TileT.TeslaNode) {
          // Tesla Electrical Relay: High-voltage capacitor pylon with induction coils & arcs
          g.poly([
            px + 6, py + 9,
            px + 9, py + 6,
            px + TILE - 9, py + 6,
            px + TILE - 6, py + 9,
            px + TILE - 6, py + TILE - 9,
            px + TILE - 9, py + TILE - 6,
            px + 9, py + TILE - 6,
            px + 6, py + TILE - 9
          ]).fill(0x051a28);

          g.poly([
            px + 6, py + 9,
            px + 9, py + 6,
            px + TILE - 9, py + 6,
            px + TILE - 6, py + 9,
            px + TILE - 6, py + TILE - 9,
            px + TILE - 9, py + TILE - 6,
            px + 9, py + TILE - 6,
            px + 6, py + TILE - 9
          ]).stroke({ color: 0x00f0ff, width: 2, alpha: 0.95 });

          // Induction coil ring
          g.circle(cx, cy, 7).stroke({ color: 0x38bdf8, width: 1.4, alpha: 0.8 });
          // Arc core
          g.circle(cx, cy, 3.8).fill({ color: 0x4df3ff, alpha: 0.95 });
          g.circle(cx, cy, 1.8).fill(0xffffff);

          // Electrostatic discharge needles
          g.moveTo(cx, py + 2).lineTo(cx, py + 6).stroke({ color: 0x4df3ff, width: 2, alpha: 0.85 });
          g.moveTo(cx, py + TILE - 6).lineTo(cx, py + TILE - 2).stroke({ color: 0x4df3ff, width: 2, alpha: 0.85 });
          g.moveTo(px + 2, cy).lineTo(px + 6, cy).stroke({ color: 0x4df3ff, width: 2, alpha: 0.85 });
          g.moveTo(px + TILE - 6, cy).lineTo(px + TILE - 2, cy).stroke({ color: 0x4df3ff, width: 2, alpha: 0.85 });

        } else if (t === TileT.Acid) {
          // Bio-Hazard Acid Pool: Corrosive sludge with toxic bubbles
          g.rect(px + 2, py + 2, TILE - 4, TILE - 4).fill({ color: 0x041f0b, alpha: 0.9 });
          g.rect(px + 2, py + 2, TILE - 4, TILE - 4).stroke({ color: 0x22c55e, width: 1.5, alpha: 0.8 });
          g.circle(px + 9, py + 11, 2.8).fill({ color: 0x86efac, alpha: 0.95 });
          g.circle(px + 21, py + 18, 3.5).fill({ color: 0x4ade80, alpha: 0.9 });
          g.circle(px + 22, py + 9, 2.0).fill({ color: 0x86efac, alpha: 0.8 });
          g.circle(px + 11, py + 22, 2.2).fill({ color: 0x4ade80, alpha: 0.85 });

        } else if (t === TileT.Shrine) {
          // Overclock Hologram Shrine: Futuristic data altar with glowing gold glyphs
          g.rect(px + 3, py + 3, TILE - 6, TILE - 6).fill(0x1c1303);
          g.rect(px + 3, py + 3, TILE - 6, TILE - 6).stroke({ color: 0xfbbf24, width: 2, alpha: 0.95 });
          g.rect(px + 7, py + 7, TILE - 14, TILE - 14).stroke({ color: 0xfde047, width: 1.2, alpha: 0.6 });
          // Floating hologram diamond
          g.poly([cx, cy - 6, cx + 5, cy, cx, cy + 6, cx - 5, cy]).fill({ color: 0xfef08a, alpha: 0.95 });
          g.poly([cx, cy - 3, cx + 2.5, cy, cx, cy + 3, cx - 2.5, cy]).fill(0xffffff);
        }
      }
    }
  }

  private redrawMemory(map: DungeonMap): void {
    const g = this.tilesDim;
    g.clear();
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const idx = map.idx(x, y);
        if (!map.seen[idx]) continue;
        const t = map.tiles[idx];
        const px = x * TILE;
        const py = y * TILE;
        const cx = px + TILE / 2;
        const cy = py + TILE / 2;
        if (t === TileT.Wall) {
          g.rect(px, py, TILE, TILE).fill(0x04060d);
        } else {
          g.rect(px, py, TILE, TILE).fill(0x0a0e19);
          g.rect(px + TILE - 1, py, 1, TILE).fill({ color: C_CYAN, alpha: 0.02 });
          if (t === TileT.Stairs) {
            g.rect(px + 5, py + 5, TILE - 10, TILE - 10).stroke({ color: C_CYAN, width: 1.5, alpha: 0.25 });
          } else if (t === TileT.Crate) {
            g.rect(px + 6, py + 6, TILE - 12, TILE - 12).stroke({ color: 0xf59e0b, width: 1, alpha: 0.2 });
          } else if (t === TileT.Barrel) {
            g.rect(px + 6, py + 6, TILE - 12, TILE - 12).stroke({ color: 0xff3344, width: 1, alpha: 0.2 });
            g.circle(cx, cy, 3).stroke({ color: 0xff3344, width: 1, alpha: 0.18 });
          } else if (t === TileT.TeslaNode) {
            g.rect(px + 6, py + 6, TILE - 12, TILE - 12).stroke({ color: 0x00f0ff, width: 1, alpha: 0.2 });
          } else if (t === TileT.Shrine) {
            g.rect(px + 6, py + 6, TILE - 12, TILE - 12).stroke({ color: 0xfbbf24, width: 1, alpha: 0.22 });
          } else if (t === TileT.Acid) {
            g.rect(px + 4, py + 4, TILE - 8, TILE - 8).stroke({ color: 0x22c55e, width: 1, alpha: 0.18 });
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
    let ring: Container | null = null;
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
      ring = new Container();
      const ringCyan = new Graphics();
      ringCyan.arc(0, 0, 15.5, 0, 1.9).stroke({ color: C_CYAN, width: 2, alpha: 0.8 });
      const ringMagenta = new Graphics();
      ringMagenta.arc(0, 0, 15.5, 2.6, 4.0).stroke({ color: C_MAGENTA, width: 2, alpha: 0.55 });
      ring.addChild(ringCyan);
      ring.addChild(ringMagenta);
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
  restyleEnemy(v: VisualComp, kind: EnemyKind, tint: number): void {
    const body = v.body as Graphics;
    body.clear();
    v.tint = tint;
    v.root.scale.set(1);

    if (kind === "sentinel") {
      // Hovering diamond sniper drone with sensor wings & glowing aperture
      body
        .poly([0, -13, 10, 0, 0, 13, -10, 0])
        .fill({ color: 0x09121f, alpha: 0.95 })
        .poly([0, -13, 10, 0, 0, 13, -10, 0])
        .stroke({ color: tint, width: 1.8, alpha: 1 })
        .poly([0, -7, 5.5, 0, 0, 7, -5.5, 0])
        .fill({ color: tint, alpha: 0.85 })
        .circle(0, 0, 2.2)
        .fill(0xffffff)
        .moveTo(-13, 0).lineTo(-10, 0).stroke({ color: tint, width: 1.5, alpha: 0.9 })
        .moveTo(10, 0).lineTo(13, 0).stroke({ color: tint, width: 1.5, alpha: 0.9 });
      v.bobAmp = 3.0;
    } else if (kind === "goliath") {
      // Heavy armored juggernaut mech chassis with front blast shield & glowing reactor
      body
        .poly([
          -13, -8, -8, -13, 8, -13, 13, -8,
          13, 8, 8, 13, -8, 13, -13, 8
        ])
        .fill({ color: 0x180a0e, alpha: 0.96 })
        .poly([
          -13, -8, -8, -13, 8, -13, 13, -8,
          13, 8, 8, 13, -8, 13, -13, 8
        ])
        .stroke({ color: tint, width: 2.2, alpha: 1 })
        // Armor shoulder plating
        .rect(-11, -11, 4, 4).fill({ color: tint, alpha: 0.9 })
        .rect(7, -11, 4, 4).fill({ color: tint, alpha: 0.9 })
        .rect(-11, 7, 4, 4).fill({ color: tint, alpha: 0.9 })
        .rect(7, 7, 4, 4).fill({ color: tint, alpha: 0.9 })
        // Central power reactor
        .circle(0, 0, 6).fill(0x350d18).stroke({ color: tint, width: 1.5, alpha: 1 })
        .circle(0, 0, 3.2).fill({ color: 0xff3b4e, alpha: 1 })
        .circle(0, 0, 1.4).fill(0xffffff);
      v.bobAmp = 1.0;
      v.root.scale.set(1.25);
    } else if (kind === "phantom") {
      // Ethereal phase-shifting cyber-spectre
      body
        .poly([0, -14, 9, -5, 12, 4, 0, 13, -12, 4, -9, -5])
        .fill({ color: 0x160826, alpha: 0.92 })
        .poly([0, -14, 9, -5, 12, 4, 0, 13, -12, 4, -9, -5])
        .stroke({ color: tint, width: 1.8, alpha: 1 })
        .poly([0, -8, 6, -2, 7, 3, 0, 8, -7, 3, -6, -2])
        .fill({ color: tint, alpha: 0.45 })
        .circle(0, 0, 2.4)
        .fill(0xffffff);
      v.bobAmp = 3.0;
    } else if (kind === "skitterer") {
      // Fast quad-drone swarmer
      body
        .poly([0, -10, 8, 7, -8, 7])
        .fill({ color: 0x0f1806, alpha: 0.95 })
        .poly([0, -10, 8, 7, -8, 7])
        .stroke({ color: tint, width: 1.6, alpha: 1 })
        .circle(0, 1, 2.5)
        .fill({ color: tint, alpha: 0.9 })
        .circle(0, 1, 1.2)
        .fill(0xffffff);
      v.bobAmp = 1.6;
      v.root.scale.set(0.9);
    } else if (kind === "sentry") {
      // Shield-generator defensive pylon
      body
        .poly([0, -12, 10, -6, 10, 6, 0, 12, -10, 6, -10, -6])
        .fill({ color: 0x051624, alpha: 0.95 })
        .poly([0, -12, 10, -6, 10, 6, 0, 12, -10, 6, -10, -6])
        .stroke({ color: tint, width: 2, alpha: 1 })
        .circle(0, 0, 4.5)
        .stroke({ color: 0x00f0ff, width: 1.5, alpha: 0.9 })
        .circle(0, 0, 2.2)
        .fill({ color: 0x00f0ff, alpha: 1 });
      v.bobAmp = 1.8;
    } else if (kind === "boss_warden") {
      // Apex Cyber-Dreadnought Boss
      body
        .rect(-18, -18, 36, 36)
        .fill({ color: 0x1f040d, alpha: 0.98 })
        .rect(-18, -18, 36, 36)
        .stroke({ color: tint, width: 2.6, alpha: 1 })
        // Dual heavy rail cannons
        .rect(-21, -5, 6, 10).fill(0xffffff).stroke({ color: tint, width: 1.2 })
        .rect(15, -5, 6, 10).fill(0xffffff).stroke({ color: tint, width: 1.2 })
        // Armored corner plates
        .rect(-16, -16, 6, 6).fill({ color: tint, alpha: 0.8 })
        .rect(10, -16, 6, 6).fill({ color: tint, alpha: 0.8 })
        .rect(-16, 10, 6, 6).fill({ color: tint, alpha: 0.8 })
        .rect(10, 10, 6, 6).fill({ color: tint, alpha: 0.8 })
        // Core eye
        .circle(0, 0, 11).fill({ color: 0x3d0615, alpha: 1 }).stroke({ color: 0xff0055, width: 1.8 })
        .circle(0, 0, 6.5).fill({ color: 0xff0055, alpha: 0.95 })
        .circle(0, 0, 3).fill(0xffffff);
      v.bobAmp = 0.8;
      v.root.scale.set(1.55);
    } else {
      // Default Stalker
      body
        .poly([0, -12, 10, 8, 0, 3.5, -10, 8])
        .fill({ color: 0x180612, alpha: 0.95 })
        .poly([0, -12, 10, 8, 0, 3.5, -10, 8])
        .stroke({ color: tint, width: 1.8, alpha: 1 })
        .poly([0, -6, 5, 4, 0, 1.5, -5, 4])
        .fill({ color: tint, alpha: 0.8 })
        .circle(0, -1, 2.2)
        .fill(0xffffff);
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
      // pure neon beam — no white core; glow → mid → solid color
      const g = b.g;
      g.clear()
        .rect(0, -width * 2.6, len, width * 5.2)
        .fill({ color, alpha: 0.16 })
        .rect(0, -width * 1.2, len, width * 2.4)
        .fill({ color, alpha: 0.5 })
        .rect(0, -width * 0.55, len, width * 1.1)
        .fill({ color, alpha: 1 });
      g.x = (x0 + 0.5) * TILE;
      g.y = (y0 + 0.5) * TILE;
      g.rotation = Math.atan2(dy, dx);
      g.scale.set(0.08, 1);
      g.visible = true;
      g.alpha = 1;
      b.travel = 0;
      b.travelDur = 0.04 + Math.random() * 0.04; // 40–80ms travel lerp
      b.maxLife = 0.18;
      b.life = 0.18;
      return;
    }
  }

  ring(x: number, y: number, color: number, radius: number): void {
    this.spawnRing(x, y, color, radius, 0);
  }

  private spawnRing(x: number, y: number, color: number, radius: number, style: number): void {
    for (const r of this.rings) {
      if (r.life > 0) continue;
      r.x = (x + 0.5) * TILE;
      r.y = (y + 0.5) * TILE;
      r.radius = Math.max(4, radius * TILE);
      r.style = style;
      const life = style === 1 ? 0.52 : style === 2 ? 0.7 : 0.38;
      r.life = life;
      r.maxLife = life;
      r.g.tint = color;
      r.g.visible = true;
      return;
    }
  }

  burst(x: number, y: number, color: number, count: number, speed: number, life: number, size: number): void {
    this.particles.burst(x, y, color, count, speed, life, size);
  }

  shards(x: number, y: number, color: number, count: number, power: number, hang = false): void {
    this.particles.shards(x, y, color, count, power, hang);
    if (hang) this.particles.scorch(x, y, color);
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

  shake(mag: number, dx?: number, dy?: number): void {
    const capped = Math.min(18, mag);
    this.shakeMag = Math.min(18, Math.max(this.shakeMag, capped));
    if (dx !== undefined && dy !== undefined && (dx !== 0 || dy !== 0)) {
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      this.shakeDx = dx / len;
      this.shakeDy = dy / len;
      this.rotTrauma = clamp((this.shakeDy - this.shakeDx) * capped * 0.0016, -0.028, 0.028);
    } else if (this.shakeDx === 0 && this.shakeDy === 0) {
      this.shakeDx = Math.random() - 0.5;
      this.shakeDy = Math.random() - 0.5;
    }
    if (capped >= 10) {
      this.zoomPunch = Math.min(0.07, Math.max(this.zoomPunch, capped * 0.004));
    }
  }

  spray(x: number, y: number, ang: number, spread: number, color: number, count: number, speed: number, life: number, size: number): void {
    this.particles.spray(x, y, ang, spread, color, count, speed, life, size);
  }

  ghost(x: number, y: number, color: number): void {
    for (const gh of this.ghosts) {
      if (gh.life > 0) continue;
      gh.g.x = (x + 0.5) * TILE;
      gh.g.y = (y + 0.5) * TILE;
      gh.g.scale.set(1);
      gh.g.tint = color;
      gh.g.alpha = 0.7;
      gh.g.visible = true;
      gh.life = 0.22;
      gh.maxLife = 0.22;
      return;
    }
  }

  shockwave(x: number, y: number, color: number, radius: number): void {
    this.spawnRing(x, y, color, radius, 1);
    this.spawnRing(x, y, mixColor(color, 0xffffff, 0.35), radius * 0.55, 1);
  }

  chroma(kind: "emp" | "chrono" | "kill"): void {
    this.chromaKind = kind;
    const dur = kind === "emp" ? 0.28 : kind === "chrono" ? 0.22 : 0.12;
    this.chromaT = Math.max(this.chromaT, dur);
    if (kind === "emp" || kind === "kill") {
      this.zoomPunch = Math.min(0.07, Math.max(this.zoomPunch, kind === "emp" ? 0.05 : 0.04));
    }
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
    this.shakeMag *= Math.exp(-7.2 * dtRaw);
    if (this.shakeMag < 0.08) {
      this.shakeMag = 0;
      this.shakeDx = 0;
      this.shakeDy = 0;
    }
    this.rotTrauma *= Math.exp(-8.5 * dtRaw);
    if (Math.abs(this.rotTrauma) < 0.0008) this.rotTrauma = 0;
    this.zoomPunch *= Math.exp(-10 * dtRaw);
    if (this.zoomPunch < 0.001) this.zoomPunch = 0;
    const dirW = 0.78;
    const noiseW = 0.22;
    const sx = (this.shakeDx * dirW + (Math.random() - 0.5) * 2 * noiseW) * this.shakeMag;
    const sy = (this.shakeDy * dirW + (Math.random() - 0.5) * 2 * noiseW) * this.shakeMag;
    const z = this.zoom * (1 + this.zoomPunch);
    this.worldC.pivot.set(this.camX, this.camY);
    this.worldC.position.set(w / 2 + sx, h / 2 + sy);
    this.worldC.scale.set(z);
    this.worldC.rotation = this.rotTrauma;

    /* pointer → aim tile (ignore tiny rotational trauma for aim) */
    const worldPxX = this.camX + (this.mouseSx - (w / 2 + sx)) / z;
    const worldPxY = this.camY + (this.mouseSy - (h / 2 + sy)) / z;
    ctx.input.aimX = worldPxX / TILE;
    ctx.input.aimY = worldPxY / TILE;
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
      if (tag === "player" && punch > 0) {
        const adx = Math.abs(ctx.stats.lastDx);
        const ady = Math.abs(ctx.stats.lastDy);
        if (adx >= ady) v.body.scale.set(1 + punch * 0.48, 1 - punch * 0.26);
        else v.body.scale.set(1 - punch * 0.26, 1 + punch * 0.48);
      } else if (tag === "loot") {
        v.body.scale.set((1 + punch * 0.35) * lootPulse);
      } else {
        v.body.scale.set(1 + punch * 0.35);
      }
      // hit feedback brightens toward a lit-up version of the entity's own
      // color — never a full white-out
      v.flash = Math.max(0, v.flash - dtSim * 5);
      const lit = mixColor(v.tint, 0xffffff, 0.45);
      (v.body as Graphics).tint = mixColor(v.tint, lit, v.flash);
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
      const pa = animS.get(ctx.player);
      const prx = pa ? pa.rx : pp.x;
      const pry = pa ? pa.ry : pp.y;
      const px = prx + 0.5;
      const py = pry + 0.5;
      const d = rayToWall(map, px, py, ax, ay, 13);
      let dx = ax - px;
      let dy = ay - py;
      const dl = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= dl;
      dy /= dl;

      let bestT = d;
      let locked = false;
      let lockedCenterX = 0;
      let lockedCenterY = 0;

      // 1. Check shootable map props (Barrels, TeslaNodes, Crates) along aim ray or mouse hover
      const maxCheckDist = Math.min(d, dl + 1.2);
      for (let t = 0.4; t <= maxCheckDist; t += 0.35) {
        const gx = Math.floor(px + dx * t);
        const gy = Math.floor(py + dy * t);
        if (!map.inBounds(gx, gy)) break;
        if (map.visible[map.idx(gx, gy)] !== 1) continue;
        const tile = map.tiles[map.idx(gx, gy)];
        if (tile === TileT.Barrel || tile === TileT.TeslaNode || tile === TileT.Crate) {
          const rx = gx + 0.5 - px;
          const ry = gy + 0.5 - py;
          const tProj = rx * dx + ry * dy;
          if (tProj > 0.2 && tProj < bestT + 0.25) {
            const perp = Math.abs(rx * dy - ry * dx);
            if (perp < 0.6) {
              bestT = tProj;
              locked = true;
              lockedCenterX = (gx + 0.5) * TILE;
              lockedCenterY = (gy + 0.5) * TILE;
              break;
            }
          }
        }
      }

      // 2. Check visible enemies along the aim ray
      for (let i = 0; i < ctx.world.count; i++) {
        const e = ctx.world.ids[i];
        const m = markS.m.get(e);
        if (!m || m.tag !== "enemy") continue;
        const ep = posS.m.get(e);
        if (!ep || map.visible[map.idx(ep.x, ep.y)] !== 1) continue;
        const ea = animS.m.get(e);
        const erx = ea ? ea.rx : ep.x;
        const ery = ea ? ea.ry : ep.y;
        const rx = erx + 0.5 - px;
        const ry = ery + 0.5 - py;
        const tProj = rx * dx + ry * dy;
        if (tProj < 0.2 || tProj > d) continue;
        const perp = Math.abs(rx * dy - ry * dx);
        if (perp < 0.58 && tProj <= bestT + 0.1) {
          bestT = tProj;
          locked = true;
          lockedCenterX = (erx + 0.5) * TILE;
          lockedCenterY = (ery + 0.5) * TILE;
        }
      }

      const lx = locked ? lockedCenterX : (px + dx * d) * TILE;
      const ly = locked ? lockedCenterY : (py + dy * d) * TILE;

      this.aimLine.clear();
      this.aimLine
        .beginPath()
        .moveTo(px * TILE, py * TILE)
        .lineTo(lx, ly)
        .stroke({
          color: locked ? C_MAGENTA : C_CYAN,
          width: 1.5,
          alpha: locked ? 0.45 : 0.18,
        });

      const chx = locked ? lockedCenterX : Math.min(worldPxX, lx);
      const chy = locked ? lockedCenterY : Math.min(worldPxY, ly);
      const actualChx = locked ? lockedCenterX : (dl <= d ? worldPxX : lx);
      const actualChy = locked ? lockedCenterY : (dl <= d ? worldPxY : ly);

      this.crosshair.clear();
      if (locked) {
        // High-tech target-lock frame
        const pulse = 13 + Math.sin(this.time * 9.5) * 1.5;
        const bSize = 14;
        const bArm = 4.5;
        // Top-Left
        this.crosshair.moveTo(chx - bSize, chy - bSize + bArm).lineTo(chx - bSize, chy - bSize).lineTo(chx - bSize + bArm, chy - bSize).stroke({ color: C_MAGENTA, width: 2, alpha: 0.95 });
        // Top-Right
        this.crosshair.moveTo(chx + bSize - bArm, chy - bSize).lineTo(chx + bSize, chy - bSize).lineTo(chx + bSize, chy - bSize + bArm).stroke({ color: C_MAGENTA, width: 2, alpha: 0.95 });
        // Bottom-Left
        this.crosshair.moveTo(chx - bSize, chy + bSize - bArm).lineTo(chx - bSize, chy + bSize).lineTo(chx - bSize + bArm, chy + bSize).stroke({ color: C_MAGENTA, width: 2, alpha: 0.95 });
        // Bottom-Right
        this.crosshair.moveTo(chx + bSize - bArm, chy + bSize).lineTo(chx + bSize, chy + bSize).lineTo(chx + bSize, chy + bSize - bArm).stroke({ color: C_MAGENTA, width: 2, alpha: 0.95 });
        // Inner pulsing lock ring & center diamond
        this.crosshair.circle(chx, chy, pulse).stroke({ color: C_MAGENTA, width: 1.4, alpha: 0.8 });
        this.crosshair.poly([chx, chy - 3.5, chx + 3.5, chy, chx, chy + 3.5, chx - 3.5, chy]).fill({ color: 0xffffff, alpha: 0.95 });
      } else {
        // Precise tactical reticle
        this.crosshair.circle(actualChx, actualChy, 7.5).stroke({ color: C_CYAN, width: 1.5, alpha: 0.9 });
        this.crosshair.circle(actualChx, actualChy, 1.8).fill({ color: C_MAGENTA, alpha: 0.95 });
        this.crosshair.moveTo(actualChx - 11, actualChy).lineTo(actualChx - 6, actualChy).stroke({ color: C_CYAN, width: 1.2, alpha: 0.75 });
        this.crosshair.moveTo(actualChx + 6, actualChy).lineTo(actualChx + 11, actualChy).stroke({ color: C_CYAN, width: 1.2, alpha: 0.75 });
        this.crosshair.moveTo(actualChx, actualChy - 11).lineTo(actualChx, actualChy - 6).stroke({ color: C_CYAN, width: 1.2, alpha: 0.75 });
        this.crosshair.moveTo(actualChx, actualChy + 6).lineTo(actualChx, actualChy + 11).stroke({ color: C_CYAN, width: 1.2, alpha: 0.75 });
      }
    }

    /* beams / rings / texts / ghosts */
    for (const b of this.beams) {
      if (b.life <= 0) continue;
      if (b.travel < 1) {
        b.travel = Math.min(1, b.travel + dtSim / b.travelDur);
        b.g.scale.x = b.travel;
      }
      b.life -= dtSim;
      if (b.life <= 0) {
        b.g.visible = false;
        b.g.scale.set(1);
        continue;
      }
      b.g.alpha = b.life / b.maxLife;
    }
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dtSim;
      if (r.life <= 0) {
        r.g.visible = false;
        continue;
      }
      const t = 1 - r.life / r.maxLife;
      let s: number;
      let a: number;
      if (r.style === 1) {
        s = r.radius * (0.08 + t * 1.12);
        a = (1 - t) * 0.95;
      } else if (r.style === 2) {
        s = r.radius * (0.55 + t * 0.4);
        a = (1 - t * t) * 0.55;
      } else {
        s = r.radius * (0.25 + t * 0.75);
        a = (1 - t) * 0.9;
      }
      r.g.x = r.x;
      r.g.y = r.y;
      r.g.scale.set(s);
      r.g.alpha = a;
    }
    for (const gh of this.ghosts) {
      if (gh.life <= 0) continue;
      gh.life -= dtRaw;
      if (gh.life <= 0) {
        gh.g.visible = false;
        continue;
      }
      const t = 1 - gh.life / gh.maxLife;
      gh.g.alpha = (1 - t) * 0.7;
      gh.g.scale.set(1 + t * 0.12);
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

    /* cheap chromatic kick — ColorMatrix on light+beam only, never the full scene */
    if (this.chromaT > 0) {
      this.chromaT = Math.max(0, this.chromaT - dtRaw);
      const dur = this.chromaKind === "emp" ? 0.28 : this.chromaKind === "chrono" ? 0.22 : 0.12;
      const k = clamp(this.chromaT / dur, 0, 1);
      const f = this.chromaFilter;
      if (f) {
        f.reset();
        if (this.chromaKind === "emp") {
          f.hue(26 * k, true);
          f.saturate(0.5 * k, true);
        } else if (this.chromaKind === "chrono") {
          f.hue(-20 * k, true);
          f.saturate(0.35 * k, true);
        } else {
          f.saturate(0.4 * k, true);
        }
        if (!this.lightLayer.filters) {
          this.lightLayer.filters = [f];
          this.beamLayer.filters = [f];
        }
      }
    } else if (this.lightLayer.filters) {
      this.lightLayer.filters = null;
      this.beamLayer.filters = null;
    }

    app.render();
  }
}
