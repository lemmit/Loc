import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The browser-bundle IP boundary, enforced.
//
// `src/system/index.ts` statically imports the GENERATION registry, which
// pulls every backend generator (.NET / Java / Phoenix / Python).  The
// playground build worker must therefore load it only via a DYNAMIC `import()`
// — that keeps `system/index` (and the premium generators) in a separate
// chunk, out of the main worker bundle, and marks the exact seam where a
// future build swaps in-browser generation for a server call.
//
// The Hono "ts" path stays a static import (it runs in-browser); the language
// + IR front half is already registry-free (metadata-boundary.test.ts).  So
// once the worker's only `system/index` reference is dynamic, the main bundle's
// static graph reaches no backend generator.  A new STATIC import of
// `system/index` (or a premium generator) under the worker fails here.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workerPath = path.join(repoRoot, "web/src/build/build.worker.ts");

const STATIC_SYSTEM_INDEX = /from\s+["'][^"']*\/system\/index(\.js)?["']/;
const STATIC_PREMIUM_GEN = /from\s+["'][^"']*\/generator\/(dotnet|java|elixir|python)\b/;
const DYNAMIC_SYSTEM_INDEX = /import\(\s*["'][^"']*\/system\/index(\.js)?["']\s*\)/;

describe("playground worker does not statically bundle the backend generators", () => {
  const src = fs.readFileSync(workerPath, "utf8");

  it("never STATICALLY imports system/index (the registry/generator chokepoint)", () => {
    expect(STATIC_SYSTEM_INDEX.test(src)).toBe(false);
  });

  it("never statically imports a premium backend generator", () => {
    expect(STATIC_PREMIUM_GEN.test(src)).toBe(false);
  });

  it("loads system generation via a dynamic import() seam", () => {
    expect(DYNAMIC_SYSTEM_INDEX.test(src)).toBe(true);
  });
});
