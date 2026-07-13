// Regenerate `docs/stdlib.md` from the stdlib registries.
//
// The rendering lives in `src/system/stdlib-doc.ts` (compiled to
// `out/system/stdlib-doc.js`) so the same pure function backs both this
// writer and the drift test.  Run after any change to the intrinsic /
// collection-op catalogues or the ambient prelude source:
//
//   npm run docs:stdlib      # = npm run build && node scripts/gen-stdlib-docs.mjs

import fs from "node:fs";
import path from "node:path";
import { renderStdlibMarkdown } from "../out/system/stdlib-doc.js";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const outPath = path.join(repoRoot, "docs/stdlib.md");

fs.writeFileSync(outPath, renderStdlibMarkdown(), "utf8");
console.log(`Wrote ${path.relative(repoRoot, outPath)}`);
