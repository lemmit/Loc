import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Backend-packages layering invariant (B2.1, see
// docs/backend-packages.md).
//
//   Edges point one way: package → shared, NEVER shared → package.
//
// The shared emitters under `src/generator/` must not import
// anything from `src/platform/<family>/<vN>/` (a versioned backend
// package).  Per-version data (dep pins today) is threaded in as a
// parameter by the package surface / entrypoints.  A reverse edge
// would re-pin the shared core to one version (blocking `hono@v5`)
// and foreclose a future per-backend packaging split.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const generatorDir = path.join(repoRoot, "src", "generator");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.isFile() && full.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Matches `from "…/platform/…"` and `import("…/platform/…")` in any
// relative form (`../platform`, `../../platform`, …).
const PLATFORM_IMPORT = /(?:from|import\()\s*["'][^"']*\/platform\/[^"']*["']/;

describe("backend-packages layering — no shared→package edges", () => {
  const files = tsFiles(generatorDir);

  it("scans a non-trivial number of shared emitter files", () => {
    // Guard against the walker silently finding nothing (e.g. a
    // moved directory) and the invariant passing vacuously.
    expect(files.length).toBeGreaterThan(20);
  });

  it("no file under src/generator/ imports from src/platform/", () => {
    const offenders = files
      .filter((f) => PLATFORM_IMPORT.test(fs.readFileSync(f, "utf-8")))
      .map((f) => path.relative(repoRoot, f));
    expect(
      offenders,
      `Shared emitter must not depend on a backend package — ` +
        `thread per-version data in as a parameter instead. Offenders:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
