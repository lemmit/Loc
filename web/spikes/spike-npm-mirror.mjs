// THROWAWAY SPIKE (C1) — prove install reads tarballs from the local
// mirror, not registry.npmjs.org.  Downloads a small tree once,
// serves it over a local http server, installs through the mirror,
// and asserts every tarball came from the mirror (served count ==
// plan size).

import http from "node:http";
import { planInstall } from "../src/engine/npm/resolve-tree.ts";
import { fetchTarball } from "../src/engine/npm/registry.ts";
import { install } from "../src/engine/npm/install.ts";

const rootDeps = { hono: "^4.12.0" };
const plan = [...(await planInstall(rootDeps)).values()];
console.log(`# ${plan.length} packages in plan`);

// Build an in-memory mirror: key -> bytes.
const blobs = new Map();
for (const pkg of plan) {
  const key = `${pkg.name}@${pkg.version}`;
  blobs.set(key.replace(/[@/]/g, "_") + ".tgz", await fetchTarball(pkg.meta.dist.tarball));
}

let served = 0;
const server = http.createServer((req, res) => {
  const file = decodeURIComponent(req.url.replace(/^\//, ""));
  const bytes = blobs.get(file);
  if (!bytes) {
    res.statusCode = 404;
    res.end();
    return;
  }
  served++;
  res.end(Buffer.from(bytes));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const mirror = new Map(
  plan.map((p) => [`${p.name}@${p.version}`, base + `${p.name}@${p.version}`.replace(/[@/]/g, "_") + ".tgz"]),
);

let files = 0;
const t0 = Date.now();
const res = await install(rootDeps, () => files++, { mirror });
const ms = Date.now() - t0;
server.close();

const ok =
  res.fileCount > 0 &&
  served === plan.length && // every tarball came from the mirror
  res.versions.size === plan.length;

console.log(`  install via mirror: ${files} files in ${ms} ms`);
console.log(`  tarballs served by mirror: ${served}/${plan.length} ${served === plan.length ? "OK" : "FAIL"}`);
console.log(`  packages installed: ${res.versions.size}/${plan.length} ${res.versions.size === plan.length ? "OK" : "FAIL"}`);
console.log("");
console.log(
  ok
    ? "PASS — install pulled every tarball from the local mirror (zero registry tarball fetches)."
    : "FAIL — mirror not fully used.",
);
process.exit(ok ? 0 : 1);
