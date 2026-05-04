import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Generator regression test: emit each example, install deps, and run
// `tsc --noEmit` on the result.  Catches generator drift that breaks
// generated TS without running the full docker e2e.
//
// Slow (~60s with cached node_modules) — opt-in via LOOM_TS_BUILD=1
// so `npm test` stays fast.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TS_BUILD === "1";

describe.skipIf(!ENABLED)("generated TS compiles under strict tsc", () => {
  it.each([
    "examples/sales.ddd",
    "examples/banking.ddd",
    "examples/inventory.ddd",
  ])(
    "%s — `ddd generate ts` output type-checks",
    (example) => {
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
        execSync(`npx tsc --noEmit`, {
          cwd: outDir,
          stdio: "inherit",
          timeout: 60_000,
        });
        expect(true).toBe(true);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
    300_000,
  );
});
