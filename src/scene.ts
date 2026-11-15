// Classify OSM features into what gets drawn: typed buildings with roof planes,
// ground areas, roads, rails, water lines, trees, and a sea mask.

import { centroid, hash01, hashId, orientedRect, pointInRings, signedArea } from "./geometry.js";
import type { AreaFeature, OsmData, Ring, Tags } from "./osm.js";
import { type RGB, ROOFS, WALLS } from "./palette.js";

export type RoofShape = "flat" | "gabled" | "hipped" | "pyramidal" | "skillion" | "mansard";

/** Roof plane: h = a*e + b*n + c. The roof surface is the minimum over all planes. */
export interface Plane {
  a: number;
  b: number;
  c: number;
}

export type BuildingKind = "house" | "block" | "flat" | "church" | "shed" | "industrial" | "detail";

export interface Building {
  seed: number;
  kind: BuildingKind;
  /** Rings with their solid side: outer rings first, then inner (courtyard) rings. */
  rings: Ring[];
  outer: boolean[];
  wallTop: number;
  roof: RoofShape;
  planes: Plane[];
  maxH: number;
  wall: RGB;
  roofColor: RGB;
  windows: boolean;
  levelH: number;
  /** Window columns: a window every `winPeriod` screen pixels, `winWidth` wide. */
  winPeriod: number;
  winWidth: number;
  shopFront: boolean;
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
}

export type GroundKind =
  | "lot"
  | "concreteLot"
  | "farm"
  | "grass"
  | "scrub"
  | "park"
  | "cemetery"
  | "forest"
  | "pitch"
  | "track"
  | "sand"
  | "rock"
  | "dirt"
  | "parking"
  | "paving"
  | "plaza"
  | "water"
  | "pier";

export interface GroundArea {
  kind: GroundKind;
  rings: Ring[];
  prio: number;
  area: number;
}

export type RoadKind = "motorway" | "major" | "minor" | "service" | "path" | "pedestrian";

export interface Road {
  kind: RoadKind;
  pts: number[];
  width: number;
  rank: number;
  marking: "none" | "white" | "yellow";
}

export interface Rail {
  pts: number[];
  tram: boolean;
}

export interface WaterLine {
  pts: number[];
  width: number;
}

export interface Tree {
  e: number;
  n: number;
  r: number;
  trunk: number;
  cone: boolean;
  seed: number;
}

export interface Mask {
  res: number;
  size: number;
  half: number;
  data: Uint8Array;
}

export interface Scene {
  half: number;
  buildings: Building[];
  grounds: GroundArea[];
  roads: Road[];
  rails: Rail[];
  waterLines: WaterLine[];
  trees: Tree[];
  sea: Mask | null;
  stats: SceneStats;
}

export interface SceneStats {
  buildings: number;
  withHeight: number;
  withLevels: number;
  typed: number;
  trees: number;
}

const LEVEL_H = 3.0;

