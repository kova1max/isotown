// Small 2D helpers over flat [x0, y0, x1, y1, ...] rings.

import type { Ring } from "./osm.js";

export function signedArea(r: Ring): number {
  let a = 0;
  const k = r.length;
  for (let i = 0; i < k; i += 2) {
    const j = (i + 2) % k;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a / 2;
}

export function centroid(r: Ring): [number, number] {
  let cx = 0;
  let cy = 0;
  let a = 0;
  const k = r.length;
  for (let i = 0; i < k; i += 2) {
    const j = (i + 2) % k;
    const c = r[i] * r[j + 1] - r[j] * r[i + 1];
    a += c;
    cx += (r[i] + r[j]) * c;
    cy += (r[i + 1] + r[j + 1]) * c;
  }
  if (Math.abs(a) < 1e-9) return [r[0], r[1]];
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInRings(rings: Ring[], x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) {
    const k = r.length;
    for (let i = 0, j = k - 2; i < k; j = i, i += 2) {
      const yi = r[i + 1];
      const yj = r[j + 1];
      if (yi > y !== yj > y && x < ((r[j] - r[i]) * (y - yi)) / (yj - yi) + r[i]) inside = !inside;
    }
  }
  return inside;
}

export interface OrientedRect {
  cx: number;
  cy: number;
  /** Unit vector of the long axis. */
  ax: number;
  ay: number;
  /** Half length along the long axis and half width across it. */
  halfL: number;
  halfW: number;
}

/** Minimum-area enclosing rectangle via the convex hull's edge directions. */
export function orientedRect(r: Ring): OrientedRect {
  const hull = convexHull(r);
  let best: OrientedRect | undefined;
  let bestArea = Infinity;
  const k = hull.length;
  for (let i = 0; i < k; i += 2) {
    const j = (i + 2) % k;
    let dx = hull[j] - hull[i];
    let dy = hull[j + 1] - hull[i + 1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    dx /= len;
    dy /= len;
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (let m = 0; m < k; m += 2) {
      const a = hull[m] * dx + hull[m + 1] * dy;
      const b = -hull[m] * dy + hull[m + 1] * dx;
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    const area = (maxA - minA) * (maxB - minB);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      const ca = (minA + maxA) / 2;
      const cb = (minB + maxB) / 2;
      const cx = ca * dx - cb * dy;
      const cy = ca * dy + cb * dx;
      const la = (maxA - minA) / 2;
      const lb = (maxB - minB) / 2;
      best = la >= lb ? { cx, cy, ax: dx, ay: dy, halfL: la, halfW: lb } : { cx, cy, ax: -dy, ay: dx, halfL: lb, halfW: la };
    }
  }
  if (!best) return { cx: r[0], cy: r[1], ax: 1, ay: 0, halfL: 0, halfW: 0 };
  return best;
}

export function convexHull(r: Ring): number[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < r.length; i += 2) pts.push([r[i], r[i + 1]]);
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return hull.flat();
}

/** Keep the part of a ring where a*x + b*y + c <= 0 (Sutherland-Hodgman). */
export function clipRing(r: Ring, a: number, b: number, c: number): Ring {
  const out: number[] = [];
  const k = r.length;
  for (let i = 0; i < k; i += 2) {
    const j = (i + 2) % k;
    const x0 = r[i];
    const y0 = r[i + 1];
    const x1 = r[j];
    const y1 = r[j + 1];
    const d0 = a * x0 + b * y0 + c;
    const d1 = a * x1 + b * y1 + c;
    if (d0 <= 0) out.push(x0, y0);
    if ((d0 < 0 && d1 > 0) || (d0 > 0 && d1 < 0)) {
      const t = d0 / (d0 - d1);
      out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  }
  return out;
}

/** Deterministic 32-bit hash of up to three integers, as a float in [0, 1). */
export function hash01(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Hash of a string id such as "w12345". */
export function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
