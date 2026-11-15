import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