export function buildScene(data: OsmData, half: number): Scene {
  const stats: SceneStats = { buildings: 0, withHeight: 0, withLevels: 0, typed: 0, trees: 0 };
  const buildings: Building[] = [];
  const grounds: GroundArea[] = [];
  const roads: Road[] = [];
  const rails: Rail[] = [];
  const waterLines: WaterLine[] = [];
  const coast: number[][] = [];
  const treeRows: number[][] = [];
  const forests: { rings: Ring[]; spacing: number; p: number; conifer: number }[] = [];
  const trees: Tree[] = [];

  for (const a of data.areas) {
    const t = a.tags;
    if (t.building && t.building !== "no") {
      if (isUnderground(t)) continue;
      // Only whole buildings: one cut by the map edge would overhang the base.
      if (!a.poly.outer.every((r) => r.every((v) => Math.abs(v) <= half))) continue;
      const made = makeBuilding(a, stats);
      for (const b of made) buildings.push(b);
      continue;
    }
    const kind = groundKind(t);
    if (!kind) continue;
    const rings = [...a.poly.outer, ...a.poly.inner];
    const area = a.poly.outer.reduce((s, r) => s + Math.abs(signedArea(r)), 0);
    grounds.push({ kind, rings, prio: GROUND_PRIO[kind], area });
    const leaf = t.leaf_type;
    if (kind === "forest") {
      forests.push({ rings, spacing: 6, p: 0.9, conifer: leaf === "needleleaved" ? 1 : leaf === "mixed" ? 0.5 : 0.1 });
    } else if (kind === "park") {
      forests.push({ rings, spacing: 11, p: 0.35, conifer: 0.1 });
    } else if (kind === "cemetery") {
      forests.push({ rings, spacing: 10, p: 0.4, conifer: 0.4 });
    } else if (kind === "scrub") {
      forests.push({ rings, spacing: 9, p: 0.3, conifer: 0 });
    }
  }

  for (const l of data.lines) {
    const t = l.tags;
    if (t.natural === "coastline") {
      coast.push(l.pts);
    } else if (t.natural === "tree_row") {
      treeRows.push(l.pts);
    } else if (t.highway) {
      const road = makeRoad(t, l.pts);
      if (road) roads.push(road);
    } else if (t.railway) {
      if (isUnderground(t) || t.railway === "platform") continue;
      rails.push({ pts: l.pts, tram: t.railway === "tram" });
    } else if (t.waterway && t.tunnel === undefined) {
      const width = parseNumber(t.width) ?? WATERWAY_WIDTH[t.waterway];
      if (width) waterLines.push({ pts: l.pts, width: Math.min(width, 60) });
    }
  }

  // Highway areas and platforms tagged as closed ways come through as lines;
  // pedestrian areas are already ground via `area=yes`.
  roads.sort((p, q) => p.rank - q.rank);
  grounds.sort((p, q) => p.prio - q.prio || q.area - p.area);

  const sea = coast.length > 0 ? seaMask(coast, half) : null;
  const blocked = blockedMask(half, buildings, grounds, sea);

  for (const p of data.points) {
    if (p.tags.natural !== "tree") continue;
    if (Math.abs(p.e) > half || Math.abs(p.n) > half) continue;
    trees.push(makeTree(p.e, p.n, hashId(p.id), p.tags.leaf_type === "needleleaved"));
  }
  for (const pts of treeRows) {
    for (const [e, n] of along(pts, 7)) {
      if (Math.abs(e) > half || Math.abs(n) > half || maskAt(blocked, e, n)) continue;
      trees.push(makeTree(e, n, hashCoord(e, n), false));
    }
  }
  for (const f of forests) scatter(f, half, blocked, trees);
  stats.trees = trees.length;
  stats.buildings = buildings.filter((b) => b.kind !== "detail").length;

  return { half, buildings, grounds, roads, rails, waterLines, trees, sea, stats };
}

// ---------------------------------------------------------------- buildings

const HOUSE = new Set([
  "house",
  "detached",
  "semidetached_house",
  "bungalow",
  "villa",
  "farm",
  "farmhouse",
  "cabin",
  "static_caravan",
  "barn",
  "farm_auxiliary",
  "stable",
  "dormitory",
]);
const SHED = new Set(["garage", "garages", "shed", "carport", "hut", "kiosk", "roof", "greenhouse", "toilets", "service", "container"]);
const WORSHIP = new Set(["church", "cathedral", "chapel", "basilica", "monastery", "temple", "mosque", "synagogue", "shrine"]);
const INDUSTRIAL = new Set(["industrial", "warehouse", "factory", "manufacture", "hangar", "storage_tank", "data_center", "silo"]);
const FLAT = new Set([
  "commercial",
  "retail",
  "office",
  "supermarket",
  "hospital",
  "school",
  "university",
  "college",
  "public",
  "civic",
  "government",
  "train_station",
  "transportation",
  "hotel",
  "stadium",
  "sports_hall",
  "sports_centre",
  "parking",
  "mall",
  "fire_station",
  "bank",
]);
const ROW = new Set(["terrace", "townhouse"]);

