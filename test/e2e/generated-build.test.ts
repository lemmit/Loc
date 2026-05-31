import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Generator regression test: emit each example, install deps, run
// `tsc --noEmit` (type-check only — tsup handles emit), then run
// `npm run build` to exercise the tsup bundle.  Catches generator
// drift that breaks generated TS without running the full docker
// e2e.
//
// Slow (~60s with cached node_modules) — opt-in via LOOM_TS_BUILD=1
// so `npm test` stays fast.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TS_BUILD === "1";

describe.skipIf(!ENABLED)(
  "generated TS type-checks (tsc) AND bundles (tsup) under strict mode",
  () => {
    it.each([
      "examples/sales.ddd",
      "examples/banking.ddd",
      "examples/inventory.ddd",
      "examples/roster.ddd",
      // crudish lifecycle — the only example that emits a canonical
      // destroy, so this cell is what compiles the Hono DELETE route +
      // repo `delete()` paths.
      "examples/lifecycle.ddd",
      // Document-persistence path (`normalised(false)`): jsonb column +
      // JSON round-trip through `_create` (toDoc / fromDoc).
      "examples/document.ddd",
    ])("%s — `ddd generate ts` output type-checks + tsup-bundles", (example) => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tsc-"));
      try {
        execSync(`node ${cli} generate ts ${example} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 180_000,
        });
        // Type-check (tsup is build-only with `dts: false`).
        execSync(`npx tsc --noEmit`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 60_000,
        });
        // Build the production bundle.
        execSync(`npm run build`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 60_000,
        });
        // Bundle exists where the Dockerfile expects it.
        expect(fs.existsSync(path.join(outDir, "dist", "index.js"))).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 300_000);
  },
);
