/**
 * Procedural texture factory.
 * Every texture is computed per-pixel into an ImageData buffer, transferred
 * via createImageBitmap → PixiJS Source. No image assets, no Canvas2D calls.
 * Bases are white so Sprite.tint can color them at runtime.
 */
import { Texture } from "pixi.js";
import { Logger } from "../core/utils";

export interface TexSet {
  soft: Texture; // gaussian glow — lights, auras, particles
  dot: Texture; // hot-core spark
  shard: Texture; // triangle debris
  vignette: Texture; // screen-space edge darkening
}

async function bitmapTexture(size: number, fn: (u: number, v: number, out: Uint8ClampedArray, i: number) => void): Promise<Texture> {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 0;
      fn(x / (size - 1), y / (size - 1), data, i);
    }
  }
  const imageData = new ImageData(data, size, size);
  const bitmap = await createImageBitmap(imageData);
  return Texture.from(bitmap);
}

/** Soft gaussian blob — the workhorse for glows & particles. */
async function makeSoft(): Promise<Texture> {
  return bitmapTexture(128, (u, v, d, i) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r2 = (dx * dx + dy * dy) * 4; // r in [0, ~2]
    const a = Math.exp(-r2 * 4.2) * 255;
    d[i + 3] = a > 255 ? 255 : a;
  });
}

/** Bright hot-core spark with tight falloff. */
async function makeDot(): Promise<Texture> {
  return bitmapTexture(32, (u, v, d, i) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) * 2;
    const core = Math.max(0, 1 - r);
    const a = Math.pow(core, 2.2) * 255;
    d[i + 3] = a > 255 ? 255 : a;
  });
}

/** Triangle shard for debris/bursts. */
async function makeShard(): Promise<Texture> {
  return bitmapTexture(32, (u, v, d, i) => {
    // triangle vertices at (0.5,0.04),(0.96,0.92),(0.04,0.92)
    const sign = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number =>
      (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const inside =
      sign(u, v, 0.5, 0.04, 0.96, 0.92) < 0 &&
      sign(u, v, 0.96, 0.92, 0.04, 0.92) < 0 &&
      sign(u, v, 0.04, 0.92, 0.5, 0.04) < 0;
    d[i + 3] = inside ? 235 : 0;
  });
}

/** Radial vignette (black edges) for the screen-space overlay. */
async function makeVignette(): Promise<Texture> {
  return bitmapTexture(512, (u, v, d, i) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const r = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
    const t = Math.min(1, Math.max(0, (r - 0.52) / 0.48));
    d[i] = 0;
    d[i + 1] = 0;
    d[i + 2] = 0;
    d[i + 3] = t * t * 235;
  });
}

export async function makeTextures(): Promise<TexSet> {
  try {
    const [soft, dot, shard, vignette] = await Promise.all([
      makeSoft(),
      makeDot(),
      makeShard(),
      makeVignette(),
    ]);
    return { soft, dot, shard, vignette };
  } catch (e) {
    // Safe fallback: flat white texture keeps the game playable.
    Logger.error("texture generation failed, using fallback white texture", e);
    return {
      soft: Texture.WHITE,
      dot: Texture.WHITE,
      shard: Texture.WHITE,
      vignette: Texture.WHITE,
    };
  }
}