function makeBuilding(a: AreaFeature, stats: SceneStats): Building[] {
  const t = a.tags;
  const seed = hashId(a.id);
  const outerRing = largest(a.poly.outer);
  const area = a.poly.outer.reduce((s, r) => s + Math.abs(signedArea(r)), 0) - a.poly.inner.reduce((s, r) => s + Math.abs(signedArea(r)), 0);
  if (area < 4) return [];
  const rect = orientedRect(outerRing);
  const rectArea = 4 * rect.halfL * rect.halfW;
  const rectangularity = rectArea > 0 ? area / rectArea : 0;
  const aspect = rect.halfW > 0 ? rect.halfL / rect.halfW : 1;

  const type = t.building;
  const worship = WORSHIP.has(type) || t.amenity === "place_of_worship";
  let kind: BuildingKind;
  if (worship) kind = "church";
  else if (SHED.has(type) || area < 25) kind = "shed";
  else if (INDUSTRIAL.has(type)) kind = "industrial";
  else if (FLAT.has(type) || t.shop || t.amenity) kind = "flat";
  else if (HOUSE.has(type) || ROW.has(type)) kind = "house";
  else kind = "block";
  if (type !== "yes") stats.typed++;

  const heightTag = parseNumber(t.height);
  const levelsTag = parseNumber(t["building:levels"]);
  if (heightTag !== undefined) stats.withHeight++;
  if (levelsTag !== undefined) stats.withLevels++;
  const roofLevels = parseNumber(t["roof:levels"]) ?? 0;
  const jitter = hash01(seed, 7);

  let levels = levelsTag ?? defaultLevels(kind, type, area, jitter);
  if (kind === "block" && levelsTag === undefined && area > 3000) kind = "flat";
  if (levels >= 6 && kind !== "church" && kind !== "house") kind = "flat";

  // Roof rule: an explicit roof:shape tag wins, otherwise the class decides.
  let roof = roofFromTag(t["roof:shape"]) ?? defaultRoof(kind, type, levels, area, aspect, rectangularity);
  if (rect.halfW < 1.5 && roof !== "flat") roof = "skillion";

  const levelH = kind === "industrial" ? 4.5 : LEVEL_H;
  let roofH = roofHeight(roof, rect.halfW, kind);
  const roofHTag = parseNumber(t["roof:height"]);
  if (roofHTag !== undefined) roofH = roofHTag;
  else if (roofLevels > 0 && roof !== "flat") roofH = Math.max(roofH, roofLevels * LEVEL_H);
  let wallTop: number;
  if (heightTag !== undefined) {
    wallTop = Math.max(2.5, heightTag - roofH);
    if (heightTag - roofH < 2.5) roofH = Math.max(0, heightTag - 2.5);
    if (levelsTag === undefined) levels = Math.max(1, Math.round(wallTop / levelH));
  } else {
    if (kind === "industrial" && levelsTag === undefined) levels = 1 + Math.floor(jitter * 2);
    wallTop = levels * levelH + (kind === "flat" || roof === "flat" ? 0.8 : 0.3);
  }
  if (roof === "flat") roofH = 0;

  const { wall, roofColor } = colours(kind, roof, seed);
  const rings = [...a.poly.outer, ...a.poly.inner];
  const outer = [...a.poly.outer.map(() => true), ...a.poly.inner.map(() => false)];
  const planes = roofPlanes(roof, rect, wallTop, roofH, seed);
  const shopFront = (kind === "flat" || kind === "block") && levels >= 3 && (t.shop !== undefined || type === "retail" || type === "commercial" || hash01(seed, 3) < 0.25);
  const main = finish({
    seed,
    kind,
    rings,
    outer,
    wallTop,
    roof,
    planes,
    maxH: wallTop + roofH,
    wall,
    roofColor,
    windows: kind !== "shed",
    levelH,
    winPeriod: kind === "house" ? 4 : kind === "industrial" ? 6 : 3,
    winWidth: kind === "house" || kind === "industrial" ? 2 : 1,
    shopFront,
  });
  const out = [main];

  if (kind === "church" && rect.halfL >= 7 && t["roof:shape"] === undefined) {
    out.push(churchTower(rect, wallTop, roofH, seed));
  }
  if (roof === "flat" && area >= 250 && kind !== "church") {
    const n = Math.min(4, 1 + Math.floor(area / 500));
    for (let i = 0; i < n; i++) {
      const box = rooftopBox(rect, outerRing, wallTop, seed, i);
      if (box) out.push(box);
    }
  }
  return out;
}

function defaultLevels(kind: BuildingKind, type: string, area: number, jitter: number): number {
  switch (kind) {
    case "shed":
      return 1;
    case "church":
      return 4;
    case "industrial":
      return 2;
    case "house":
      if (type === "bungalow" || type === "static_caravan") return 1;
      if (type === "terrace" || type === "townhouse") return 2 + Math.floor(jitter * 2);
      return area > 120 && jitter > 0.5 ? 2 : jitter > 0.25 ? 2 : 1;
    case "flat":
      return area > 1500 ? 3 + Math.floor(jitter * 3) : 2 + Math.floor(jitter * 3);
    default:
      if (type === "apartments") return 4 + Math.floor(jitter * 3);
      if (area < 60) return 1 + Math.floor(jitter * 2);
      if (area < 200) return 2 + Math.floor(jitter * 2);
      if (area < 800) return 3 + Math.floor(jitter * 2);
      return 4 + Math.floor(jitter * 2);
  }
}

