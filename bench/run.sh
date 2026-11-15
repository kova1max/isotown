#!/bin/sh
# Benchmark: render the six gallery cities with the CLI and record, per city,
# buildings, km2, wall-clock seconds, Overpass requests and output size.
# Results go to bench/results.json (bench/results-cold.json with --cold)
# together with the machine they ran on.
#
#   sh bench/run.sh            # uses the normal download cache (~/.cache/isotown)
#   sh bench/run.sh --cold     # empty cache: every cell is fetched from Overpass
#
# The fetch time depends on how busy the public Overpass servers are, so the
# render time (no network) is reported separately and is the stable number.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
npm run build --silent
work=$(mktemp -d)
cache_args=""
if [ "${1:-}" = "--cold" ]; then cache_args="--cache-dir $work/cache"; fi
node -e 'for (const c of require("./scripts/cities.json")) console.log(c.slug + "\t" + c.query)' > "$work/cities.tsv"
while IFS="$(printf '\t')" read -r slug query; do
  echo "== $slug" >&2
  start=$(node -e 'console.log(Date.now())')
  # shellcheck disable=SC2086
  node dist/cli.js "$query" --out "$work/$slug" $cache_args
  end=$(node -e 'console.log(Date.now())')
  bytes=$(du -sk "$work/$slug" | cut -f1)
  node -e '
    const [file, slug, ms, kb] = process.argv.slice(1);
    const s = require(file);
    console.log(JSON.stringify({ slug, ...s, wallSeconds: Math.round(Number(ms) / 100) / 10, outputKiB: Number(kb) }));
  ' "$work/$slug/isotown.json" "$slug" "$((end - start))" "$bytes" >> "$work/rows.jsonl"
done < "$work/cities.tsv"
node -e '
  const os = require("os");
  const fs = require("fs");
  const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
  const machine = { cpu: os.cpus()[0].model, cores: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version };
  const out = { ranAt: new Date().toISOString(), cold: process.argv[2] === "--cold", machine, cities: rows };
  fs.writeFileSync(out.cold ? "bench/results-cold.json" : "bench/results.json", JSON.stringify(out, null, 2) + "\n");
  for (const r of rows) console.log(`${r.slug.padEnd(20)} ${String(r.buildings).padStart(6)} buildings  ${r.areaKm2} km2  render ${r.renderSeconds}s  total ${r.wallSeconds}s  ${r.requests} requests  ${(r.outputKiB / 1024).toFixed(1)} MiB`);
' "$work/rows.jsonl" "${1:-}"
rm -rf "$work"
