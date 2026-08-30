# AGENTS.md — Neon Labyrinth Project Guide

Welcome, Agent! This document serves as the single source of truth for the **Neon Labyrinth** codebase, architecture, infrastructure, and deployment workflow.

---

## 🧭 1. Project Overview & Quick Reference

- **Game Concept:** A fast-paced, turn-based cyberpunk roguelike with discrete grid turn pacing, smooth interpolated movement rendering, real-time wall-occluded FoV lighting, and zero external binary assets (all textures and audio synthesized in code via WebGL/PixiJS and WebAudio).
- **Live Deployment:** [https://gitserver.tail97bf76.ts.net/neon-labrinth/](https://gitserver.tail97bf76.ts.net/neon-labrinth/)
- **Repository Remotes:**
  - `origin` -> `ssh://git@gitserver.tail97bf76.ts.net:22/paul/neon-labrinth.git` (Forgejo on Minisforum server)
  - `github` -> `https://github.com/pauldavid1974/neon-labrinth.git`

---

## 🏗️ 2. Architecture & Directory Structure

```
neon-labrinth/
├── src/
│   ├── main.tsx             # React bootstrap
│   ├── App.tsx              # Game host container, snap state listener, & UI callbacks
│   ├── index.css            # Cyberpunk UI theme, animations, neon & touch button styles
│   ├── core/
│   │   └── utils.ts         # Fast math, RNG, clamp, lerp, damp, spatial hash, logger
│   ├── game/
│   │   ├── types.ts         # Types, interfaces, ECS components, constants (TILE=32, etc.)
│   │   ├── ecs.ts           # Lightweight allocation-free Entity-Component System
│   │   ├── map.ts           # Procedural BSP dungeon generation, corridors, props & hazards
│   │   ├── fov.ts           # Amanatides-Woo DDA raycasting, FoV polygon, light occlusion
│   │   ├── audio.ts         # Pure WebAudio procedural synthesizer (SFX + Sector drone)
│   │   ├── systems.ts       # Player intents, enemy utility AI, pathfinding, weapon raycasts
│   │   └── game.ts          # Central game loop, rAF ticker, input routing, state transitions
│   ├── render/
│   │   ├── textures.ts      # Procedural ImageData bitmap textures (soft glow, dots, shards)
│   │   ├── particles.ts     # Pre-allocated 2,200 particle object pool
│   │   └── renderer.ts      # PixiJS v8 WebGL renderer, FoV stencil masking, target locking
│   └── ui/
│       └── ui.tsx           # React HUD overlay, virtual touch controls D-Pad, modal dialogs
├── index.html               # Entry HTML shell, metadata, Orbitron/Rajdhani Google fonts
├── vite.config.js           # Vite configuration with `base: "./"` for relative subpath serving
└── package.json             # Scripts: dev, build, typecheck, preview
```

---

## ⚡ 3. Key Systems & Mechanics

### Turn Execution Pipeline (`src/game/game.ts` & `src/game/systems.ts`)
- **Discrete Grid Turn-Based:** The player acts (`runPlayerIntents(ctx)`). If an action was taken (movement, weapon fire, phase dash, vent), `enemyTurnSystem(ctx)` executes.
- **Visual Tweens:** Movement is logically instantaneous on the grid, but visually animated via `animationSystem` using smooth lerp interpolation.
- **Weapon Raycasting:** `castWeaponRay` computes wall collisions and pierces/hits targets. `ctx.input.aimX` and `ctx.input.aimY` are normalized tile coordinates (`worldPxX / TILE`).
- **Target Lock Reticle:** In `Renderer`, if an enemy or shootable prop (`Barrel`, `TeslaNode`, `Crate`) lies along the aim ray or under the cursor, the reticle snaps to target center with a 4-bracket holographic HUD frame.

### Audio Synthesizer (`src/game/audio.ts`)
- **Zero Audio Files:** Built purely with the WebAudio API.
- **Sector Drone:** `updateDroneSector(floor)` modulates harmonic oscillator frequencies and filter resonance dynamically based on the current sector biome.

### Mobile & Touch Controls (`src/ui/ui.tsx`)
- Virtual D-Pad (Up, Down, Left, Right, Center Vent) + Action Cluster (Auto-aim Fire, Phase Dash, EMP Shockwave, Descend Stairs).
- Toggleable via bottom toolbar `TOUCH ON/OFF` and auto-detected on touchscreens.

---

## 🚀 4. Automated CI/CD & Deployment Workflow

### How it works:
1. The Minisforum server hosts Forgejo Git with custom git hook `post-receive` enabled.
2. Whenever `git push origin main` is executed:
   - Forgejo triggers `custom_hooks/post-receive`.
   - The hook checks out `main` into `/var/www/neon-labrinth`.
   - Runs `npm run build` on the server (~8-9 seconds).
   - The compiled static bundle in `/var/www/neon-labrinth/dist` is instantly served via **Tailscale Serve** at:
     `https://gitserver.tail97bf76.ts.net/neon-labrinth/`

### How to Deploy Changes:
Always verify locally first, then push to both remotes:
```powershell
npm run typecheck
npm run build
git add .
git commit -m "feat: description of change"
git push origin main
git push github main
```

---

## 💡 5. Conventions & Rules for Future Agents

1. **Keep it Asset-Free:** Do not introduce external `.png`, `.jpg`, `.mp3`, or `.wav` files. All textures and graphics are drawn via PixiJS primitives / procedural bitmaps in `src/render/`, and all audio is generated in `src/game/audio.ts`.
2. **Preserve Subpath Resolution:** In `vite.config.js`, `base: "./"` must remain set so that assets load properly under the `/neon-labrinth/` subpath.
3. **Allocation-Free Hot Loop:** Avoid creating temporary objects or arrays inside the per-frame `render()` loop or particle updates. Use the pre-allocated pools.
4. **FoV Masking:** Any new lit graphical elements (tiles, props, structures) must be added inside the `litC` container in `Renderer` so they are properly masked by `fovMask`. Unexplored areas must remain pitch black.