function roofFromTag(shape: string | undefined): RoofShape | undefined {
  switch (shape) {
    case "flat":
      return "flat";
    case "gabled":
    case "saltbox":
    case "gambrel":
    case "round":
      return "gabled";
    case "hipped":
    case "half-hipped":
    case "side_hipped":
    case "dome":
      return "hipped";
    case "pyramidal":
    case "onion":
    case "cone":
      return "pyramidal";
    case "skillion":
    case "lean_to":
      return "skillion";
    case "mansard":
      return "mansard";
    default:
      return undefined;
  }
}

/** The six roof rules by building class. */
function defaultRoof(kind: BuildingKind, type: string, levels: number, area: number, aspect: number, rectangularity: number): RoofShape {
  switch (kind) {
    case "shed":
      return "skillion";
    case "industrial":
    case "flat":
      return "flat";
    case "church":
      return "gabled";
    case "house":
      if (aspect < 1.25 && rectangularity > 0.7) return area < 90 ? "pyramidal" : "hipped";
      return rectangularity > 0.75 ? "gabled" : "hipped";
    default:
      if (type === "apartments" && levels >= 4 && area > 300) return "mansard";
      if (area > 1200) return "flat";
      if (area > 400) return rectangularity > 0.8 && levels <= 6 ? "mansard" : "flat";
      if (aspect < 1.2 && rectangularity > 0.8) return "hipped";
      return rectangularity > 0.6 ? "gabled" : "hipped";
  }
}

function roofHeight(roof: RoofShape, halfW: number, kind: BuildingKind): number {
  switch (roof) {
    case "flat":
      return 0;
    case "gabled":
      return Math.min(kind === "church" ? 16 : 7, halfW * (kind === "church" ? 1.4 : 0.85));
    case "hipped":
      return Math.min(6, halfW * 0.7);
    case "pyramidal":
      return Math.min(7, halfW * 0.9);
    case "skillion":
      return Math.min(2.5, halfW * 0.35);
    case "mansard":
      return 3;
  }
}

function roofPlanes(roof: RoofShape, r: ReturnType<typeof orientedRect>, top: number, h: number, seed: number): Plane[] {
  const bx = -r.ay;
  const by = r.ax;
  // h = top + s * (d - (P - C) . u)
  const plane = (ux: number, uy: number, d: number, s: number): Plane => ({
    a: -s * ux,
    b: -s * uy,
    c: top + s * d + s * (r.cx * ux + r.cy * uy),
  });
  const W = Math.max(r.halfW, 0.5);
  const L = Math.max(r.halfL, 0.5);
  switch (roof) {
    case "flat":
      return [{ a: 0, b: 0, c: top }];
    case "gabled": {
      const s = h / W;
      return [plane(bx, by, W, s), plane(-bx, -by, W, s)];
    }
    case "hipped": {
      const s = h / W;
      return [plane(bx, by, W, s), plane(-bx, -by, W, s), plane(r.ax, r.ay, L, s), plane(-r.ax, -r.ay, L, s)];
    }
    case "pyramidal": {
      return [plane(bx, by, W, h / W), plane(-bx, -by, W, h / W), plane(r.ax, r.ay, L, h / L), plane(-r.ax, -r.ay, L, h / L)];
    }
    case "mansard": {
      const inset = Math.min(1.8, W * 0.45);
      const s = h / inset;
      return [
        plane(bx, by, W, s),
        plane(-bx, -by, W, s),
        plane(r.ax, r.ay, L, s),
        plane(-r.ax, -r.ay, L, s),
        { a: 0, b: 0, c: top + h },
      ];
    }
    case "skillion": {
      // High side away from the viewer (the viewer looks from the south-east).
      const towardViewer = bx - by > 0 ? 1 : -1;
      const ux = bx * towardViewer;
      const uy = by * towardViewer;
      void seed;
      return [plane(ux, uy, W, h / (2 * W))];
    }
  }
}

function churchTower(r: ReturnType<typeof orientedRect>, wallTop: number, roofH: number, seed: number): Building {
  const side = Math.max(4, Math.min(9, r.halfW * 1.3));
  // Towers usually stand at the west end.
  const dir = r.ax < 0 ? 1 : -1;
  const cx = r.cx + r.ax * dir * (r.halfL - side / 2);
  const cy = r.cy + r.ay * dir * (r.halfL - side / 2);
  const ring = squareRing(cx, cy, side / 2, r.ax, r.ay);
  const top = wallTop + roofH + 4 + hash01(seed, 11) * 8;
  const spire = side * (1.6 + hash01(seed, 12) * 1.2);
  const rect = { cx, cy, ax: r.ax, ay: r.ay, halfL: side / 2, halfW: side / 2 };
  const copper = hash01(seed, 13) < 0.4;
  return finish({
    seed: seed ^ 0x5151,
    kind: "detail",
    rings: [ring],
    outer: [true],
    wallTop: top,
    roof: "pyramidal",
    planes: roofPlanes("pyramidal", rect, top, spire, seed),
    maxH: top + spire,
    wall: WALLS.stone,
    roofColor: copper ? ROOFS.copper : ROOFS.slate,
    windows: false,
    levelH: LEVEL_H,
    winPeriod: 4,
    winWidth: 1,
    shopFront: false,
  });
}

