#!/usr/bin/env node
// npx isotown "<city>" [--area 2] [--out dir]

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fetchFrame } from "./data.js";
import { MAX_AREA_KM2, makeFrame, toLocal } from "./geo.js";
import { encodePng, renderImage } from "./image.js";
import { DEFAULT_NOMINATIM, DEFAULT_OVERPASS, Net, VERSION, defaultCacheDir } from "./net.js";
import { parseElements } from "./osm.js";
import { dayNightGif, poster, viewerHtml, writeDeepZoom } from "./outputs.js";
import { K, KZ, makeLayout } from "./render.js";
import { buildScene } from "./scene.js";

const HELP = `isotown ${VERSION} - your city as a zoomable isometric pixel map, from OpenStreetMap

Usage: isotown "<place>" [options]
       isotown "<lat>,<lon>" [options]

Options:
  --area <km2>          size of the square city core, up to ${MAX_AREA_KM2} (default 2)
  --out <dir>           output directory (default ./isotown-<place>)
  --gif-at <lat,lon>    centre of the day/night GIF (default: the map centre)
  --overpass-url <url>  Overpass API endpoint (default: public mirrors, tried in turn)
  --nominatim-url <url> Nominatim endpoint (default: ${DEFAULT_NOMINATIM})
  --cache-dir <dir>     download cache (default: ${defaultCacheDir()})
  -h, --help            show this help
  -v, --version         show the version

Writes index.html (deep-zoom viewer), map.dzi + map_files/, poster.png and
daynight.gif. Map data © OpenStreetMap contributors, ODbL.`;

