// Software rasteriser for the 2:1 isometric view. Everything is drawn into a
// viewport (a window onto the full image) so the full map can be rendered in
// horizontal bands with bounded memory.
//
// World: e (east) and n (north) in metres, h up. The camera looks from the
// south-east at 30 degrees elevation, so north-west is "up" on screen and the
// south- and east-facing walls are the visible ones.
//   sx = (e + n) * K
//   sy = (e - n) * K / 2 - h * KZ
//   depth = (e - n) * A + h / 2        (larger is nearer the camera)

import { clipRing, hash01 } from "./geometry.js";
import { GROUND, type RGB, TREE, WINDOW, shade } from "./palette.js";
import { type Building, type GroundKind, type Road, type Scene, type Tree, maskAt } from "./scene.js";

export const K = 1.5;
export const KZ = K * Math.sqrt(1.5);
const A = Math.sqrt(3) / (2 * Math.SQRT2);
const SLAB_DEPTH = 14;
const PAD = 24;

/** Material per pixel, used for outlines and for the night-time recolouring. */
export const enum Mat {
  Void = 0,
  Ground = 1,
  Water = 2,
  Wall = 3,
  Roof = 4,
  Window = 5,
  Tree = 6,
  Slab = 7,
  Road = 8,
}

export interface Layout {
  half: number;
  ox: number;
  oy: number;
  width: number;
  height: number;
}

export function makeLayout(scene: Scene): Layout {
  const half = scene.half;
  let maxH = 20;
  for (const b of scene.buildings) if (b.maxH > maxH) maxH = b.maxH;
  maxH = Math.min(maxH, 320);
  const top = Math.ceil(maxH * KZ) + PAD;
  const ox = Math.ceil(2 * half * K) + PAD;
  const oy = Math.ceil(half * K) + top;
  return {
    half,
    ox,
    oy,
    width: 2 * ox,
    height: oy + Math.ceil(half * K) + Math.ceil(SLAB_DEPTH * KZ) + PAD,
  };
}

export interface Viewport {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

export interface Frame {
  vp: Viewport;
  rgb: Uint8Array;
  mat: Uint8Array;
  /** Per-window random threshold (1..255) for switching lights on at night; 0 elsewhere. */
  lit: Uint8Array;
}

interface Buf extends Frame {
  depth: Float32Array;
  id: Int32Array;
}

export function renderViewport(scene: Scene, L: Layout, vp: Viewport): Frame {
  // One pixel of margin on every side so outline and edge passes see their neighbours.
  const big: Viewport = { x0: vp.x0 - 1, y0: vp.y0 - 1, w: vp.w + 2, h: vp.h + 2 };
  const n = big.w * big.h;
  const buf: Buf = {
    vp: big,
    rgb: new Uint8Array(n * 3),
    mat: new Uint8Array(n),
    lit: new Uint8Array(n),
    depth: new Float32Array(n).fill(-Infinity),
    id: new Int32Array(n),
  };
  drawGround(scene, L, buf);
  drawSlab(L, buf);
  for (let i = 0; i < scene.buildings.length; i++) drawBuilding(scene.buildings[i], i + 1, L, buf);
  const treeBase = scene.buildings.length + 1;
  for (let i = 0; i < scene.trees.length; i++) drawTree(scene.trees[i], treeBase + i, L, buf);
  postPass(buf);
  return crop(buf, vp);
}

// ---------------------------------------------------------------- scanline

type SpanFn = (y: number, x0: number, x1: number) => void;

/** Even-odd scanline fill at pixel centres, clipped to the viewport. */
function scan(vp: Viewport, rings: number[][], cb: SpanFn): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rings) {
    for (let i = 1; i < r.length; i += 2) {
      if (r[i] < minY) minY = r[i];
      if (r[i] > maxY) maxY = r[i];
    }
  }
  const y0 = Math.max(vp.y0, Math.ceil(minY - 0.5));
  const y1 = Math.min(vp.y0 + vp.h - 1, Math.floor(maxY - 0.5));
  const xMin = vp.x0;
  const xMax = vp.x0 + vp.w - 1;
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (const r of rings) {
      const k = r.length;
      for (let a = 0, b = k - 2; a < k; b = a, a += 2) {
        const ya = r[a + 1];
        const yb = r[b + 1];
        if (ya > yc !== yb > yc) xs.push(r[a] + ((yc - ya) * (r[b] - r[a])) / (yb - ya));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(xMin, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(xMax, Math.ceil(xs[k + 1] - 0.5) - 1);
      if (xa <= xb) cb(y, xa, xb);
    }
  }
}

