/**
 * Game — the composition root.
 * Owns the ECS world, systems ordering, renderer, audio, input listeners and
 * the requestAnimationFrame loop. Implements GameCtx so systems stay
 * decoupled from this class's internals.
 */
import { World } from "../core/ecs";
import { Logger, Rng, SpatialHash, clamp } from "../core/utils";
import { DungeonGen, generateFloor, type FloorPlan } from "./dungeon";
import { Renderer } from "../render/renderer";
import { SynthSfx } from "./audio";
import {
  animationSystem,
  bindStores,
  enemyTurnSystem,
  inputSystem,
  queueMoveIntent,
  recomputeFov,
  runPlayerIntents,
  snapAnim,
  RELIC_NAMES,
  WEAPON_PREFIX,
  WEAPON_TABLE,
  type RepeatState,
} from "./systems";
import {
  FOV_RAYS,
  LIGHT_RAYS,
  MAP_H,
  MAP_W,
  TILE,
  TileT,
  type AIComp,
  type Anim,
  type EnemyKind,
  type GState,
  type GameCtx,
  type GridPos,
  type Health,
  type InputState,
  type LightComp,
  type LootComp,
  type Marker,
  type PlayerStats,
  type Snap,
  type VisualComp,
} from "./types";

const ENEMY_TINT: Record<EnemyKind, number> = {
  stalker: 0xff2bd6,
  sentinel: 0xb967ff,
  goliath: 0xff5c33,
};
const ENEMY_SCORE: Record<EnemyKind, number> = { stalker: 100, sentinel: 150, goliath: 300 };

const freshStats = (): PlayerStats => ({
  hp: 100,
  maxHp: 100,
  en: 100,
  maxEn: 100,
  armor: 0,
  enRegen: 0,
  lifesteal: 0,
  kills: 0,
  score: 0,
  weapon: { ...WEAPON_TABLE[0] },
  pierce: false,
  onStairs: false,
  dashCd: 0,
  fireCd: 0,
  invuln: 0,
  lastDx: 1,
  lastDy: 0,
});

export class Game implements GameCtx {
  world = new World();
  map = new DungeonGen();
  hash = new SpatialHash(MAP_W, MAP_H);
  renderer = new Renderer();
  private sfxImpl = new SynthSfx();
  sfx = this.sfxImpl;
  private plan: FloorPlan = { rooms: [], enemySpawns: [], lootSpawns: [], vents: [] };
  private stores!: ReturnType<typeof bindStores>;
  private fovPoly = new Float32Array(FOV_RAYS * 2);
  private rngInstance = new Rng((Date.now() ^ 0x5bf03635) >>> 0);
  rng = (): number => this.rngInstance.next();

  player = 0;
  stats: PlayerStats = freshStats();
  floor = 1;
  turn = 0;
  time = 0;
  state: GState = "title";
  input: InputState = {
    aimX: 0,
    aimY: 0,
    lmbHeld: false,
    moveQueue: new Int8Array(8),
    moveCount: 0,
    wantShoot: false,
    wantDash: false,
    wantWait: false,
    wantDescend: false,
  };

  private keys = new Set<string>();
  private repeat: RepeatState = { t: 0 };
  private hitstopT = 0;
  private timeScale = 1;
  private targetTimeScale = 1;
  private deathT = 0;
  private transT = 0;
  private runTime = 0;
  private hudT = 0;
  private bannerKey = 0;
  private banner = "";
  private dmgPulse = 0;
  private muted = false;
  private raf = 0;
  private lastT = 0;
  private destroyed = false;
  private onSnap: (s: Snap) => void;
  private host: HTMLElement;
  private listeners: { el: EventTarget; type: string; fn: EventListener }[] = [];

  constructor(host: HTMLElement, onSnap: (s: Snap) => void) {
    this.host = host;
    this.onSnap = onSnap;
  }

  /* ----------------------------------------------------------- lifecycle */

