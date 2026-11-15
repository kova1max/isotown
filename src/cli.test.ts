import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("a southern-hemisphere place reaches option validation", () => {
  const r = run("-33.86,151.21", "--area", "30");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--area 30 is above/);
});

test("a negative --gif-at value reaches option validation", () => {
  for (const args of [["--gif-at", "-33.8,151.2"], ["--gif-at=-33.8,151.2"]]) {
    const r = run("-33.86,151.21", ...args, "--area", "30");
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--area 30 is above/);
  }
});

test("a --gif-at point outside the map is a usage error", () => {
  const r = run("52.37,4.89", "--gif-at", "52.0,4.0", "--overpass-url", "http://127.0.0.1:9/");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--gif-at 52\.0,4\.0 is outside the 2 km2 map/);
});

test("the default output directory keeps the coordinate signs", async () => {
  const server = createServer((_req, res) => res.end('{"elements":[]}'));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const cwd = await mkdtemp(join(tmpdir(), "isotown-"));
  try {
    for (const place of ["-33.86,151.21", "33.86,151.21"]) {
      const child = spawn(process.execPath, [cli, place, "--area", "0.25", "--overpass-url", `http://127.0.0.1:${port}/`, "--cache-dir", join(cwd, "cache")], { cwd });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const code = await new Promise((done) => child.on("close", done));
      assert.equal(code, 0, stderr);
    }
    assert.deepEqual((await readdir(cwd)).filter((d) => d.startsWith("isotown-")).sort(), ["isotown-33-86-151-21", "isotown-m33-86-151-21"]);
  } finally {
    server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