function project(L: Layout, ring: number[], h: number): number[] {
  const out = new Array<number>(ring.length);
  for (let i = 0; i < ring.length; i += 2) {
    out[i] = (ring[i] + ring[i + 1]) * K + L.ox;
    out[i + 1] = (ring[i] - ring[i + 1]) * (K / 2) - h * KZ + L.oy;
  }
  return out;
}

/** World position of the ground under an image pixel centre. */
function groundAt(L: Layout, x: number, y: number): [number, number] {
  const s = (x + 0.5 - L.ox) / K;
  const d = (2 * (y + 0.5 - L.oy)) / K;
  return [(s + d) / 2, (s - d) / 2];
}

/** Restrict a span to the map's diamond. */
function diamond(L: Layout, y: number, x0: number, x1: number): [number, number] {
  const d = (2 * (y + 0.5 - L.oy)) / K;
  const h2 = 2 * L.half;
  const lo = Math.max(-h2 - d, d - h2) * K + L.ox;
  const hi = Math.min(h2 - d, d + h2) * K + L.ox;
  return [Math.max(x0, Math.ceil(lo - 0.5)), Math.min(x1, Math.ceil(hi - 0.5) - 1)];
}

function put(buf: Buf, i: number, c: RGB, mat: number): void {
  buf.rgb[i * 3] = c[0];
  buf.rgb[i * 3 + 1] = c[1];
  buf.rgb[i * 3 + 2] = c[2];
  buf.mat[i] = mat;
}

// ---------------------------------------------------------------- ground

const GROUND_COLOR: Record<GroundKind, RGB> = {
  lot: GROUND.grass,
  concreteLot: GROUND.concreteLot,
  farm: GROUND.farm,
  grass: GROUND.grass,
  scrub: GROUND.scrub,
  park: GROUND.park,
  cemetery: GROUND.park,
  forest: GROUND.forest,
  pitch: GROUND.pitch,
  track: GROUND.track,
  sand: GROUND.sand,
  rock: GROUND.rock,
  dirt: GROUND.dirt,
  parking: GROUND.parking,
  paving: GROUND.paving,
  plaza: GROUND.plaza,
  water: GROUND.water,
  pier: GROUND.paving,
};

function noise(x: number, y: number): number {
  return hash01(x, y, 0x51);
}

function groundPixel(kind: GroundKind | "base", x: number, y: number, e: number, n: number): [RGB, number] {
  switch (kind) {
    case "water": {
      const ripple = y % 5 === 0 && (x + ((y / 5) | 0) * 7) % 16 < 3;
      return [ripple ? GROUND.waterLight : GROUND.water, Mat.Water];
    }
    case "plaza":
    case "paving":
    case "pier": {
      const line = ((e % 2.5) + 2.5) % 2.5 < 0.45 || ((n % 2.5) + 2.5) % 2.5 < 0.45;
      return [line ? GROUND.pavingLine : GROUND_COLOR[kind], Mat.Ground];
    }
    case "farm": {
      const row = ((e % 4) + 4) % 4 < 1.2;
      return [row ? shade(GROUND.farm, 0.9) : GROUND.farm, Mat.Ground];
    }
    case "pitch": {
      const stripe = ((((e + n) / 6) | 0) & 1) === 0;
      return [stripe ? GROUND.pitch : shade(GROUND.pitch, 0.94), Mat.Ground];
    }
    case "base":
    case "lot":
    case "grass":
    case "park":
    case "cemetery":
    case "forest":
    case "scrub": {
      const base = kind === "base" ? GROUND.grass : GROUND_COLOR[kind];
      const r = noise(x, y);
      return [r < 0.12 ? shade(base, 0.9) : r > 0.95 ? shade(base, 1.08) : base, Mat.Ground];
    }
    default: {
      const base = GROUND_COLOR[kind];
      return [noise(x, y) < 0.1 ? shade(base, 0.94) : base, Mat.Ground];
    }
  }
}