function rooftopBox(r: ReturnType<typeof orientedRect>, outerRing: Ring, top: number, seed: number, i: number): Building | undefined {
  const side = 1.5 + hash01(seed, 20 + i) * 2.5;
  const fa = (hash01(seed, 30 + i) * 2 - 1) * Math.max(0, r.halfL - side - 1);
  const fb = (hash01(seed, 40 + i) * 2 - 1) * Math.max(0, r.halfW - side - 1);
  const cx = r.cx + r.ax * fa - r.ay * fb;
  const cy = r.cy + r.ay * fa + r.ax * fb;
  const ring = squareRing(cx, cy, side / 2, r.ax, r.ay);
  for (let k = 0; k < ring.length; k += 2) if (!pointInRings([outerRing], ring[k], ring[k + 1])) return undefined;
  const h = top + 1.2 + hash01(seed, 50 + i) * 1.6;
  return finish({
    seed: seed ^ (0x777 + i),
    kind: "detail",
    rings: [ring],
    outer: [true],
    wallTop: h,
    roof: "flat",
    planes: [{ a: 0, b: 0, c: h }],
    maxH: h,
    wall: WALLS.concrete,
    roofColor: ROOFS.lightGravel,
    windows: false,
    levelH: LEVEL_H,
    winPeriod: 4,
    winWidth: 1,
    shopFront: false,
  });
}

function squareRing(cx: number, cy: number, h: number, ax: number, ay: number): Ring {
  const bx = -ay;
  const by = ax;
  return [
    cx - ax * h - bx * h,
    cy - ay * h - by * h,
    cx + ax * h - bx * h,
    cy + ay * h - by * h,
    cx + ax * h + bx * h,
    cy + ay * h + by * h,
    cx - ax * h + bx * h,
    cy - ay * h + by * h,
  ];
}

function finish(b: Omit<Building, "minE" | "maxE" | "minN" | "maxN">): Building {
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const r of b.rings) {
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < minE) minE = r[i];
      if (r[i] > maxE) maxE = r[i];
      if (r[i + 1] < minN) minN = r[i + 1];
      if (r[i + 1] > maxN) maxN = r[i + 1];
    }
  }
  return { ...b, minE, maxE, minN, maxN };
}

function colours(kind: BuildingKind, roof: RoofShape, seed: number): { wall: RGB; roofColor: RGB } {
  const pick = <T>(xs: readonly T[], k: number): T => xs[Math.floor(hash01(seed, k) * xs.length)];
  switch (kind) {
    case "church":
      return { wall: pick([WALLS.stone, WALLS.greyStone, WALLS.cream], 1), roofColor: pick([ROOFS.slate, ROOFS.copper, ROOFS.darkGrey], 2) };
    case "industrial":
      return { wall: pick([WALLS.metal, WALLS.concrete, WALLS.blueGrey, WALLS.cream], 1), roofColor: pick([ROOFS.metalRoof, ROOFS.gravel, ROOFS.tar], 2) };
    case "flat":
      return { wall: pick([WALLS.concrete, WALLS.blueGrey, WALLS.cream, WALLS.white, WALLS.greyStone, WALLS.brick], 1), roofColor: pick([ROOFS.gravel, ROOFS.lightGravel, ROOFS.tar], 2) };
    case "shed":
      return { wall: pick([WALLS.concrete, WALLS.cream, WALLS.darkBrick], 1), roofColor: pick([ROOFS.darkGrey, ROOFS.metalRoof, ROOFS.brownTile], 2) };
    default: {
      const wall = pick([WALLS.brick, WALLS.brick, WALLS.darkBrick, WALLS.cream, WALLS.white, WALLS.ochre, WALLS.pink, WALLS.greyStone], 1);
      if (roof === "flat") return { wall, roofColor: pick([ROOFS.gravel, ROOFS.tar, ROOFS.lightGravel], 2) };
      if (roof === "mansard") return { wall, roofColor: pick([ROOFS.slate, ROOFS.darkGrey, ROOFS.slate, ROOFS.terracotta], 2) };
      return { wall, roofColor: pick([ROOFS.terracotta, ROOFS.terracotta, ROOFS.brownTile, ROOFS.slate, ROOFS.darkGrey], 2) };
    }
  }
}

