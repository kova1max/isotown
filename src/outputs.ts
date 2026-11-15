// The three outputs: a deep-zoom tile pyramid with its viewer, a poster, and
// an animated day/night GIF. Each carries the OpenStreetMap attribution.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import gifenc from "gifenc";
import { PNG } from "pngjs";
import { drawText, textWidth } from "./font.js";
import { type Image, cropImage, halve } from "./image.js";
import { GROUND, type RGB, WINDOW } from "./palette.js";
import { type Frame, type Layout, Mat, renderViewport } from "./render.js";
import type { Scene } from "./scene.js";

export const ATTRIBUTION = "Map data © OpenStreetMap contributors";
const INK: RGB = [236, 228, 206];
const INK_DIM: RGB = [150, 156, 170];

// ---------------------------------------------------------------- deep zoom

const TILE = 256;
// One pixel of overlap avoids hairline seams between tiles when the viewer smooths.
const OVERLAP = 1;

/** Write map.dzi and map_files/<level>/<col>_<row>.png. Returns the tile count. */
export async function writeDeepZoom(dir: string, img: Image): Promise<number> {
  const maxLevel = Math.ceil(Math.log2(Math.max(img.width, img.height)));
  await writeFile(
    join(dir, "map.dzi"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" Format="png" Overlap="${OVERLAP}" TileSize="${TILE}">\n  <Size Width="${img.width}" Height="${img.height}"/>\n</Image>\n`,
  );
  let level = img;
  let tiles = 0;
  for (let l = maxLevel; l >= 0; l--) {
    const ldir = join(dir, "map_files", String(l));
    await mkdir(ldir, { recursive: true });
    const cols = Math.ceil(level.width / TILE);
    const rows = Math.ceil(level.height / TILE);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = Math.max(0, c * TILE - OVERLAP);
        const y0 = Math.max(0, r * TILE - OVERLAP);
        const x1 = Math.min(level.width, (c + 1) * TILE + OVERLAP);
        const y1 = Math.min(level.height, (r + 1) * TILE + OVERLAP);
        const tile = cropImage(level, x0, y0, x1 - x0, y1 - y0);
        await writeFile(join(ldir, `${c}_${r}.png`), encodeTile(tile));
        tiles++;
      }
    }
    if (l > 0) level = halve(level);
  }
  return tiles;
}

function encodeTile(img: Image): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png, { colorType: 2, inputColorType: 6, inputHasAlpha: true, deflateLevel: 6 });
}

/**
 * The viewer page. The tile source is inlined rather than loaded from map.dzi so
 * the page also works when opened straight from disk (file://), and the canvas
 * drawer keeps working there where WebGL would refuse file:// textures.
 */