function drawGround(scene: Scene, L: Layout, buf: Buf): void {
  const vp = buf.vp;
  for (let y = vp.y0; y < vp.y0 + vp.h; y++) {
    const [xa, xb] = diamond(L, y, vp.x0, vp.x0 + vp.w - 1);
    const row = (y - vp.y0) * vp.w - vp.x0;
    for (let x = xa; x <= xb; x++) {
      const [e, n] = groundAt(L, x, y);
      const sea = scene.sea !== null && maskAt(scene.sea, e, n);
      const [c, m] = groundPixel(sea ? "water" : "base", x, y, e, n);
      put(buf, row + x, c, m);
    }
  }
  for (const g of scene.grounds) {
    fillGround(L, buf, g.rings.map((r) => project(L, r, 0)), g.kind);
  }
  for (const w of scene.waterLines) {
    fillGround(L, buf, thickLine(L, w.pts, w.width), "water", true);
  }
  waterEdges(buf);
  for (const r of scene.roads) {
    if (r.kind === "major" || r.kind === "minor" || r.kind === "motorway") {
      fillFlat(L, buf, thickLine(L, r.pts, r.width + 6), GROUND.sidewalk, Mat.Road, true);
    }
  }
  for (const r of scene.roads) drawRoad(L, buf, r);
  for (const r of scene.rails) {
    if (!r.tram) fillFlat(L, buf, thickLine(L, r.pts, 3.4), GROUND.ballast, Mat.Road);
    for (const off of [-0.75, 0.75]) polyline(L, buf, offsetLine(r.pts, off), GROUND.rail);
  }
  for (const r of scene.roads) if (r.marking !== "none" && r.width >= 8) dashes(L, buf, r);
}

/** Fill area rings together (even-odd, so holes work), or with `union` each ring on its own. */
function fillGround(L: Layout, buf: Buf, rings: number[][], kind: GroundKind, union = false): void {
  if (union) {
    for (const r of rings) fillGround(L, buf, [r], kind);
    return;
  }
  const vp = buf.vp;
  scan(vp, rings, (y, x0, x1) => {
    const [xa, xb] = diamond(L, y, x0, x1);
    const row = (y - vp.y0) * vp.w - vp.x0;
    for (let x = xa; x <= xb; x++) {
      const [e, n] = groundAt(L, x, y);
      const [c, m] = groundPixel(kind, x, y, e, n);
      put(buf, row + x, c, m);
    }
  });
}

/** Fill each ring on its own (a union of overlapping parts), optionally leaving water alone. */
function fillFlat(L: Layout, buf: Buf, rings: number[][], c: RGB, mat: number, keepWater = false): void {
  const vp = buf.vp;
  for (const r of rings) {
    scan(vp, [r], (y, x0, x1) => {
      const [xa, xb] = diamond(L, y, x0, x1);
      const row = (y - vp.y0) * vp.w - vp.x0;
      for (let x = xa; x <= xb; x++) {
        if (keepWater && buf.mat[row + x] === Mat.Water) continue;
        put(buf, row + x, c, mat);
      }
    });
  }
}

function drawRoad(L: Layout, buf: Buf, r: Road): void {
  switch (r.kind) {
    case "path":
      fillFlat(L, buf, thickLine(L, r.pts, r.width), GROUND.footway, Mat.Road);
      return;
    case "pedestrian":
      fillGround(L, buf, thickLine(L, r.pts, r.width), "plaza", true);
      return;
    default:
      fillFlat(L, buf, thickLine(L, r.pts, r.width), r.kind === "minor" || r.kind === "service" ? GROUND.asphalt : GROUND.asphaltMajor, Mat.Road);
  }
}

