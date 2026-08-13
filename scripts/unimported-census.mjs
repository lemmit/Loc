#!/usr/bin/env node
// Direct-test-seam census.
//
// Which `src/` modules does NO test file import?  Those are reached only
// transitively — in this repo, through `generateSystems` — so the only
// assertion available against them is "the emitted string contains …".
// It is the structural reason the suite is broad and shallow, and it is
// where the shared-core unit-test missions (M-T9.17) should aim next.
//
// Also reports ORPHANS: modules imported by neither `src` nor `test`.
// `test/platform/dead-generator-exports.test.ts` catches dead exported
// `render*/emit*/build*` NAMES; a bare `export *` re-export shim has no
// such name, so the shims left behind by moves into `_walker`/`_frontend`
// are invisible to it and show up here instead.
//
// Import specifiers are resolved textually (`./x.js` → `./x.ts`), which is
// enough for this repo's ESM-relative style; it does not follow directory
// index imports, so treat the orphan list as a candidate set to confirm by
// grep, not as a delete list.
//
// Usage:  node scripts/unimported-census.mjs

import fs from "node:fs";
import path from "node:path";

const collect = (root, keep) => {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (keep(e.name)) out.push(p);
    }
  })(root);
  return out;
};

const isTs = (n) => n.endsWith(".ts") && !n.endsWith(".d.ts");
const srcModules = collect("src", isTs).filter(
  (f) => !f.includes(`${path.sep}generated${path.sep}`),
);

const importers = [
  ...collect("test", (n) => n.endsWith(".ts")),
  ...collect("src", (n) => n.endsWith(".ts")),
  ...(fs.existsSync("web/src")
    ? collect("web/src", (n) => n.endsWith(".ts") || n.endsWith(".tsx"))
    : []),
];

const referenced = new Set();
const referencedByTest = new Set();
for (const f of importers) {
  const fromTest = f.startsWith(`test${path.sep}`);
  for (const m of fs.readFileSync(f, "utf8").matchAll(/from\s+["']([^"']+)["']/g)) {
    if (!m[1].startsWith(".")) continue;
    const abs = path.normalize(path.join(path.dirname(f), m[1])).replace(/\.js$/, ".ts");
    referenced.add(abs);
    if (fromTest) referencedByTest.add(abs);
  }
}

const loc = (f) => fs.readFileSync(f, "utf8").split("\n").length;
const noTestSeam = srcModules.filter((f) => !referencedByTest.has(f));
const orphans = noTestSeam.filter((f) => !referenced.has(f));
const pct = Math.round((noTestSeam.length / srcModules.length) * 100);
const totalLoc = noTestSeam.reduce((a, f) => a + loc(f), 0);

console.log(
  `src modules=${srcModules.length}  no direct test import=${noTestSeam.length} (${pct}%, ${totalLoc} LOC)`,
);

const byArea = {};
for (const f of noTestSeam) {
  const area = f.split(path.sep).slice(0, 3).join("/");
  byArea[area] = (byArea[area] ?? 0) + 1;
}
console.log("\nby area:");
for (const [a, n] of Object.entries(byArea).sort((x, y) => y[1] - x[1]))
  console.log(`  ${n}\t${a}`);

console.log("\nlargest modules with no direct test seam:");
for (const f of [...noTestSeam].sort((a, b) => loc(b) - loc(a)).slice(0, 20)) {
  console.log(`  ${loc(f)}\t${f}`);
}

console.log(`\norphans — imported by neither src nor test (${orphans.length}):`);
for (const f of orphans) console.log(`  ${f}`);
