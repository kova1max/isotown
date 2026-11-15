// Re-render the README gallery: for each city in scripts/cities.json, a framed
// overview (docs/gallery/<slug>.png) and a native-resolution close-up
// (docs/gallery/<slug>-zoom.png). Run `npm run build` first.
//
//   node scripts/gallery.mjs [--area 2]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fetchFrame } from "../dist/data.js";
import { makeFrame } from "../dist/geo.js";
import { cropImage, encodePng, renderImage } from "../dist/image.js";
import { DEFAULT_NOMINATIM, DEFAULT_OVERPASS, Net, defaultCacheDir } from "../dist/net.js";
import { parseElements } from "../dist/osm.js";
import { poster, stampAttribution } from "../dist/outputs.js";
import { makeLayout } from "../dist/render.js";
import { buildScene } from "../dist/scene.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { area: { type: "string", default: "2" } } });
const area = Number(values.area);
const cities = JSON.parse(await readFile(join(root, "scripts", "cities.json"), "utf8"));
const outDir = join(root, "docs", "gallery");
await mkdir(outDir, { recursive: true });
const net = new Net(defaultCacheDir(), (m) => console.error(m));

for (const c of cities) {
  const hit = await net.geocode(DEFAULT_NOMINATIM, c.query);
  const frame = makeFrame(hit.lat, hit.lon, area);
  const { elements } = await fetchFrame(net, frame, DEFAULT_OVERPASS, () => {});
  const scene = buildScene(parseElements(frame, elements), frame.half);
  const layout = makeLayout(scene);
  const img = renderImage(scene, layout);
  const subtitle = `${c.kind} - ${hit.lat.toFixed(4)}, ${hit.lon.toFixed(4)} - ${area} km2`;
  await writeFile(join(outDir, `${c.slug}.png`), encodePng(poster(img, c.label, subtitle, 1200)));
  const zoom = cropImage(img, Math.round(layout.ox - 400), Math.round(layout.oy - 250), 800, 500);
  stampAttribution(zoom.data, zoom.width, zoom.height);
  await writeFile(join(outDir, `${c.slug}-zoom.png`), encodePng(zoom));
  console.error(`${c.slug}: ${scene.stats.buildings} buildings`);
}