/** A thick polyline as one quad per segment plus an octagon at every joint. */
function thickLine(L: Layout, pts: number[], width: number): number[][] {
  const out: number[][] = [];
  const w = width / 2;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i];
    const y0 = pts[i + 1];
    const x1 = pts[i + 2];
    const y1 = pts[i + 3];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len === 0) continue;
    const nx = (-(y1 - y0) / len) * w;
    const ny = ((x1 - x0) / len) * w;
    out.push(project(L, [x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny], 0));
  }
  for (let i = 2; i + 3 < pts.length; i += 2) {
    const oct: number[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4 + Math.PI / 8;
      oct.push(pts[i] + Math.cos(a) * w, pts[i + 1] + Math.sin(a) * w);
    }
    out.push(project(L, oct, 0));
  }
  // Callers fill each part on its own so overlapping parts do not cancel out.
  return out;
}

function offsetLine(pts: number[], d: number): number[] {
  const out: number[] = [];
  const k = pts.length / 2;
  for (let i = 0; i < k; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(k - 1, i + 1);
    const dx = pts[b * 2] - pts[a * 2];
    const dy = pts[b * 2 + 1] - pts[a * 2 + 1];
    const len = Math.hypot(dx, dy) || 1;
    out.push(pts[i * 2] - (dy / len) * d, pts[i * 2 + 1] + (dx / len) * d);
  }
  return out;
}

function polyline(L: Layout, buf: Buf, pts: number[], c: RGB): void {
  const p = project(L, pts, 0);
  for (let i = 0; i + 3 < p.length; i += 2) line(L, buf, p[i], p[i + 1], p[i + 2], p[i + 3], c);
}

function dashes(L: Layout, buf: Buf, r: Road): void {
  const c = r.marking === "yellow" ? GROUND.markingYellow : GROUND.marking;
  let phase = 0;
  for (let i = 0; i + 3 < r.pts.length; i += 2) {
    const x0 = r.pts[i];
    const y0 = r.pts[i + 1];
    const dx = r.pts[i + 2] - x0;
    const dy = r.pts[i + 3] - y0;
    const len = Math.hypot(dx, dy);
    let d = 0;
    while (d < len) {
      const inDash = phase < 3;
      const step = Math.min(len - d, inDash ? 3 - phase : 7 - phase);
      if (inDash && step > 0.3) {
        const a = project(L, [x0 + (dx * d) / len, y0 + (dy * d) / len, x0 + (dx * (d + step)) / len, y0 + (dy * (d + step)) / len], 0);
        line(L, buf, a[0], a[1], a[2], a[3], c);
      }
      d += step;
      phase = (phase + step) % 7;
    }
  }
}

/** One-pixel ground line (Bresenham), clipped to the map. */
function line(L: Layout, buf: Buf, fx0: number, fy0: number, fx1: number, fy1: number, c: RGB): void {
  const vp = buf.vp;
  let x0 = Math.floor(fx0);
  let y0 = Math.floor(fy0);
  const x1 = Math.floor(fx1);
  const y1 = Math.floor(fy1);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 100000; guard++) {
    if (x0 >= vp.x0 && x0 < vp.x0 + vp.w && y0 >= vp.y0 && y0 < vp.y0 + vp.h) {
      const [xa, xb] = diamond(L, y0, x0, x0);
      if (xa <= xb) put(buf, (y0 - vp.y0) * vp.w + (x0 - vp.x0), c, Mat.Road);
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** A light shoreline wherever water meets land. */
function waterEdges(buf: Buf): void {
  const { vp, mat, rgb } = buf;
  const w = vp.w;
  const edge = new Uint8Array(vp.w * vp.h);
  for (let y = 1; y < vp.h; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mat[i] !== Mat.Water) continue;
      const up = mat[i - w];
      const left = mat[i - 1];
      const right = mat[i + 1];
      if ((up !== Mat.Water && up !== Mat.Void) || (left !== Mat.Water && left !== Mat.Void) || (right !== Mat.Water && right !== Mat.Void)) edge[i] = 1;
    }
  }
  for (let i = 0; i < edge.length; i++) {
    if (!edge[i]) continue;
    rgb[i * 3] = GROUND.waterEdge[0];
    rgb[i * 3 + 1] = GROUND.waterEdge[1];
    rgb[i * 3 + 2] = GROUND.waterEdge[2];
  }
}