  async boot(): Promise<void> {
    try {
      await this.renderer.init(this.host);
    } catch (e) {
      Logger.error(e);
      this.host.innerHTML =
        '<div style="color:#ff4d5e;font-family:monospace;padding:40px">WebGL init failed — this browser cannot run NEON LABYRINTH.</div>';
      return;
    }
    if (this.destroyed) return;
    this.stores = bindStores(this.world);
    this.bindInput();
    this.loadFloor(1); // attract-mode dungeon behind the title
    this.state = "title";
    this.pushHud();
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const l of this.listeners) l.el.removeEventListener(l.type, l.fn);
    this.listeners.length = 0;
    this.renderer.destroy();
    this.sfxImpl.destroy();
  }

  private bindInput(): void {
    const kd = (ev: Event): void => {
      const e = ev as KeyboardEvent;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      if (e.repeat) return;
      switch (e.code) {
        case "KeyW": case "ArrowUp": queueMoveIntent(this, 0, -1); break;
        case "KeyS": case "ArrowDown": queueMoveIntent(this, 0, 1); break;
        case "KeyA": case "ArrowLeft": queueMoveIntent(this, -1, 0); break;
        case "KeyD": case "ArrowRight": queueMoveIntent(this, 1, 0); break;
        case "Space": this.input.wantDash = true; break;
        case "KeyR": this.input.wantWait = true; break;
        case "KeyE": this.input.wantDescend = true; break;
        case "KeyM": this.toggleMute(); break;
        case "Escape":
          if (this.state === "playing") this.setState("paused");
          else if (this.state === "paused") this.setState("playing");
          break;
        case "Enter":
          if (this.state === "title" || this.state === "dead") this.startRun();
          break;
      }
    };
    const ku = (ev: Event): void => {
      this.keys.delete((ev as KeyboardEvent).code);
    };
    const blur = (): void => {
      this.keys.clear();
      if (this.state === "playing") this.setState("paused");
    };
    this.listen(window, "keydown", kd);
    this.listen(window, "keyup", ku);
    this.listen(window, "blur", blur);
  }

  private listen(el: EventTarget, type: string, fn: EventListener): void {
    el.addEventListener(type, fn);
    this.listeners.push({ el, type, fn });
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.sfxImpl.setMuted(this.muted);
    this.pushHud();
  }

  /** Drop back to the attract screen, keeping a drifting dungeon behind it. */
  abandonRun(): void {
    this.sfxImpl.stopDrone();
    this.loadFloor(this.rngInstance.int(1, 99));
    this.state = "title";
    this.banner = "";
    this.pushHud();
  }

  setState(s: GState): void {
    if (this.state === s) return;
    this.state = s;
    if (s === "paused") this.sfx.play("ui");
    if (s === "playing") this.clearInputQueue();
    this.pushHud();
  }

  private clearInputQueue(): void {
    this.input.moveCount = 0;
    this.input.wantDash = false;
    this.input.wantWait = false;
    this.input.wantDescend = false;
    this.input.wantShoot = false;
  }

  /* ------------------------------------------------------------ new run */

  startRun(): void {
    this.sfxImpl.ensure();
    this.sfxImpl.startDrone();
    this.sfx.play("ui");
    this.stats = freshStats();
    this.floor = 1;
    this.turn = 0;
    this.runTime = 0;
    this.targetTimeScale = 1;
    this.timeScale = 1;
    this.hitstopT = 0;
    this.banner = "SECTOR 01";
    this.bannerKey++;
    this.loadFloor(1);
    this.state = "playing";
    this.clearInputQueue();
    this.fx.flash(0x8ffcff, 0.35);
    this.pushHud();
  }

  /* -------------------------------------------------------------- floors */

  private clearEntities(): void {
    for (let i = 0; i < this.world.count; i++) {
      const e = this.world.ids[i];
      this.renderer.unbindLight(e);
      this.renderer.detachVisual(e, this.stores.vis);
    }
    this.world.reset();
    this.hash.clear();
  }

  private loadFloor(n: number): void {
    this.clearEntities();
    generateFloor(this.map, this.plan, n, this.rngInstance);
    const m = this.map;

    // player
    const pe = this.world.create();
    this.player = pe;
    this.stores.pos.add(pe, (c) => { c.x = m.spawnX; c.y = m.spawnY; });
    this.stores.anim.add(pe, (c) => {
      c.rx = m.spawnX; c.ry = m.spawnY; c.fx = m.spawnX; c.fy = m.spawnY;
      c.t = 1; c.delay = 0; c.speed = 13; c.punch = 0;
    });
    this.stores.mark.add(pe, (c) => { c.tag = "player"; });
    const pv = this.renderer.makeVisual("player", 0x9ff8ff, false);
    this.stores.vis.m.set(pe, pv);
    this.stores.light.add(pe, (c) => {
      c.r = 6.4; c.color = 0x2ee6ff; c.base = 1; c.phase = 0;
      c.poly = new Array(LIGHT_RAYS * 2).fill(0);
    });
    this.renderer.bindLight(pe);
    this.hash.set(m.spawnX, m.spawnY, pe);

    // enemies
    for (const sp of this.plan.enemySpawns) this.spawnEnemy(sp.kind, sp.x, sp.y);

    // loot
    for (const sp of this.plan.lootSpawns) this.spawnRandomLoot(sp.x, sp.y);

    // vent lights (ambient)
    let vents = 0;
    for (const v of this.plan.vents) {
      if (vents >= 4) break;
      vents++;
      const ve = this.world.create();
      this.stores.pos.add(ve, (c) => { c.x = v.x; c.y = v.y; });
      this.stores.mark.add(ve, (c) => { c.tag = "vent"; });
      const cyan = vents % 2 === 0;
      this.stores.light.add(ve, (c) => {
        c.r = 2.6; c.color = cyan ? 0x00f0ff : 0xff2bd6; c.base = 0.55;
        c.phase = this.rng() * 6; c.poly = new Array(LIGHT_RAYS * 2).fill(0);
      });
      this.renderer.bindLight(ve);
    }

    this.renderer.beginFloor(this.map);
    const rays = recomputeFov(this, this.fovPoly);
    this.renderer.onFovChanged(this.map, this.fovPoly, rays);
    this.stats.onStairs = false;
  }

  private spawnEnemy(kind: EnemyKind, x: number, y: number): void {
    if (this.hash.get(x, y) >= 0) return; // tile already occupied — skip, never stack entities
    const e = this.world.create();
    const f = this.floor;
    const maxHp =
      kind === "stalker" ? 24 + f * 7 : kind === "sentinel" ? 20 + f * 6 : 58 + f * 14;
    this.stores.pos.add(e, (c) => { c.x = x; c.y = y; });
    this.stores.anim.add(e, (c) => {
      c.rx = x; c.ry = y; c.fx = x; c.fy = y; c.t = 1; c.delay = 0; c.speed = 8; c.punch = 0;
    });
    this.stores.hp.add(e, (c) => { c.hp = maxHp; c.max = maxHp; });
    this.stores.mark.add(e, (c) => { c.tag = "enemy"; });
    this.stores.ai.add(e, (c) => {
      c.kind = kind; c.pathLen = 0; c.pathIdx = 0; c.cd = 0;
      c.aggro = false; c.moveTick = 0; c.hurtT = 0;
    });
    const tint = ENEMY_TINT[kind];
    const vis = this.renderer.makeVisual("enemy", tint, true);
    this.renderer.restyleEnemy(vis, kind, tint);
    this.stores.vis.m.set(e, vis);
    if (kind === "sentinel") {
      this.stores.light.add(e, (c) => {
        c.r = 2.8; c.color = 0xb967ff; c.base = 0.7; c.phase = this.rng() * 6;
        c.poly = new Array(LIGHT_RAYS * 2).fill(0);
      });
      this.renderer.bindLight(e);
    }
    this.hash.set(x, y, e);
  }

  private spawnRandomLoot(x: number, y: number): void {
    const roll = this.rng();
    if (roll < 0.3) this.spawnLoot(x, y, "heal", this.rngInstance.int(0, 1));
    else if (roll < 0.55) this.spawnLoot(x, y, "energy", this.rngInstance.int(0, 1));
    else if (roll < 0.8)
      this.spawnLoot(x, y, "weapon", clamp(this.floor - 1 + this.rngInstance.int(0, 1), 0, WEAPON_TABLE.length - 1));
    else this.spawnLoot(x, y, "relic", this.rngInstance.int(0, RELIC_NAMES.length - 1));
  }

  private spawnLoot(x: number, y: number, kind: LootComp["kind"], tier: number): void {
    const e = this.world.create();
    this.stores.pos.add(e, (c) => { c.x = x; c.y = y; });
    this.stores.anim.add(e, (c) => {
      c.rx = x; c.ry = y; c.fx = x; c.fy = y; c.t = 1; c.delay = 0; c.speed = 8; c.punch = 0;
    });
    this.stores.mark.add(e, (c) => { c.tag = "loot"; });
    let name = "";
    let tint = 0x00f0ff;
    if (kind === "heal") { name = "MED-GEL"; tint = 0x46ffa6; }
    else if (kind === "energy") { name = "CAP CELL"; tint = 0xffe14d; }
    else if (kind === "weapon") {
      const w = WEAPON_TABLE[clamp(tier, 0, WEAPON_TABLE.length - 1)];
      name = `${WEAPON_PREFIX[this.rngInstance.int(0, WEAPON_PREFIX.length - 1)]} ${w.name}`;
      tint = 0x00f0ff;
    } else { name = RELIC_NAMES[clamp(tier, 0, RELIC_NAMES.length - 1)]; tint = 0xff2bd6; }
    this.stores.loot.add(e, (c) => { c.kind = kind; c.tier = tier; c.name = name; });
    const vis = this.renderer.makeVisual("loot", tint, false);
    this.stores.vis.m.set(e, vis);
  }

  /* ---------------------------------------------------------- game loop */

  private loop = (t: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dtRaw = clamp((t - this.lastT) / 1000, 0, 0.05);
    this.lastT = t;

    let scale = 1;
    if (this.hitstopT > 0) {
      this.hitstopT -= dtRaw;
      scale = 0.05; // hit-stop: near-freeze for impact feel
    }
    this.timeScale += (this.targetTimeScale - this.timeScale) * Math.min(1, dtRaw * 7);
    scale *= this.timeScale;
    const dt = dtRaw * scale;
    this.time += dt;

    const s = this.state;
    if (s === "playing" || s === "dying" || s === "transition") {
      inputSystem(this, dtRaw, this.keys, this.repeat);
      if (s === "playing") {
        const acted = runPlayerIntents(this);
        if (acted) this.endPlayerAction();
      }
      const st = this.stats;
      st.fireCd = Math.max(0, st.fireCd - dtRaw);
      st.dashCd = Math.max(0, st.dashCd - dtRaw);
      st.invuln = Math.max(0, st.invuln - dtRaw);
      animationSystem(this, dt);
      if (s === "playing" || s === "dying") this.runTime += dtRaw;
      if (s === "dying") {
        this.deathT -= dtRaw;
        if (this.deathT <= 0) this.finalizeDeath();
      }
      if (s === "transition") {
        this.transT -= dtRaw;
        if (this.transT <= 0) this.finishTransition();
      }
    } else {
      animationSystem(this, dtRaw * 0.5 * this.timeScale);
    }

    this.world.flushDestroys();
    this.renderer.update(this, dtRaw, dt);

    this.hudT -= dtRaw;
    if (this.hudT <= 0 && (s === "playing" || s === "dying")) {
      this.hudT = 0.12;
      this.pushHud();
    }
  };

  /* ------------------------------------------------------ turn resolution */

  endPlayerAction(): void {
    this.turn++;
    const st = this.stats;
    st.en = clamp(st.en + 6 + st.enRegen, 0, st.maxEn);
    const rays = recomputeFov(this, this.fovPoly);
    this.renderer.onFovChanged(this.map, this.fovPoly, rays);
    const p = this.stores.pos.get(this.player);
    if (p) {
      const onStairs = this.map.tiles[this.map.idx(p.x, p.y)] === TileT.Stairs;
      if (onStairs && !st.onStairs) this.sfx.play("stairs");
      st.onStairs = onStairs;
    }
    enemyTurnSystem(this);
    this.pushHud();
  }

  descend(): void {
    if (this.state !== "playing") return;
    this.state = "transition";
    this.transT = 0.85;
    this.sfx.play("stairs");
    this.fx.flash(0x8ffcff, 0.55);
    this.stats.score += 250;
    this.pushHud();
  }

  private finishTransition(): void {
    this.floor++;
    this.loadFloor(this.floor);
    this.state = "playing";
    this.banner = `SECTOR ${String(this.floor).padStart(2, "0")}`;
    this.bannerKey++;
    this.stats.hp = clamp(this.stats.hp + 14, 0, this.stats.maxHp);
    this.stats.score += 500;
    this.pushHud();
  }

  smashCrateAt(x: number, y: number): void {
    this.map.tiles[this.map.idx(x, y)] = TileT.Floor;
    this.renderer.redrawCrates(this.map);
    this.fx.shards(x + 0.5, y + 0.5, 0xffb347, 12, 3.4);
    this.fx.burst(x + 0.5, y + 0.5, 0xffb347, 10, 3, 0.4, 0.12);
    this.fx.shake(4);
    this.sfx.play("crate");
    if (this.rng() < 0.45) {
      this.spawnLoot(x, y, this.rng() < 0.5 ? "heal" : "energy", 0);
      const rays = recomputeFov(this, this.fovPoly);
      this.renderer.onFovChanged(this.map, this.fovPoly, rays);
    }
  }

  /* -------------------------------------------------------------- combat */

  damageEnemy(e: number, dmg: number, kx: number, ky: number): void {
    const h = this.stores.hp.get(e);
    const p = this.stores.pos.get(e);
    if (!h || !p || h.hp <= 0) return;
    h.hp -= dmg;
    const v = this.stores.vis.get(e);
    if (v) v.flash = 1;
    const a = this.stores.anim.get(e);
    if (a) a.punch = 1;
    const ai = this.stores.ai.get(e);
    if (ai) {
      ai.aggro = true;
      ai.hurtT = 4;
    }
    // knockback one tile along the impact direction
    const bx = p.x + Math.sign(kx);
    const by = p.y + Math.sign(ky);
    if ((kx !== 0 || ky !== 0) && this.map.walkable(bx, by) && this.hash.get(bx, by) < 0) {
      this.hash.move(e, p.x, p.y, bx, by);
      p.x = bx;
      p.y = by;
      if (a) {
        a.fx = a.rx; a.fy = a.ry; a.t = 0; a.delay = 0; a.speed = 15;
      }
      if (ai) { ai.pathIdx = ai.pathLen; }
    }
    const tint = ai ? ENEMY_TINT[ai.kind] : 0xff2bd6;
    this.fx.text(p.x, p.y - 0.7, `${dmg}`, "#ffffff", 14);
    this.fx.burst(p.x + 0.5, p.y + 0.5, tint, 10, 3.4, 0.35, 0.12);
    this.sfx.play("hit");
    if (this.stats.lifesteal > 0) {
      this.stats.hp = clamp(this.stats.hp + this.stats.lifesteal, 0, this.stats.maxHp);
    }
    if (h.hp <= 0) this.killEnemy(e, ai ? ai.kind : "stalker");
  }

  private killEnemy(e: number, kind: EnemyKind): void {
    const p = this.stores.pos.get(e);
    if (!p) return;
    this.stats.kills++;
    this.stats.score += Math.round(ENEMY_SCORE[kind] * (1 + 0.25 * (this.floor - 1)));
    const tint = ENEMY_TINT[kind];
    this.fx.burst(p.x + 0.5, p.y + 0.5, tint, 26, 5, 0.55, 0.16);
    this.fx.burst(p.x + 0.5, p.y + 0.5, 0xffffff, 10, 3.4, 0.3, 0.1);
    this.fx.shards(p.x + 0.5, p.y + 0.5, tint, 14, 4);
    this.fx.ring(p.x, p.y, tint, 1.7);
    this.sfx.play("kill");
    this.hitstopT = Math.max(this.hitstopT, 0.085);
    this.fx.shake(11);
    // loot drop
    const roll = this.rng();
    if (roll < 0.24) this.spawnLoot(p.x, p.y, "heal", this.rngInstance.int(0, 1));
    else if (roll < 0.38) this.spawnLoot(p.x, p.y, "energy", 0);
    else if (roll < 0.46)
      this.spawnLoot(p.x, p.y, "weapon", clamp(this.floor - 1 + this.rngInstance.int(0, 1), 0, WEAPON_TABLE.length - 1));
    this.renderer.unbindLight(e);
    this.renderer.detachVisual(e, this.stores.vis);
    this.hash.remove(p.x, p.y, e);
    this.world.queueDestroy(e);
    this.pushHud();
  }

  damagePlayer(dmg: number, fromX: number, fromY: number): void {
    if (this.state !== "playing") return;
    const st = this.stats;
    if (st.invuln > 0) {
      const p = this.stores.pos.get(this.player);
      if (p) this.fx.text(p.x, p.y - 0.7, "PHASE", "#7ef3ff", 12);
      return;
    }
    const final = Math.max(1, dmg - st.armor);
    st.hp -= final;
    const p = this.stores.pos.get(this.player);
    const v = this.stores.vis.get(this.player);
    if (v) v.flash = 1;
    const a = this.stores.anim.get(this.player);
    if (a) a.punch = 0.8;
    if (p) {
      this.fx.text(p.x, p.y - 0.8, `-${final}`, "#ff4d5e", 17);
      this.fx.burst(p.x + 0.5, p.y + 0.5, 0xff4d5e, 14, 3.6, 0.4, 0.13);
    }
    this.fx.flash(0xff2244, 0.26);
    this.fx.shake(8);
    this.hitstopT = Math.max(this.hitstopT, 0.05);
    this.sfx.play("hurt");
    this.dmgPulse++;
    void fromX;
    void fromY;
    if (st.hp <= 0) {
      st.hp = 0;
      this.startDeath();
    }
    this.pushHud();
  }

  private startDeath(): void {
    this.state = "dying";
    this.deathT = 1.5;
    this.targetTimeScale = 0.22;
    const p = this.stores.pos.get(this.player);
    if (p) {
      this.fx.burst(p.x + 0.5, p.y + 0.5, 0x00f0ff, 46, 6, 0.9, 0.18);
      this.fx.burst(p.x + 0.5, p.y + 0.5, 0xff2bd6, 30, 4.6, 0.8, 0.15);
      this.fx.shards(p.x + 0.5, p.y + 0.5, 0x9ff8ff, 26, 5);
      this.fx.ring(p.x, p.y, 0x00f0ff, 3.2);
      this.fx.ring(p.x, p.y, 0xff2bd6, 2.2);
    }
    this.fx.flash(0xff2244, 0.5);
    this.fx.shake(20);
    this.sfx.play("kill");
    this.sfxImpl.stopDrone();
    this.pushHud();
  }

  private finalizeDeath(): void {
    this.state = "dead";
    this.targetTimeScale = 1;
    const v = this.stores.vis.get(this.player);
    if (v) v.root.visible = false;
    this.pushHud();
  }

  /* ----------------------------------------------------------------- hud */

  pushHud(): void {
    if (this.destroyed) return;
    const st = this.stats;
    const mm = Math.floor(this.runTime / 60);
    const ss = Math.floor(this.runTime % 60);
    const snap: Snap = {
      state: this.state,
      hp: Math.max(0, Math.round(st.hp)),
      maxHp: st.maxHp,
      en: Math.round(st.en),
      maxEn: st.maxEn,
      armor: st.armor,
      floor: this.floor,
      kills: st.kills,
      score: st.score,
      weapon: st.weapon.name,
      prompt:
        this.state === "playing" && st.onStairs
          ? `PRESS  E  —  DESCEND TO SECTOR ${String(this.floor + 1).padStart(2, "0")}`
          : "",
      muted: this.muted,
      banner: this.banner,
      bannerKey: this.bannerKey,
      death:
        this.state === "dead"
          ? {
              floor: this.floor,
              kills: st.kills,
              score: st.score,
              time: `${mm}:${String(ss).padStart(2, "0")}`,
              weapon: st.weapon.name,
            }
          : null,
      dmgPulse: this.dmgPulse,
    };
    this.onSnap(snap);
  }

  /* ---------------------------------------------------------- IFx bridge */

  fx = {
    beam: (x0: number, y0: number, x1: number, y1: number, color: number, width: number): void =>
      this.renderer.beam(x0, y0, x1, y1, color, width),
    ring: (x: number, y: number, color: number, radius: number): void => this.renderer.ring(x, y, color, radius),
    burst: (x: number, y: number, color: number, count: number, speed: number, life: number, size: number): void =>
      this.renderer.burst(x, y, color, count, speed, life, size),
    shards: (x: number, y: number, color: number, count: number, power: number): void =>
      this.renderer.shards(x, y, color, count, power),
    text: (x: number, y: number, str: string, color: string, size?: number): void =>
      this.renderer.text(x, y, str, color, size),
    flash: (color: number, alpha: number): void => this.renderer.flash(color, alpha),
    shake: (mag: number): void => this.renderer.shake(mag),
  };
}

export { TILE };