// ---------------------------------------------------------------- ground

const GROUND_PRIO: Record<GroundKind, number> = {
  lot: 1,
  concreteLot: 1,
  farm: 2,
  grass: 3,
  scrub: 3,
  park: 3,
  cemetery: 3,
  forest: 4,
  dirt: 4,
  pitch: 5,
  track: 6,
  sand: 5,
  rock: 5,
  parking: 6,
  paving: 6,
  plaza: 7,
  water: 8,
  pier: 9,
};

function groundKind(t: Tags): GroundKind | undefined {
  if (t.natural === "water" || t.waterway === "riverbank" || t.waterway === "dock") return "water";
  if (t.landuse === "reservoir" || t.landuse === "basin" || t.water) return "water";
  if (t.man_made === "pier" || t.man_made === "breakwater" || t.man_made === "groyne") return "pier";
  if (t.highway === "pedestrian" || t.place === "square" || t.highway === "footway") return "plaza";
  if (t.railway === "platform" || t.highway === "platform") return "paving";
  if (t.amenity === "parking") return "parking";
  if (t.amenity === "grave_yard" || t.landuse === "cemetery") return "cemetery";
  switch (t.natural) {
    case "wood":
      return "forest";
    case "scrub":
    case "heath":
    case "wetland":
      return "scrub";
    case "grassland":
      return "grass";
    case "beach":
    case "sand":
      return "sand";
    case "bare_rock":
    case "scree":
      return "rock";
  }
  switch (t.leisure) {
    case "park":
    case "garden":
    case "golf_course":
    case "nature_reserve":
    case "common":
    case "recreation_ground":
      return "park";
    case "pitch":
    case "stadium":
      return "pitch";
    case "track":
      return "track";
    case "playground":
      return "sand";
  }
  switch (t.landuse) {
    case "forest":
      return "forest";
    case "grass":
    case "meadow":
    case "village_green":
    case "recreation_ground":
    case "greenfield":
      return "grass";
    case "farmland":
    case "orchard":
    case "vineyard":
    case "allotments":
    case "plant_nursery":
      return "farm";
    case "residential":
      return "lot";
    case "commercial":
    case "retail":
    case "industrial":
    case "railway":
    case "garages":
      return "concreteLot";
    case "construction":
    case "brownfield":
    case "landfill":
    case "quarry":
      return "dirt";
  }
  return undefined;
}

const WATERWAY_WIDTH: Record<string, number> = { river: 18, canal: 10, stream: 3 };

function makeRoad(t: Tags, pts: number[]): Road | undefined {
  if (isUnderground(t) || t.area === "yes") return undefined;
  const hw = t.highway;
  let kind: RoadKind;
  let width: number;
  let rank: number;
  let marking: Road["marking"] = "none";
  switch (hw) {
    case "motorway":
    case "trunk":
      kind = "motorway";
      width = 16;
      rank = 9;
      marking = "white";
      break;
    case "motorway_link":
    case "trunk_link":
      kind = "major";
      width = 8;
      rank = 8;
      break;
    case "primary":
      kind = "major";
      width = 13;
      rank = 7;
      marking = "yellow";
      break;
    case "secondary":
      kind = "major";
      width = 11;
      rank = 6;
      marking = "white";
      break;
    case "tertiary":
      kind = "major";
      width = 9;
      rank = 5;
      marking = "white";
      break;
    case "primary_link":
    case "secondary_link":
    case "tertiary_link":
      kind = "major";
      width = 7;
      rank = 5;
      break;
    case "residential":
    case "unclassified":
    case "living_street":
    case "road":
    case "busway":
      kind = "minor";
      width = 7;
      rank = 4;
      break;
    case "service":
      kind = "service";
      width = t.service === "parking_aisle" || t.service === "driveway" ? 3.5 : 4.5;
      rank = 3;
      break;
    case "pedestrian":
      kind = "pedestrian";
      width = 6;
      rank = 2;
      break;
    case "track":
      kind = "path";
      width = 3;
      rank = 1;
      break;
    case "footway":
    case "path":
    case "cycleway":
    case "bridleway":
    case "steps":
    case "corridor":
      if (t.footway === "sidewalk" || t.footway === "crossing") return undefined;
      kind = "path";
      width = 2.2;
      rank = 1;
      break;
    default:
      return undefined;
  }
  const w = parseNumber(t.width);
  if (w !== undefined && w > 1 && w < 40 && kind !== "path") width = w;
  return { kind, pts, width, rank, marking };
}