/** The diorama base: the two front edges of the map drop away as an earth slab. */
function drawSlab(L: Layout, buf: Buf): void {
  const h = L.half;
  const faces: [number, number, number, number, number][] = [
    [-h, -h, h, -h, 0.9],
    [h, -h, h, h, 0.7],
  ];
  for (const [e0, n0, e1, n1, f] of faces) {
    const quad = [...project(L, [e0, n0, e1, n1], 0), ...project(L, [e1, n1, e0, n0], -SLAB_DEPTH)];
    const vp = buf.vp;
    scan(vp, [quad], (y, x0, x1) => {
      const row = (y - vp.y0) * vp.w - vp.x0;
      for (let x = x0; x <= x1; x++) {
        const i = row + x;
        if (buf.mat[i] !== Mat.Void) continue;
        // Height below ground at this pixel, from the top edge of the face.
        const s = (x + 0.5 - L.ox) / K;
        const eMinusN = e0 === e1 ? 2 * e0 - s : s - 2 * n0;
        const depthBelow = (y + 0.5 - L.oy - (eMinusN * K) / 2) / KZ;
        const band = depthBelow < 1.2 ? GROUND.slabTop : Math.floor(depthBelow / 3.5) % 2 === 0 ? GROUND.slabDark : GROUND.slabStripe;
        put(buf, i, shade(band, f), Mat.Slab);
      }
    });
  }
}

// ---------------------------------------------------------------- buildings

const LIGHT_E = -0.6;
const LIGHT_N = -0.8;
const SUN = normalize3(-0.5, -0.75, 1.0);

function wallTone(nx: number, ny: number): number {
  const d = nx * LIGHT_E + ny * LIGHT_N;
  return d > 0.45 ? 1.0 : d > -0.2 ? 0.84 : 0.68;
}

function roofTone(a: number, b: number): number {
  const len = Math.hypot(a, b, 1);
  const d = (-a * SUN[0] - b * SUN[1] + SUN[2]) / len;
  return d > 0.9 ? 1.08 : d > 0.7 ? 0.96 : d > 0.45 ? 0.82 : 0.68;
}

function roofAt(b: Building, e: number, n: number): number {
  let h = Infinity;
  for (const p of b.planes) {
    const v = p.a * e + p.b * n + p.c;
    if (v < h) h = v;
  }
  return h;
}

function onScreen(b: Building, L: Layout, vp: Viewport): boolean {
  const xMin = (b.minE + b.minN) * K + L.ox;
  const xMax = (b.maxE + b.maxN) * K + L.ox;
  const yMin = (b.minE - b.maxN) * (K / 2) - b.maxH * KZ + L.oy;
  const yMax = (b.maxE - b.minN) * (K / 2) + L.oy;
  return xMax >= vp.x0 - 1 && xMin <= vp.x0 + vp.w + 1 && yMax >= vp.y0 - 1 && yMin <= vp.y0 + vp.h + 1;
}

function drawBuilding(b: Building, id: number, L: Layout, buf: Buf): void {
  if (!onScreen(b, L, buf.vp)) return;
  for (let r = 0; r < b.rings.length; r++) {
    const ring = b.rings[r];
    const ccw = signed(ring) > 0;
    const outwardRight = b.outer[r] === ccw;
    const k = ring.length;
    for (let i = 0; i < k; i += 2) {
      const j = (i + 2) % k;
      const e0 = ring[i];
      const n0 = ring[i + 1];
      const e1 = ring[j];
      const n1 = ring[j + 1];
      const de = e1 - e0;
      const dn = n1 - n0;
      const len = Math.hypot(de, dn);
      if (len < 1e-6) continue;
      const nx = (outwardRight ? dn : -dn) / len;
      const ny = (outwardRight ? -de : de) / len;
      if (nx - ny <= 0.02) continue;
      drawWall(b, id, L, buf, e0, n0, e1, n1, wallTone(nx, ny));
    }
  }
  for (let p = 0; p < b.planes.length; p++) drawRoofPlane(b, id, L, buf, p);
}

