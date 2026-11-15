// Local metric frame around a centre point, and the square area split into
// Overpass cells. Distances up to a few km, so an equirectangular frame is
// accurate to well under a pixel.

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Frame {
  lat0: number;
  lon0: number;
  /** Half the side of the square area, in metres. */
  half: number;
  mPerDegLat: number;
  mPerDegLon: number;
}

export const MAX_AREA_KM2 = 25;

export function makeFrame(lat0: number, lon0: number, areaKm2: number): Frame {
  const side = Math.sqrt(areaKm2) * 1000;
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * rad(lat0));
  const mPerDegLon = 111412.84 * Math.cos(rad(lat0));
  return { lat0, lon0, half: side / 2, mPerDegLat, mPerDegLon };
}

export function toLocal(f: Frame, lat: number, lon: number): [number, number] {
  return [(lon - f.lon0) * f.mPerDegLon, (lat - f.lat0) * f.mPerDegLat];
}

export function frameBBox(f: Frame): BBox {
  const dLat = f.half / f.mPerDegLat;
  const dLon = f.half / f.mPerDegLon;
  return { south: f.lat0 - dLat, west: f.lon0 - dLon, north: f.lat0 + dLat, east: f.lon0 + dLon };
}

/** Split the frame into an n x n grid of cells no larger than 1 km a side. */
export function frameCells(f: Frame): BBox[] {
  const b = frameBBox(f);
  const n = Math.max(1, Math.ceil((f.half * 2) / 1000 - 1e-9));
  const cells: BBox[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      cells.push({
        south: round7(b.south + ((b.north - b.south) * j) / n),
        north: round7(b.south + ((b.north - b.south) * (j + 1)) / n),
        west: round7(b.west + ((b.east - b.west) * i) / n),
        east: round7(b.west + ((b.east - b.west) * (i + 1)) / n),
      });
    }
  }
  return cells;
}

function rad(d: number): number {
  return (d * Math.PI) / 180;
}

function round7(x: number): number {
  return Math.round(x * 1e7) / 1e7;
}