export function viewerHtml(title: string, subtitle: string, width: number, height: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - isotown</title>
<style>
  html, body { margin: 0; height: 100%; background: rgb(${GROUND.void.join(",")}); color: #ece4ce; font: 14px/1.4 ui-monospace, Menlo, Consolas, monospace; }
  #map { position: fixed; inset: 0; }
  #map canvas { image-rendering: pixelated; image-rendering: crisp-edges; }
  .label { position: fixed; left: 12px; top: 10px; padding: 6px 10px; background: rgba(24, 28, 38, 0.82); border-radius: 4px; pointer-events: none; }
  .label b { font-size: 16px; }
  .attribution { position: fixed; right: 0; bottom: 0; padding: 4px 8px; background: rgba(24, 28, 38, 0.82); font-size: 12px; }
  a { color: #9cc4ec; }
</style>
</head>
<body>
<div id="map"></div>
<div class="label"><b>${esc(title)}</b><br>${esc(subtitle)}</div>
<div class="attribution">Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> &middot; rendered with <a href="https://github.com/kova1max/isotown">isotown</a></div>
<script src="https://cdn.jsdelivr.net/npm/openseadragon@5.0.1/build/openseadragon/openseadragon.min.js"></script>
<script>
  const source = new OpenSeadragon.DziTileSource(${width}, ${height}, ${TILE}, ${OVERLAP}, "map_files/", "png");
  // The tiles are opaque PNGs. Saying so stops the viewer clearing each tile's
  // rectangle first, which leaves hairline seams between tiles.
  source.hasTransparency = () => false;
  OpenSeadragon({
    id: "map",
    tileSources: source,
    drawer: "canvas",
    prefixUrl: "https://cdn.jsdelivr.net/npm/openseadragon@5.0.1/build/openseadragon/images/",
    navigationControlAnchor: OpenSeadragon.ControlAnchor.TOP_RIGHT,
    // Hard pixels when zoomed in. Zoomed out, the viewer shows a pyramid level
    // that was already box-filtered down, so it still looks smooth.
    imageSmoothingEnabled: false,
    maxZoomPixelRatio: 10,
    visibilityRatio: 0.6,
    showNavigator: true,
    navigatorPosition: "BOTTOM_LEFT",
    gestureSettingsMouse: { clickToZoom: false },
  });
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- poster

/** The whole map, shrunk to at most `maxWidth`, framed, with a title band. */
export function poster(img: Image, title: string, subtitle: string, maxWidth = 3000): Image {
  let map = img;
  while (map.width > maxWidth) map = halve(map);
  const scale = Math.max(2, Math.round(map.width / 600));
  const small = Math.max(1, Math.round(scale / 2));
  const margin = 12 * scale;
  const band = 7 * scale + 7 * small * 2 + 10 * small + margin;
  const out: Image = { width: map.width + margin * 2, height: map.height + margin * 2 + band, data: new Uint8Array(0) };
  out.data = new Uint8Array(out.width * out.height * 4);
  for (let i = 0; i < out.width * out.height; i++) {
    out.data[i * 4] = GROUND.void[0];
    out.data[i * 4 + 1] = GROUND.void[1];
    out.data[i * 4 + 2] = GROUND.void[2];
    out.data[i * 4 + 3] = 255;
  }
  for (let y = 0; y < map.height; y++) {
    out.data.set(map.data.subarray(y * map.width * 4, (y + 1) * map.width * 4), ((y + margin) * out.width + margin) * 4);
  }
  const ty = margin + map.height + margin;
  drawText(out, title, margin, ty, scale, INK);
  drawText(out, subtitle, margin, ty + 7 * scale + 5 * small, small, INK_DIM);
  drawText(out, ATTRIBUTION, out.width - margin - textWidth(ATTRIBUTION, small), ty + 7 * scale + 5 * small, small, INK_DIM);
  return out;
}

// ---------------------------------------------------------------- day / night GIF

const FRAMES = 16;
const NIGHT_SKY: RGB = [18, 26, 58];

/** Render an 800x500 window around `at` and animate it from day to night. */
export function dayNightGif(scene: Scene, L: Layout, at: { x: number; y: number }, w = 800, h = 500): Uint8Array {
  const frames = dayNightFrames(scene, L, at, w, h);
  const sample = new Uint8Array(w * h * 4 * 2);
  sample.set(frames[0], 0);
  sample.set(frames[FRAMES - 1], w * h * 4);
  const palette = gifenc.quantize(sample, 256);
  const gif = gifenc.GIFEncoder();
  for (let k = 0; k < FRAMES; k++) {
    const index = gifenc.applyPalette(frames[k], palette);
    const delay = k === 0 ? 1400 : k === FRAMES - 1 ? 2000 : 180;
    gif.writeFrame(index, w, h, { palette, delay, repeat: 0 });
  }
  gif.finish();
  return gif.bytes();
}

/** The RGBA frames of the day/night animation, from full day to full night. */
export function dayNightFrames(scene: Scene, L: Layout, at: { x: number; y: number }, w: number, h: number): Uint8Array[] {
  const f = renderViewport(scene, L, { x0: Math.round(at.x - w / 2), y0: Math.round(at.y - h / 2), w, h });
  const frames: Uint8Array[] = [];
  for (let k = 0; k < FRAMES; k++) frames.push(nightFrame(f, k));
  return frames;
}

function nightFrame(f: Frame, k: number): Uint8Array {
  const dark = clamp01((k - 1) / 7);
  const lights = clamp01((k - 5) / 9);
  const threshold = lights * 255;
  const n = f.vp.w * f.vp.h;
  const out = new Uint8Array(n * 4);
  const keep = 1 - 0.68 * dark;
  for (let i = 0; i < n; i++) {
    let r = f.rgb[i * 3];
    let g = f.rgb[i * 3 + 1];
    let b = f.rgb[i * 3 + 2];
    const m = f.mat[i];
    const lit = f.lit[i];
    if (m === Mat.Window && lit > 0 && lit <= threshold) {
      const c = lit & 1 ? WINDOW.lit : WINDOW.litWarm;
      r = c[0];
      g = c[1];
      b = c[2];
    } else if (m !== Mat.Void) {
      const tint = m === Mat.Water ? 0.45 : 0.3;
      r = r * keep + NIGHT_SKY[0] * tint * dark;
      g = g * keep + NIGHT_SKY[1] * tint * dark;
      b = b * keep + NIGHT_SKY[2] * tint * dark * 1.4;
    }
    out[i * 4] = Math.min(255, Math.round(r));
    out[i * 4 + 1] = Math.min(255, Math.round(g));
    out[i * 4 + 2] = Math.min(255, Math.round(b));
    out[i * 4 + 3] = 255;
  }
  stampAttribution(out, f.vp.w, f.vp.h);
  return out;
}

/** Burn the attribution into the bottom-right corner on a dark plate. */
export function stampAttribution(data: Uint8Array, w: number, h: number): void {
  const img: Image = { width: w, height: h, data };
  const tw = textWidth(ATTRIBUTION, 1);
  const x0 = w - tw - 8;
  const y0 = h - 13;
  for (let y = y0 - 3; y < h; y++) {
    for (let x = x0 - 4; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = GROUND.void[0];
      data[o + 1] = GROUND.void[1];
      data[o + 2] = GROUND.void[2];
    }
  }
  drawText(img, ATTRIBUTION, x0, y0, 1, INK);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}


