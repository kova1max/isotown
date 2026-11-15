import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Net } from "./net.js";
import type { OsmData } from "./osm.js";
import { writeDeepZoom } from "./outputs.js";
import { K, KZ, Mat, makeLayout, renderViewport } from "./render.js";
import { buildScene } from "./scene.js";

function square(id: string, cx: number, cy: number, half: number, tags: Record<string, string>) {
  return {
    id,
    tags,
    poly: { outer: [[cx - half, cy - half, cx + half, cy - half, cx + half, cy + half, cx - half, cy + half]], inner: [] },
  };
}

/** Image pixel of a world point. */
function pixel(L: ReturnType<typeof makeLayout>, e: number, n: number, h: number): [number, number] {
  return [Math.floor((e + n) * K + L.ox), Math.floor((e - n) * (K / 2) - h * KZ + L.oy)];
}

test("a flat-roofed building shows its roof over the ground", () => {
  const data: OsmData = { areas: [square("w1", 0, 0, 10, { building: "office", "building:levels": "3" })], lines: [], points: [] };
  const scene = buildScene(data, 60);
  const L = makeLayout(scene);
  const top = scene.buildings[0].wallTop;
  const [x, y] = pixel(L, 0, 0, top);
  const f = renderViewport(scene, L, { x0: x - 2, y0: y - 2, w: 5, h: 5 });
  assert.equal(f.mat[2 * 5 + 2], Mat.Roof);
  const [gx, gy] = pixel(L, -40, 40, 0);
  const g = renderViewport(scene, L, { x0: gx, y0: gy, w: 1, h: 1 });
  assert.equal(g.mat[0], Mat.Ground);
});

test("the nearer building hides the one behind it", () => {
  // The camera looks from the south-east, so a tower to the north-west stands behind the low block.
  const tower = square("w1", -8, 8, 4, { building: "office", "building:levels": "20", "roof:shape": "flat" });
  const low = square("w2", 0, 0, 6, { building: "office", "building:levels": "2", "roof:shape": "flat" });
  const render = (areas: OsmData["areas"]) => {
    const scene = buildScene({ areas, lines: [], points: [] }, 60);
    const L = makeLayout(scene);
    // Fixed layout so all three renders share pixel coordinates.
    const fixed = { ...L, ox: 200, oy: 200, width: 400, height: 400 };
    const [x, y] = pixel(fixed, 0, 0, 6.8);
    const f = renderViewport(scene, fixed, { x0: x, y0: y, w: 1, h: 1 });
    return [f.mat[0], f.rgb[0], f.rgb[1], f.rgb[2]].join(",");
  };
  const both = render([tower, low]);
  const towerOnly = render([tower]);
  const lowOnly = render([low]);
  assert.notEqual(towerOnly, render([]), "the tower covers the pixel on its own");
  assert.equal(both, lowOnly);
  assert.notEqual(both, towerOnly);
});

test("night windows carry a light threshold", () => {
  const data: OsmData = { areas: [square("w1", 0, 0, 15, { building: "apartments", "building:levels": "6" })], lines: [], points: [] };
  const scene = buildScene(data, 60);
  const L = makeLayout(scene);
  const f = renderViewport(scene, L, { x0: 0, y0: 0, w: L.width, h: L.height });
  let windows = 0;
  let lit = 0;
  for (let i = 0; i < f.mat.length; i++) {
    if (f.mat[i] !== Mat.Window) continue;
    windows++;
    if (f.lit[i] > 0) lit++;
  }
  assert.ok(windows > 50, `windows ${windows}`);
  assert.ok(lit > windows / 2 && lit < windows, `lit ${lit} of ${windows}`);
});

test("deep zoom pyramid has every level down to 1x1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "isotown-dzi-"));
  const img = { width: 600, height: 300, data: new Uint8Array(600 * 300 * 4).fill(200) };
  const tiles = await writeDeepZoom(dir, img);
  const levels = (await readdir(join(dir, "map_files"))).map(Number).sort((a, b) => a - b);
  assert.deepEqual(levels, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // 600x300 at level 10 is 3x2 tiles, 300x150 at level 9 is 2x1, then 1 tile per level.
  assert.equal(tiles, 6 + 2 + 9);
  assert.match(await readFile(join(dir, "map.dzi"), "utf8"), /Width="600" Height="300"/);
});

test("the cache serves a repeat request without fetching", async () => {
  const net = new Net(await mkdtemp(join(tmpdir(), "isotown-cache-")), () => {});
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return '{"elements":[]}';
  };
  const a = await net.cached("overpass", "q", fetcher);
  const b = await net.cached("overpass", "q", fetcher);
  assert.equal(calls, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
});

test("the CLI refuses areas above the cap before touching the network", () => {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const r = spawnSync(process.execPath, [cli, "Amsterdam", "--area", "30"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /above the 25 km2 limit/);
});
