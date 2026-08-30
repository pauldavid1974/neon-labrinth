# NEON LABYRINTH

> **One life. Infinite sectors. How deep can you go?**

A fast, turn-based roguelike rendered in pure WebGL neon. Every floor is a
procedurally generated cyber-dungeon; every light source is occluded by real
walls; every enemy thinks with a scored utility AI. When you die, the run is
over — your only progress is knowing the Labyrinth a little better.

---

## The pitch (itch.io short description)

> Turn-based neon roguelike with procedural dungeons, wall-occluded dynamic
> lighting, and three enemy AIs. Chain plasma bolts, phase-dashes and relics
> through ever-deeper sectors — permadeath included, no microtransactions, no
> loading screens. Plays in your browser, keyboard + mouse.

## Store-page description

**The year is irrelevant. The sector is everything.**

NEON LABYRINTH drops you into the upper floors of an infinite machine-dungeon
and asks a simple question: how far down do you want to go? Each sector is
generated fresh — rooms split from binary space partitions, corridors
stitched with L-bends, pillars and explosive crates scattered for cover and
greed. Fog of war keeps the dark honest; your lantern, the vents, and the
hunting Sentinels below carve real light out of it, raycast against every
wall in real time.

**Combat is a conversation, not a reflex test.** The world waits for you.
Move one tile and the whole floor answers: Stalkers sprint to close the
distance, Sentinels kite you and snipe violet bolts down corridors, and
Goliaths — slow, armored, furious — telegraph a full-tile charge that you
either sidestep or eat. Every action costs and earns energy, so the game
becomes a rhythm of aggression and venting: burn the capacitor on a
wall-piercing plasma volley, then step back and let it recharge behind a
pillar.

**Loot rewrites the run.** Procedurally named weapons escalate from a Pulse
Sidearm to the Void Singularity; relics stack permanent buffs — armor
plating, flux overclocks, vampiric circuits, titan cores. Crates split into
shards and sometimes pay you for the violence. Every choice compounds until
something, somewhere, one tile closer than you noticed, ends the run and
posts your final sector, kills and score to the flatline screen.

Juice is everywhere: hit-stop on kills, screen shake on charges, floating
damage numbers, a ghost-trail health bar, a live minimap, and a fully
synthesized soundtrack of drones and blips — no audio files, no sprites, no
textures. Every pixel is math.

**Easy to learn. Brutal to master.** WASD to move, mouse to aim, Space to
phase-dash through danger. Runs take minutes; the descent takes forever.

---

## Features

- **Procedural sectors** — BSP dungeon generation with pillars, crates,
  doors and guaranteed connectivity; difficulty and enemy budgets scale with
  depth.
- **True turn-based tactics** — the world only moves when you do, with
  smooth interpolated movement, camera follow and hit-stop on impact.
- **Dynamic wall-occluded lighting** — radial DDA raycasts build live
  visibility polygons for the player, vents and Sentinel lamps, on top of a
  persistent fog-of-war memory layer.
- **Three enemy archetypes** driven by scored utility AI (chase,
  self-preservation, kiting, telegraphed charges), all pathing over A*.
- **Procedural loot** — five weapon tiers with piercing endgame, four relic
  buff lines, heal and energy drops.
- **Full game feel** — screen shake, hit-stop, slow-mo death sequence,
  particle bursts, floating combat text, target-lock reticle.
- **Zero external assets** — every texture is computed per-pixel at boot,
  every sound is synthesized live with WebAudio.
- **Mobile & Touch Controls** — responsive on-screen virtual D-Pad, smart auto-aiming Fire button, Phase Dash, EMP shockwave, and stairs descent with haptic feedback.
- **Dynamic Synthesizer Drone** — WebAudio drone modulates base frequencies and resonance dynamically per sector biome.
- **Endgame Weaponry & Relics** — Chrono Tachyon piercing stun beam, Overcharge Matrix 2.2x critical strike relic, and 5 tiers of cyber-arsenal.
- **Complete furniture** — title, pause and death screens, HUD with health,
  energy, weapon, armor, sector, kills and score, control guide, mute,
  minimap.

## Controls

| Desktop Input   | Touch / Mobile | Action                                        |
| --------------- | -------------- | --------------------------------------------- |
| `WASD` / arrows | Virtual D-Pad  | Move / bump-attack / smash crates             |
| Mouse           | Touch Tap      | Aim the laser sight (locks onto targets)      |
| Left click      | `FIRE` Button  | Fire weapon bolt (smart auto-aims if neutral) |
| `Space`         | `DASH` Button  | Phase-dash 2 tiles with brief invulnerability |
| `Q` / `F`       | `EMP` Button   | EMP Shockwave (stuns enemies in radius)       |
| `R`             | `VENT` Button  | Vent — skip turn, recover energy              |
| `E`             | `DESCEND`      | Descend at the stairwell                      |
| `Esc` / `P`     | —              | Pause                                         |
| `M`             | `SOUND` Button | Toggle Audio Mute                             |
| —               | `TOUCH` Button | Toggle Touch Controls on/off                  |

---

## Live Deployment

Play live from any device on the network:
👉 **[https://gitserver.tail97bf76.ts.net/neon-labrinth/](https://gitserver.tail97bf76.ts.net/neon-labrinth/)**

---

## Under the hood

- **PixiJS v8** WebGL/WebGPU renderer — no Canvas 2D, no sprite sheets.
- **Custom data-oriented ECS** — entities as IDs, pooled component stores,
  allocation-free iteration, deferred destruction.
- **Binary min-heap A*** and **Amanatides–Woo DDA** raycasts for pathing,
  field of view and light occlusion (spatial hashing for all collision).
- **Object-pooled everything** — 2,200 particles, beams, shockwave rings,
  damage numbers and light polygons all come from preallocated pools; the
  frame loop generates no garbage.
- **Synthesized audio** — oscillators and a pre-baked noise buffer; a
  detuned sawtooth drone plays beneath the action.
- TypeScript strict mode, Vite, React shell for the UI chrome.

## Run locally

```bash
npm install
npm run dev      # development server
npm run build    # production build → dist/
```

## Publishing

The game is a fully static site — the production build in `dist/` can be
hosted anywhere that serves static files.

**itch.io**
1. `npm run build`, then zip the *contents* of `dist/` (the `index.html`
   must be at the zip root).
2. New project → kind **HTML**, upload the zip, tick *"This file will be
   played in the browser"* and *"Mobile friendly"* off.
3. Recommended embed: **1280 × 720**, allow fullscreen.
4. Paste the store-page description above; add the `description` from
   `index.html` as the short text.

**GitHub Pages**
Push `dist/` to a `gh-pages` branch (or use the `vite-plugin-gh-pages`
workflow) and enable Pages on that branch.

**Netlify / Vercel / Cloudflare Pages**
Point the build command at `npm run build` and the publish directory at
`dist/`. No environment variables needed.

---

Built with caffeine, raycasts and an unreasonable fear of garbage
collection. Sector 01 awaits.
