// Full-map rendering in horizontal bands, plus PNG and downscaling helpers.

import { writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { type Layout, renderViewport } from "./render.js";
import type { Scene } from "./scene.js";

export interface Image {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const BAND = 512;

export function renderImage(scene: Scene, L: Layout, progress?: (done: number, total: number) => void): Image {
  const img: Image = { width: L.width, height: L.height, data: new Uint8Array(L.width * L.height * 4) };
  const bands = Math.ceil(L.height / BAND);
  for (let b = 0; b < bands; b++) {
    const y0 = b * BAND;
    const h = Math.min(BAND, L.height - y0);
    const f = renderViewport(scene, L, { x0: 0, y0, w: L.width, h });
    const out = img.data;
    for (let i = 0, o = y0 * L.width * 4; i < f.rgb.length; i += 3, o += 4) {
      out[o] = f.rgb[i];
      out[o + 1] = f.rgb[i + 1];
      out[o + 2] = f.rgb[i + 2];
      out[o + 3] = 255;
    }
    progress?.(b + 1, bands);
  }
  return img;
}

export function encodePng(img: Image): Buffer {
  const png = new PNG({ width: img.width, height: img.height, colorType: 2, inputColorType: 6, inputHasAlpha: true });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png, { colorType: 2, inputColorType: 6, inputHasAlpha: true, deflateLevel: 9 });
}

export async function writePng(path: string, img: Image): Promise<void> {
  await writeFile(path, encodePng(img));
}

/** Halve an image with a 2x2 box filter (odd edges are clamped). */
export function halve(img: Image): Image {
  const w = Math.max(1, Math.ceil(img.width / 2));
  const h = Math.max(1, Math.ceil(img.height / 2));
  const out = new Uint8Array(w * h * 4);
  const src = img.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(img.height - 1, y * 2);
    const y1 = Math.min(img.height - 1, y * 2 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(img.width - 1, x * 2);
      const x1 = Math.min(img.width - 1, x * 2 + 1);
      const a = (y0 * img.width + x0) * 4;
      const b = (y0 * img.width + x1) * 4;
      const c = (y1 * img.width + x0) * 4;
      const d = (y1 * img.width + x1) * 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2) >> 2;
    }
  }
  return { width: w, height: h, data: out };
}

/** Copy a rectangle out of an image (clamped to its bounds). */
export function cropImage(img: Image, x: number, y: number, w: number, h: number): Image {
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) {
    const sy = y + r;
    if (sy < 0 || sy >= img.height) continue;
    for (let c = 0; c < w; c++) {
      const sx = x + c;
      if (sx < 0 || sx >= img.width) continue;
      const s = (sy * img.width + sx) * 4;
      const o = (r * w + c) * 4;
      out[o] = img.data[s];
      out[o + 1] = img.data[s + 1];
      out[o + 2] = img.data[s + 2];
      out[o + 3] = img.data[s + 3];
    }
  }
  return { width: w, height: h, data: out };
}