function signed(r: number[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a;
}

function drawWall(b: Building, id: number, L: Layout, buf: Buf, e0: number, n0: number, e1: number, n1: number, tone: number): void {
  const de = e1 - e0;
  const dn = n1 - n0;
  const ds = de + dn;
  if (Math.abs(ds) < 1e-6) return;
  // Breakpoints where the roof profile above this wall changes plane.
  const ts = [0, 1];
  const ps = b.planes;
  for (let a = 0; a < ps.length; a++) {
    for (let c = a + 1; c < ps.length; c++) {
      const fa0 = ps[a].a * e0 + ps[a].b * n0 + ps[a].c;
      const fc0 = ps[c].a * e0 + ps[c].b * n0 + ps[c].c;
      const sa = ps[a].a * de + ps[a].b * dn;
      const sc = ps[c].a * de + ps[c].b * dn;
      if (Math.abs(sa - sc) < 1e-9) continue;
      const t = (fc0 - fa0) / (sa - sc);
      if (t > 0 && t < 1) ts.push(t);
    }
  }
  ts.sort((p, q) => p - q);

  const vp = buf.vp;
  const wall = shade(b.wall, tone);
  const wallDark = shade(b.wall, tone * 0.9);
  const winDay = WINDOW.day;
  const winGlint = WINDOW.dayGlint;
  const shop = WINDOW.shop;
  const s0 = e0 + n0;
  const xStart = s0 * K + L.ox;
  const xEnd = (e1 + n1) * K + L.ox;
  const leftToRight = xEnd > xStart;
  const widthPx = Math.floor(Math.abs(xEnd - xStart));
  const colBase = leftToRight ? Math.floor(xStart) : Math.floor(xStart);
  const lh = b.levelH;
  const rgb = buf.rgb;

  for (let q = 0; q + 1 < ts.length; q++) {
    const ta = ts[q];
    const tb = ts[q + 1];
    if (tb - ta < 1e-6) continue;
    const ea = e0 + de * ta;
    const na = n0 + dn * ta;
    const eb = e0 + de * tb;
    const nb = n0 + dn * tb;
    const ha = roofAt(b, ea, na);
    const hb = roofAt(b, eb, nb);
    const quad = [...project(L, [ea, na, eb, nb], 0), ...project(L, [eb, nb], hb), ...project(L, [ea, na], ha)];
    scan(vp, [quad], (y, x0, x1) => {
      const row = (y - vp.y0) * vp.w - vp.x0;
      const sy = y + 0.5 - L.oy;
      for (let x = x0; x <= x1; x++) {
        const t = ((x + 0.5 - L.ox) / K - s0) / ds;
        const e = e0 + de * t;
        const n = n0 + dn * t;
        const emn = e - n;
        const h = ((emn * K) / 2 - sy) / KZ;
        const depth = emn * A + h * 0.5;
        const i = row + x;
        if (depth <= buf.depth[i]) continue;
        buf.depth[i] = depth;
        buf.id[i] = id;
        let c = wall;
        let mat = Mat.Wall;
        let lit = 0;
        if (b.windows) {
          const col = leftToRight ? x - colBase : colBase - x;
          const lv = Math.floor(h / lh);
          const fh = h - lv * lh;
          const top = roofAt(b, e, n);
          if (col >= 1 && col < widthPx - 1 && h < top - 0.9) {
            if (b.shopFront && lv === 0) {
              if (fh > 0.35 && fh < 2.5 && col % b.winPeriod !== 0) {
                c = shop;
                mat = Mat.Window;
                lit = 1 + Math.floor(hash01(b.seed, col >> 3, 99) * 120);
              }
            } else if (col % b.winPeriod < b.winWidth && fh > 0.95 && fh < 2.35) {
              c = fh > 2.0 ? winGlint : winDay;
              mat = Mat.Window;
              const wc = Math.floor(col / b.winPeriod);
              const r = hash01(b.seed, lv * 977 + wc, 7);
              lit = r < 0.82 ? 1 + Math.floor(r * 300) : 0;
              if (lit > 255) lit = 255;
            }
          }
          if (mat === Mat.Wall && fh < 0.35 && lv > 0) c = wallDark;
        }
        rgb[i * 3] = c[0];
        rgb[i * 3 + 1] = c[1];
        rgb[i * 3 + 2] = c[2];
        buf.mat[i] = mat;
        buf.lit[i] = lit;
      }
    });
  }
}

function drawRoofPlane(b: Building, id: number, L: Layout, buf: Buf, p: number): void {
  const pl = b.planes[p];
  const rings: number[][] = [];
  for (const ring of b.rings) {
    let r = ring;
    for (let q = 0; q < b.planes.length && r.length >= 6; q++) {
      if (q === p) continue;
      const o = b.planes[q];
      r = clipRing(r, pl.a - o.a, pl.b - o.b, pl.c - o.c);
    }
    if (r.length < 6) continue;
    const out: number[] = [];
    for (let i = 0; i < r.length; i += 2) {
      const h = pl.a * r[i] + pl.b * r[i + 1] + pl.c;
      out.push((r[i] + r[i + 1]) * K + L.ox, (r[i] - r[i + 1]) * (K / 2) - h * KZ + L.oy);
    }
    rings.push(out);
  }
  if (rings.length === 0) return;
  const tone = roofTone(pl.a, pl.b);
  const base = shade(b.roofColor, tone);
  const alt = shade(b.roofColor, tone * 0.88);
  const flat = pl.a === 0 && pl.b === 0;
  const pq = pl.a - pl.b;
  const denom = 1 - (pq * KZ) / K;
  if (Math.abs(denom) < 1e-6) return;
  const vp = buf.vp;
  const rgb = buf.rgb;
  scan(vp, rings, (y, x0, x1) => {
    const row = (y - vp.y0) * vp.w - vp.x0;
    const sy = y + 0.5 - L.oy;
    for (let x = x0; x <= x1; x++) {
      const s = (x + 0.5 - L.ox) / K;
      const h = ((s * (pl.a + pl.b)) / 2 + (pq * sy) / K + pl.c) / denom;
      const d = (2 * (sy + KZ * h)) / K;
      const depth = d * A + h * 0.5;
      const i = row + x;
      if (depth <= buf.depth[i]) continue;
      buf.depth[i] = depth;
      buf.id[i] = id;
      let c = base;
      if (flat) {
        if (noise(x, y) < 0.14) c = alt;
      } else if (Math.floor(h * 2.2) % 2 === 0) {
        c = alt;
      }
      rgb[i * 3] = c[0];
      rgb[i * 3 + 1] = c[1];
      rgb[i * 3 + 2] = c[2];
      buf.mat[i] = Mat.Roof;
      buf.lit[i] = 0;
    }
  });
}

// ---------------------------------------------------------------- trees

function drawTree(t: Tree, id: number, L: Layout, buf: Buf): void {
  const vp = buf.vp;
  const cx = (t.e + t.n) * K + L.ox;
  const baseY = (t.e - t.n) * (K / 2) + L.oy;
  const rp = t.r * K * 1.1;
  const topH = t.cone ? t.trunk * 0.4 + t.r * 3 : t.trunk + t.r * 2;
  const yTop = baseY - topH * KZ;
  if (cx + rp < vp.x0 || cx - rp > vp.x0 + vp.w || baseY < vp.y0 || yTop > vp.y0 + vp.h) return;
  const depth = (t.e - t.n) * A + t.trunk * 0.5;
  const light = t.cone ? TREE.needleLight : TREE.leafLight;
  const mid = t.cone ? TREE.needleMid : TREE.leafMid;
  const dark = t.cone ? TREE.needleDark : TREE.leafDark;
  const write = (x: number, y: number, c: RGB) => {
    if (x < vp.x0 || y < vp.y0 || x >= vp.x0 + vp.w || y >= vp.y0 + vp.h) return;
    const i = (y - vp.y0) * vp.w + (x - vp.x0);
    if (depth <= buf.depth[i]) return;
    buf.depth[i] = depth;
    buf.id[i] = id;
    put(buf, i, c, Mat.Tree);
    buf.lit[i] = 0;
  };
  const ix = Math.floor(cx);
  // Trunk.
  const trunkTop = Math.floor(baseY - t.trunk * KZ);
  for (let y = Math.floor(baseY); y >= trunkTop; y--) write(ix, y, TREE.trunk);
  if (t.cone) {
    const hPx = (topH - t.trunk * 0.4) * KZ;
    const bottom = Math.floor(baseY - t.trunk * 0.4 * KZ);
    for (let dy = 0; dy <= hPx; dy++) {
      const half = Math.max(0, Math.round(((hPx - dy) / hPx) * rp * 0.85));
      const y = bottom - dy;
      for (let dx = -half; dx <= half; dx++) {
        const rel = dx / (half + 1);
        const c = rel < -0.3 ? light : rel > 0.35 ? dark : mid;
        write(ix + dx, y, (dy & 3) === 0 && dx > 0 ? dark : c);
      }
    }
    return;
  }
  const ccy = baseY - (t.trunk + t.r) * KZ;
  const ry = rp * 1.0;
  const r2 = Math.ceil(rp + 1);
  for (let dy = -r2; dy <= r2; dy++) {
    for (let dx = -r2; dx <= r2; dx++) {
      const nx = dx / rp;
      const ny = dy / ry;
      const dist = nx * nx + ny * ny;
      const wobble = 0.78 + 0.32 * hash01(t.seed, dx + 64, dy + 64);
      if (dist > wobble) continue;
      const lightness = -nx * 0.7 - ny * 0.9 + (hash01(t.seed, dy, dx) - 0.5) * 0.5;
      const c = lightness > 0.45 ? light : lightness < -0.35 ? dark : mid;
      write(ix + dx, Math.floor(ccy) + dy, c);
    }
  }
}

// ---------------------------------------------------------------- post

/** Dark outline on the silhouette of every raised object, light rim on roof edges. */
function postPass(buf: Buf): void {
  const { vp, id, depth, rgb, mat } = buf;
  const w = vp.w;
  const outline = new Uint8Array(w * vp.h);
  for (let y = 1; y < vp.h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const me = id[i];
      if (me === 0) continue;
      const d = depth[i];
      let edge = false;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (id[j] !== me && (id[j] === 0 || depth[j] < d - 1.5)) {
          edge = true;
          break;
        }
      }
      if (edge) outline[i] = 1;
      else if (mat[i] === Mat.Roof && mat[i + w] !== Mat.Roof && id[i + w] === me) outline[i] = 2;
    }
  }
  for (let i = 0; i < outline.length; i++) {
    const o = outline[i];
    if (o === 0) continue;
    const f = o === 1 ? (mat[i] === Mat.Tree ? 0.72 : 0.6) : 1.18;
    const c = shade([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]], f);
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  }
}

function crop(buf: Buf, vp: Viewport): Frame {
  const out: Frame = { vp, rgb: new Uint8Array(vp.w * vp.h * 3), mat: new Uint8Array(vp.w * vp.h), lit: new Uint8Array(vp.w * vp.h) };
  const bw = buf.vp.w;
  for (let y = 0; y < vp.h; y++) {
    const src = (y + 1) * bw + 1;
    out.rgb.set(buf.rgb.subarray(src * 3, (src + vp.w) * 3), y * vp.w * 3);
    out.mat.set(buf.mat.subarray(src, src + vp.w), y * vp.w);
    out.lit.set(buf.lit.subarray(src, src + vp.w), y * vp.w);
  }
  // Void pixels take the background colour.
  for (let i = 0; i < vp.w * vp.h; i++) {
    if (out.mat[i] !== Mat.Void) continue;
    out.rgb[i * 3] = GROUND.void[0];
    out.rgb[i * 3 + 1] = GROUND.void[1];
    out.rgb[i * 3 + 2] = GROUND.void[2];
  }
  return out;
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}