// ---------------------------------------------------------------- trees

function makeTree(e: number, n: number, seed: number, cone: boolean): Tree {
  const r = 2.2 + hash01(seed, 1) * 1.8;
  return { e, n, r, trunk: 1.8 + hash01(seed, 2) * 1.6, cone, seed };
}

function scatter(f: { rings: Ring[]; spacing: number; p: number; conifer: number }, half: number, blocked: Mask, out: Tree[]): void {
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const r of f.rings) {
    for (let i = 0; i < r.length; i += 2) {
      minE = Math.min(minE, r[i]);
      maxE = Math.max(maxE, r[i]);
      minN = Math.min(minN, r[i + 1]);
      maxN = Math.max(maxN, r[i + 1]);
    }
  }
  minE = Math.max(minE, -half);
  maxE = Math.min(maxE, half);
  minN = Math.max(minN, -half);
  maxN = Math.min(maxN, half);
  const s = f.spacing;
  for (let gn = Math.floor(minN / s); gn * s <= maxN; gn++) {
    for (let ge = Math.floor(minE / s); ge * s <= maxE; ge++) {
      const h = hash01(ge, gn, 991);
      if (h > f.p) continue;
      const e = (ge + 0.15 + 0.7 * hash01(ge, gn, 17)) * s;
      const n = (gn + 0.15 + 0.7 * hash01(ge, gn, 23)) * s;
      if (e < minE || e > maxE || n < minN || n > maxN) continue;
      if (maskAt(blocked, e, n) || !pointInRings(f.rings, e, n)) continue;
      out.push(makeTree(e, n, hashCoord(e, n), hash01(ge, gn, 31) < f.conifer));
    }
  }
}

function along(pts: number[], step: number): [number, number][] {
  const out: [number, number][] = [];
  let carry = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const dx = pts[i + 2] - pts[i];
    const dy = pts[i + 3] - pts[i + 1];
    const len = Math.hypot(dx, dy);
    let d = carry;
    while (d < len) {
      out.push([pts[i] + (dx * d) / len, pts[i + 1] + (dy * d) / len]);
      d += step;
    }
    carry = d - len;
  }
  return out;
}

function hashCoord(e: number, n: number): number {
  return Math.floor(hash01(Math.round(e * 10), Math.round(n * 10), 5) * 4294967296);
}

// ---------------------------------------------------------------- masks

function newMask(half: number, res: number): Mask {
  const size = Math.ceil((half * 2) / res) + 1;
  return { res, size, half, data: new Uint8Array(size * size) };
}

export function maskAt(m: Mask, e: number, n: number): boolean {
  const i = Math.floor((e + m.half) / m.res);
  const j = Math.floor((m.half - n) / m.res);
  if (i < 0 || j < 0 || i >= m.size || j >= m.size) return false;
  return m.data[j * m.size + i] !== 0;
}

/** Fill rings (even-odd) into a mask, row by row at cell centres. */
function fillMask(m: Mask, rings: Ring[], value: number): void {
  let minN = Infinity;
  let maxN = -Infinity;
  for (const r of rings) {
    for (let i = 1; i < r.length; i += 2) {
      minN = Math.min(minN, r[i]);
      maxN = Math.max(maxN, r[i]);
    }
  }
  const j0 = Math.max(0, Math.floor((m.half - maxN) / m.res));
  const j1 = Math.min(m.size - 1, Math.ceil((m.half - minN) / m.res));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const n = m.half - (j + 0.5) * m.res;
    xs.length = 0;
    for (const r of rings) {
      const k = r.length;
      for (let a = 0, b = k - 2; a < k; b = a, a += 2) {
        const ya = r[a + 1];
        const yb = r[b + 1];
        if (ya > n !== yb > n) xs.push(r[a] + ((n - ya) * (r[b] - r[a])) / (yb - ya));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] + m.half) / m.res - 0.5));
      const i1 = Math.min(m.size - 1, Math.floor((xs[k + 1] + m.half) / m.res - 0.5));
      for (let i = i0; i <= i1; i++) m.data[j * m.size + i] = value;
    }
  }
}