const OPTIONS = {
  area: { type: "string" },
  out: { type: "string" },
  "gif-at": { type: "string" },
  "overpass-url": { type: "string" },
  "nominatim-url": { type: "string" },
  "cache-dir": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

/** Lets a negative "lat,lon" stand as the place or an option value instead of reading as a short flag. */
function coordinateArgs(argv: string[]): string[] {
  const args: string[] = [];
  const coords: string[] = [];
  for (const a of argv) {
    if (!a.startsWith("-") || !parseLatLon(a)) {
      args.push(a);
      continue;
    }
    const prev = args[args.length - 1];
    const name = prev?.startsWith("--") ? prev.slice(2) : "";
    if (name in OPTIONS && OPTIONS[name as keyof typeof OPTIONS].type === "string") args[args.length - 1] = `${prev}=${a}`;
    else coords.push(a);
  }
  if (coords.length === 0) return args;
  return args.includes("--") ? [...args, ...coords] : [...args, "--", ...coords];
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: coordinateArgs(argv),
    allowPositionals: true,
    options: OPTIONS,
  });
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return values.help ? 0 : 2;
  }
  const place = positionals.join(" ").trim();
  const area = values.area === undefined ? 2 : Number(values.area);
  if (!Number.isFinite(area) || area <= 0) throw new UsageError(`--area must be a positive number of km2, got "${values.area}"`);
  if (area > MAX_AREA_KM2) {
    throw new UsageError(
      `--area ${area} is above the ${MAX_AREA_KM2} km2 limit. isotown draws a city core from the public Overpass API, ` +
        `which is shared by everyone; whole cities need a local extract (planned as --pbf).`,
    );
  }
  const gifAt = values["gif-at"] === undefined ? undefined : parseLatLon(values["gif-at"]);
  if (values["gif-at"] !== undefined && !gifAt) throw new UsageError(`--gif-at must look like "52.37,4.89", got "${values["gif-at"]}"`);
  const out = resolve(values.out ?? `isotown-${slug(place)}`);
  const mirrors = values["overpass-url"] ? [values["overpass-url"]] : DEFAULT_OVERPASS;
  const net = new Net(values["cache-dir"] ?? defaultCacheDir(), (m) => log(m));
  const started = Date.now();

  let lat: number;
  let lon: number;
  let name: string;
  const direct = parseLatLon(place);
  if (direct) {
    [lat, lon] = direct;
    name = place;
  } else {
    const hit = await net.geocode(values["nominatim-url"] ?? DEFAULT_NOMINATIM, place);
    lat = hit.lat;
    lon = hit.lon;
    name = hit.name;
  }
  log(`geocoded: ${name} (${lat.toFixed(5)}, ${lon.toFixed(5)})`);

  const fetchStarted = Date.now();
  const frame = makeFrame(lat, lon, area);
  const report = await fetchFrame(net, frame, mirrors, (done, total, cached) => {
    log(`fetched ${done}/${total} cells${cached ? " (cached)" : ""}`);
  });
  const fetchSeconds = (Date.now() - fetchStarted) / 1000;
  const renderStarted = Date.now();
  const data = parseElements(frame, report.elements);
  const scene = buildScene(data, frame.half);
  log(`${fmt(scene.stats.buildings)} buildings, ${fmt(scene.roads.length)} roads, ${fmt(scene.stats.trees)} trees in ${area} km2`);

  const layout = makeLayout(scene);
  log(`rendering ${fmt(layout.width)} x ${fmt(layout.height)} px`);
  const img = renderImage(scene, layout);

  await mkdir(out, { recursive: true });
  const title = direct ? place : shortName(name);
  const subtitle = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"} · ${area} km2`;
  const tiles = await writeDeepZoom(out, img);
  await writeFile(resolve(out, "index.html"), viewerHtml(title, subtitle, img.width, img.height));
  await writeFile(resolve(out, "poster.png"), encodePng(poster(img, title, subtitle.replace("·", "-"))));
  let centre = { x: layout.ox, y: layout.oy };
  if (gifAt) {
    const [e, n] = toLocal(frame, gifAt[0], gifAt[1]);
    centre = { x: (e + n) * K + layout.ox, y: (e - n) * (K / 2) - 10 * KZ + layout.oy };
  }
  await writeFile(resolve(out, "daynight.gif"), dayNightGif(scene, layout, centre));

  const renderSeconds = (Date.now() - renderStarted) / 1000;
  const totalSeconds = (Date.now() - started) / 1000;
  const st = scene.stats;
  const pct = (n: number) => (st.buildings === 0 ? 0 : Math.round((1000 * n) / st.buildings) / 10);
  const summary = {
    isotown: VERSION,
    place,
    name,
    lat,
    lon,
    areaKm2: area,
    cells: report.cells,
    cachedCells: report.cachedCells,
    requests: net.stats.requests,
    buildings: st.buildings,
    buildingsWithHeightPct: pct(st.withHeight),
    buildingsWithLevelsPct: pct(st.withLevels),
    buildingsTypedPct: pct(st.typed),
    roads: scene.roads.length,
    trees: st.trees,
    imageWidth: img.width,
    imageHeight: img.height,
    tiles,
    fetchSeconds: round1(fetchSeconds),
    renderSeconds: round1(renderSeconds),
    totalSeconds: round1(totalSeconds),
    attribution: "Map data © OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright",
  };
  await writeFile(resolve(out, "isotown.json"), `${JSON.stringify(summary, null, 2)}\n`);
  log(`wrote index.html, ${fmt(tiles)} tiles, poster.png, daynight.gif to ${shown(out)} in ${totalSeconds.toFixed(1)} s`);
  log(`network: ${net.stats.requests} requests, ${net.stats.cacheHits} cache hits`);
  log(`open ${shown(resolve(out, "index.html"))} in a browser to explore the map`);
  log(`Map data © OpenStreetMap contributors (ODbL). Keep this attribution when you share the images.`);
  return 0;
}

class UsageError extends Error {}

function parseLatLon(s: string): [number, number] | undefined {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return [lat, lon];
}

function slug(s: string): string {
  const out = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return out || "map";
}

function shortName(displayName: string): string {
  return displayName.split(",")[0].trim();
}

/** A path relative to the working directory when it is inside it. */
function shown(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? `./${rel}` : path;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError) {
      log(`isotown: ${err.message}`);
      process.exit(2);
    }
    log(`isotown: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
