// Turn raw Overpass elements (from several overlapping cells) into
// de-duplicated geometry in the local metric frame.

import { type Frame, toLocal } from "./geo.js";
import type { LatLonPoint, OsmElement } from "./net.js";

/** Flat [e0, n0, e1, n1, ...] ring without the closing duplicate point. */
export type Ring = number[];

export interface Polygon {
  outer: Ring[];
  inner: Ring[];
}

export type Tags = Record<string, string>;

export interface AreaFeature {
  id: string;
  tags: Tags;
  poly: Polygon;
}

export interface LineFeature {
  id: string;
  tags: Tags;
  pts: number[];
}

export interface PointFeature {
  id: string;
  tags: Tags;
  e: number;
  n: number;
}

export interface OsmData {
  areas: AreaFeature[];
  lines: LineFeature[];
  points: PointFeature[];
}

const AREA_KEYS = ["building", "landuse", "leisure", "amenity", "place", "water"];
const LINEAR_ONLY = new Set(["coastline", "tree_row"]);

export function parseElements(f: Frame, elements: OsmElement[]): OsmData {
  const seen = new Set<string>();
  const out: OsmData = { areas: [], lines: [], points: [] };
  for (const el of elements) {
    const id = `${el.type[0]}${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tags = el.tags ?? {};
    if (el.type === "node") {
      const [e, n] = toLocal(f, el.lat, el.lon);
      out.points.push({ id, tags, e, n });
    } else if (el.type === "way") {
      const pts = project(f, el.geometry);
      if (pts.length < 4) continue;
      if (isClosed(pts) && isArea(tags)) {
        const ring = pts.slice(0, -2);
        if (ring.length >= 6) out.areas.push({ id, tags, poly: { outer: [ring], inner: [] } });
      } else {
        out.lines.push({ id, tags, pts });
      }
    } else {
      const outerWays: number[][] = [];
      const innerWays: number[][] = [];
      for (const m of el.members ?? []) {
        if (m.type !== "way") continue;
        const pts = project(f, m.geometry);
        if (pts.length < 4) continue;
        (m.role === "inner" ? innerWays : outerWays).push(pts);
      }
      const outer = assembleRings(outerWays);
      if (outer.length === 0) continue;
      out.areas.push({ id, tags, poly: { outer, inner: assembleRings(innerWays) } });
    }
  }
  return out;
}

function project(f: Frame, geom: (LatLonPoint | null)[] | undefined): number[] {
  const pts: number[] = [];
  for (const p of geom ?? []) {
    if (!p) continue;
    const [e, n] = toLocal(f, p.lat, p.lon);
    pts.push(e, n);
  }
  return pts;
}

function isClosed(pts: number[]): boolean {
  const k = pts.length;
  return pts[0] === pts[k - 2] && pts[1] === pts[k - 1];
}

function isArea(tags: Tags): boolean {
  if (tags.area === "no") return false;
  if (tags.area === "yes") return true;
  if (tags.natural) return !LINEAR_ONLY.has(tags.natural);
  if (tags.waterway === "riverbank" || tags.waterway === "dock") return true;
  if (tags.man_made === "pier" || tags.man_made === "breakwater") return true;
  if (tags.highway || tags.railway || tags.waterway || tags.barrier) return false;
  return AREA_KEYS.some((k) => tags[k] !== undefined);
}

/** Join open member ways end to end into closed rings. Unclosable chains are dropped. */
export function assembleRings(ways: number[][]): Ring[] {
  const rings: Ring[] = [];
  const open: number[][] = [];
  for (const w of ways) {
    if (isClosed(w)) {
      if (w.length >= 8) rings.push(w.slice(0, -2));
    } else {
      open.push(w.slice());
    }
  }
  while (open.length > 0) {
    let chain = open.pop() as number[];
    let progress = true;
    while (!isClosed(chain) && progress) {
      progress = false;
      const ex = chain[chain.length - 2];
      const ey = chain[chain.length - 1];
      for (let i = 0; i < open.length; i++) {
        const w = open[i];
        const k = w.length;
        if (w[0] === ex && w[1] === ey) {
          chain = chain.concat(w.slice(2));
        } else if (w[k - 2] === ex && w[k - 1] === ey) {
          chain = chain.concat(reversePts(w).slice(2));
        } else {
          continue;
        }
        open.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (isClosed(chain) && chain.length >= 8) rings.push(chain.slice(0, -2));
  }
  return rings;
}

function reversePts(pts: number[]): number[] {
  const r: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i], pts[i + 1]);
  return r;
}