function blockedMask(half: number, buildings: Building[], grounds: GroundArea[], sea: Mask | null): Mask {
  const m = newMask(half, 1);
  for (const g of grounds) if (g.kind === "water" || g.kind === "pitch" || g.kind === "plaza") fillMask(m, g.rings, 1);
  for (const b of buildings) fillMask(m, b.rings.map((r) => grow(r, 2)), 1);
  if (sea) {
    for (let j = 0; j < m.size; j++) {
      for (let i = 0; i < m.size; i++) {
        const e = -half + (i + 0.5) * m.res;
        const n = half - (j + 0.5) * m.res;
        if (maskAt(sea, e, n)) m.data[j * m.size + i] = 1;
      }
    }
  }
  return m;
}

/** Push every vertex away from the centroid by `d` metres (good enough for tree clearance). */
function grow(r: Ring, d: number): Ring {
  const [cx, cy] = centroid(r);
  const out: number[] = [];
  for (let i = 0; i < r.length; i += 2) {
    const dx = r[i] - cx;
    const dy = r[i + 1] - cy;
    const len = Math.hypot(dx, dy) || 1;
    out.push(r[i] + (dx / len) * d, r[i + 1] + (dy / len) * d);
  }
  return out;
}

/**
 * OSM has no sea polygons: the sea is whatever lies to the right of coastline
 * ways. Rasterise the coastlines as walls, flood-fill the regions between them,
 * and let samples taken just right (sea) and left (land) of each coastline vote.
 */
export function seaMask(coast: number[][], half: number): Mask {
  const m = newMask(half, 2);
  const size = m.size;
  const wall = new Uint8Array(size * size);
  const cell = (e: number, n: number) => {
    const i = Math.floor((e + half) / m.res);
    const j = Math.floor((half - n) / m.res);
    return i < 0 || j < 0 || i >= size || j >= size ? -1 : j * size + i;
  };
  const seaVotes: number[] = [];
  const landVotes: number[] = [];
  for (const pts of coast) {
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const x0 = pts[k];
      const y0 = pts[k + 1];
      const dx = pts[k + 2] - x0;
      const dy = pts[k + 3] - y0;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const steps = Math.ceil(len / (m.res / 2));
      for (let s = 0; s <= steps; s++) {
        const c = cell(x0 + (dx * s) / steps, y0 + (dy * s) / steps);
        if (c >= 0) wall[c] = 1;
      }
      const nx = dy / len;
      const ny = -dx / len;
      for (let d = m.res; d < len; d += m.res * 4) {
        const px = x0 + (dx * d) / len;
        const py = y0 + (dy * d) / len;
        const sc = cell(px + nx * m.res * 1.5, py + ny * m.res * 1.5);
        const lc = cell(px - nx * m.res * 1.5, py - ny * m.res * 1.5);
        if (sc >= 0) seaVotes.push(sc);
        if (lc >= 0) landVotes.push(lc);
      }
    }
  }
  const region = new Int32Array(size * size).fill(-1);
  const queue = new Int32Array(size * size);
  let regions = 0;
  for (let start = 0; start < size * size; start++) {
    if (wall[start] || region[start] >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    region[start] = regions;
    while (head < tail) {
      const c = queue[head++];
      const i = c % size;
      const nb = [i > 0 ? c - 1 : -1, i < size - 1 ? c + 1 : -1, c - size, c + size];
      for (const q of nb) {
        if (q < 0 || q >= size * size || wall[q] || region[q] >= 0) continue;
        region[q] = regions;
        queue[tail++] = q;
      }
    }
    regions++;
  }
  const score = new Int32Array(regions);
  for (const c of seaVotes) if (region[c] >= 0) score[region[c]]++;
  for (const c of landVotes) if (region[c] >= 0) score[region[c]]--;
  for (let c = 0; c < size * size; c++) {
    if (region[c] >= 0 && score[region[c]] > 0) m.data[c] = 1;
  }
  return m;
}

// ---------------------------------------------------------------- tags

function isUnderground(t: Tags): boolean {
  if (t.location === "underground" || t.tunnel === "yes" || t.tunnel === "building_passage" || t.covered === "yes") return true;
  const layer = parseNumber(t.layer);
  return layer !== undefined && layer < 0;
}

/** Parse "12", "12.5 m", "40'" or "12;14" into metres. */
export function parseNumber(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(m|ft|')?/.exec(v);
  if (!m) return undefined;
  const x = Number(m[1].replace(",", "."));
  if (!Number.isFinite(x)) return undefined;
  return m[2] === "ft" || m[2] === "'" ? x * 0.3048 : x;
}

function largest(rings: Ring[]): Ring {
  let best = rings[0];
  let bestA = -1;
  for (const r of rings) {
    const a = Math.abs(signedArea(r));
    if (a > bestA) {
      bestA = a;
      best = r;
    }
  }
  return best;
}
