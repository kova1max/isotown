// Fetch every Overpass cell of a frame, one at a time, each cached on its own so
// an interrupted run resumes where it stopped.

import { type Frame, frameCells } from "./geo.js";
import { type Net, type OsmElement, overpassQuery } from "./net.js";

export interface FetchReport {
  cells: number;
  cachedCells: number;
  elements: OsmElement[];
}

export async function fetchFrame(
  net: Net,
  frame: Frame,
  mirrors: string[],
  progress: (done: number, total: number, cached: boolean) => void,
): Promise<FetchReport> {
  const cells = frameCells(frame);
  const elements: OsmElement[] = [];
  let cachedCells = 0;
  for (let i = 0; i < cells.length; i++) {
    const { value, cached } = await net.overpass(mirrors, overpassQuery(cells[i]));
    if (cached) cachedCells++;
    for (const el of value.elements) elements.push(el);
    progress(i + 1, cells.length, cached);
  }
  return { cells: cells.length, cachedCells, elements };
}
