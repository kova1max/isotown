import assert from "node:assert/strict";
import { test } from "node:test";
import { frameCells, makeFrame, toLocal } from "./geo.js";
import { clipRing, orientedRect, signedArea } from "./geometry.js";
import { overpassFailure } from "./net.js";
import { assembleRings, parseElements } from "./osm.js";
import { buildScene, maskAt, parseNumber, seaMask } from "./scene.js";

test("frame cells are at most 1 km and cover the area", () => {
  assert.equal(frameCells(makeFrame(52, 5, 4)).length, 4);
  assert.equal(frameCells(makeFrame(52, 5, 8.1)).length, 9);
  assert.equal(frameCells(makeFrame(52, 5, 25)).length, 25);
  assert.equal(frameCells(makeFrame(52, 5, 0.5)).length, 1);
});

test("local frame is metric", () => {
  const f = makeFrame(52, 5, 4);
  const [e, n] = toLocal(f, 52.001, 5.001);
  assert.ok(Math.abs(n - 111.25) < 0.5, `north ${n}`);
  assert.ok(Math.abs(e - 68.6) < 0.5, `east ${e}`);
});

test("parseNumber reads metres, feet and decimal commas", () => {
  assert.equal(parseNumber("12"), 12);
  assert.equal(parseNumber("12.5 m"), 12.5);
  assert.equal(parseNumber("4,5"), 4.5);
  assert.ok(Math.abs((parseNumber("40'") ?? 0) - 12.192) < 1e-9);
  assert.equal(parseNumber("tall"), undefined);
  assert.equal(parseNumber(undefined), undefined);
});

test("oriented rectangle finds the long axis of a rotated box", () => {
  const c = Math.cos(0.5);
  const s = Math.sin(0.5);
  const pts = [
    [-10, -3],
    [10, -3],
    [10, 3],
    [-10, 3],
  ].flatMap(([x, y]) => [x * c - y * s + 100, x * s + y * c + 50]);
  const r = orientedRect(pts);
  assert.ok(Math.abs(r.halfL - 10) < 1e-6);
  assert.ok(Math.abs(r.halfW - 3) < 1e-6);
  assert.ok(Math.abs(Math.abs(r.ax * c + r.ay * s) - 1) < 1e-6, "long axis follows the rotation");
  assert.ok(Math.abs(r.cx - 100) < 1e-6 && Math.abs(r.cy - 50) < 1e-6);
});

test("clipRing keeps the half where ax + by + c <= 0", () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  const left = clipRing(square, 1, 0, -4);
  assert.equal(Math.abs(signedArea(left)), 40);
});

test("assembleRings joins split and reversed member ways", () => {
  const rings = assembleRings([
    [0, 0, 10, 0],
    [10, 10, 10, 0],
    [10, 10, 0, 10, 0, 0],
  ]);
  assert.equal(rings.length, 1);
  assert.equal(Math.abs(signedArea(rings[0])), 100);
});

test("parseElements de-duplicates elements seen in several cells", () => {
  const f = makeFrame(0, 0, 1);
  const way = {
    type: "way" as const,
    id: 7,
    tags: { building: "yes" },
    geometry: [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.0001 },
      { lat: 0.0001, lon: 0.0001 },
      { lat: 0, lon: 0 },
    ],
  };
  const data = parseElements(f, [way, way]);
  assert.equal(data.areas.length, 1);
  assert.equal(data.lines.length, 0);
});

test("buildings get a roof rule by class and heights from tags", () => {
  const f = makeFrame(0, 0, 1);
  const box = (id: number, tags: Record<string, string>, w = 0.0001, h = 0.0002) => ({
    type: "way" as const,
    id,
    tags,
    geometry: [
      { lat: 0, lon: 0 },
      { lat: 0, lon: w },
      { lat: h, lon: w },
      { lat: h, lon: 0 },
      { lat: 0, lon: 0 },
    ],
  });
  const scene = buildScene(
    parseElements(f, [
      box(1, { building: "house" }),
      box(2, { building: "office", "building:levels": "8" }),
      box(3, { building: "garage" }),
      box(4, { building: "house", "roof:shape": "hipped", height: "12" }),
    ]),
    f.half,
  );
  const byKind = scene.buildings.filter((b) => b.kind !== "detail");
  assert.equal(byKind[0].roof, "gabled");
  assert.equal(byKind[1].roof, "flat");
  assert.ok(Math.abs(byKind[1].wallTop - 24.8) < 1e-9);
  assert.equal(byKind[2].roof, "skillion");
  assert.equal(byKind[3].roof, "hipped");
  assert.ok(Math.abs(byKind[3].maxH - 12) < 1e-9, `tagged height includes the roof: ${byKind[3].maxH}`);
  assert.equal(scene.stats.withHeight, 1);
  assert.equal(scene.stats.withLevels, 1);
});

test("sea mask puts the sea on the right of the coastline", () => {
  // Coastline running north along e = 0: land west, sea east.
  const m = seaMask([[0, -600, 0, 600]], 500);
  assert.equal(maskAt(m, 200, 0), true);
  assert.equal(maskAt(m, -200, 0), false);
});

test("Overpass errors inside a 200 response are not accepted", () => {
  assert.equal(overpassFailure('{"elements":[]}'), undefined);
  assert.match(overpassFailure('{"elements":[], "remark": "runtime error: Query timed out"}') ?? "", /timed out/);
  assert.equal(overpassFailure("<html>busy</html>"), "response was not JSON");
});
