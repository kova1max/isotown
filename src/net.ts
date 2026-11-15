// Polite OSM network access: one descriptive User-Agent, an on-disk cache so a
// repeated run makes zero requests, sequential requests with a minimum gap, and
// fallback across public Overpass mirrors.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BBox } from "./geo.js";

export const VERSION = "0.1.0";
export const USER_AGENT = `isotown/${VERSION} (+https://github.com/kova1max/isotown)`;

export const DEFAULT_NOMINATIM = "https://nominatim.openstreetmap.org";
export const DEFAULT_OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache"), "isotown");
}

export interface NetStats {
  requests: number;
  cacheHits: number;
}

export class Net {
  stats: NetStats = { requests: 0, cacheHits: 0 };
  private lastRequestAt = 0;

  constructor(
    readonly cacheDir: string,
    private readonly log: (msg: string) => void,
  ) {}

  /** Read a cached JSON body, or fetch it and cache it. */
  async cached<T>(kind: string, key: string, fetcher: () => Promise<string>): Promise<{ value: T; cached: boolean }> {
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const dir = join(this.cacheDir, kind);
    const file = join(dir, `${hash}.json`);
    try {
      const text = await readFile(file, "utf8");
      this.stats.cacheHits++;
      return { value: JSON.parse(text) as T, cached: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const body = await fetcher();
    const value = JSON.parse(body) as T;
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
    return { value, cached: false };
  }

  /** One HTTP request, at least `gapMs` after the previous one. */
  async request(url: string, init: RequestInit, gapMs: number): Promise<Response> {
    const wait = this.lastRequestAt + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
    this.stats.requests++;
    const headers = new Headers(init.headers);
    headers.set("User-Agent", USER_AGENT);
    try {
      return await fetch(url, { ...init, headers, signal: AbortSignal.timeout(180_000) });
    } finally {
      this.lastRequestAt = Date.now();
    }
  }

  async geocode(nominatimUrl: string, query: string): Promise<GeocodeResult> {
    const url = `${nominatimUrl.replace(/\/$/, "")}/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const { value } = await this.cached<NominatimHit[]>("nominatim", url, async () => {
      // Nominatim usage policy: at most one request per second per application.
      const res = await this.request(url, { headers: { Accept: "application/json" } }, 1100);
      if (!res.ok) throw new Error(`Nominatim returned HTTP ${res.status} for "${query}"`);
      return await res.text();
    });
    const hit = value[0];
    if (!hit) throw new Error(`Nominatim found no place called "${query}"`);
    return { lat: Number(hit.lat), lon: Number(hit.lon), name: hit.display_name };
  }

  /** Fetch one Overpass cell, trying each mirror in turn with backoff. */
  async overpass(mirrors: string[], query: string): Promise<{ value: OverpassResponse; cached: boolean }> {
    return this.cached<OverpassResponse>("overpass", query, async () => {
      const errors: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const mirror of mirrors) {
          let res: Response;
          try {
            res = await this.request(
              mirror,
              {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: `data=${encodeURIComponent(query)}`,
              },
              1000,
            );
          } catch (err) {
            errors.push(`${mirror}: ${(err as Error).message}`);
            continue;
          }
          if (res.ok) {
            const text = await res.text();
            const failure = overpassFailure(text);
            if (!failure) return text;
            errors.push(`${mirror}: ${failure}`);
            continue;
          }
          errors.push(`${mirror}: HTTP ${res.status}`);
          await res.arrayBuffer().catch(() => undefined);
        }
        const backoff = 5000 * 2 ** attempt;
        this.log(`overpass busy, retrying in ${backoff / 1000} s`);
        await sleep(backoff);
      }
      throw new Error(`every Overpass mirror failed:\n  ${errors.slice(-mirrors.length).join("\n  ")}`);
    });
  }
}

export interface GeocodeResult {
  lat: number;
  lon: number;
  name: string;
}

interface NominatimHit {
  lat: string;
  lon: string;
  display_name: string;
}

export interface OverpassResponse {
  elements: OsmElement[];
  remark?: string;
}

export interface LatLonPoint {
  lat: number;
  lon: number;
}

export type OsmElement =
  | { type: "node"; id: number; lat: number; lon: number; tags?: Record<string, string> }
  | { type: "way"; id: number; geometry?: (LatLonPoint | null)[]; tags?: Record<string, string> }
  | {
      type: "relation";
      id: number;
      members?: { type: string; ref: number; role: string; geometry?: (LatLonPoint | null)[] }[];
      tags?: Record<string, string>;
    };

export function overpassQuery(b: BBox): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  const nat = "^(water|wood|scrub|grassland|heath|wetland|beach|sand|bare_rock|scree|coastline|tree_row)$";
  return `[out:json][timeout:120];
(
  way["building"](${bb});
  relation["building"]["type"="multipolygon"](${bb});
  way["highway"](${bb});
  way["railway"~"^(rail|tram|light_rail|subway|narrow_gauge|platform)$"](${bb});
  way["waterway"~"^(river|canal|stream|riverbank|dock)$"](${bb});
  way["natural"~"${nat}"](${bb});
  relation["natural"~"${nat}"]["type"="multipolygon"](${bb});
  way["landuse"](${bb});
  relation["landuse"]["type"="multipolygon"](${bb});
  way["leisure"~"^(park|garden|pitch|playground|golf_course|common|recreation_ground|nature_reserve|marina|stadium|track)$"](${bb});
  relation["leisure"~"^(park|garden|pitch|golf_course|common|recreation_ground|nature_reserve|stadium)$"]["type"="multipolygon"](${bb});
  way["amenity"~"^(parking|grave_yard)$"](${bb});
  relation["amenity"~"^(parking|grave_yard)$"]["type"="multipolygon"](${bb});
  way["man_made"~"^(pier|breakwater|groyne)$"](${bb});
  way["place"="square"](${bb});
  node["natural"="tree"](${bb});
);
out geom;`;
}

/** Overpass reports some failures inside an HTTP 200 body; never cache those. */
export function overpassFailure(text: string): string | undefined {
  if (!text.trimStart().startsWith("{")) return "response was not JSON";
  const remark = /"remark"\s*:\s*"([^"]*)"/.exec(text.slice(-2000))?.[1];
  if (remark && /error|timed out|out of memory/i.test(remark)) return remark;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
