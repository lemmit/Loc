import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { generateCorpusCase } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// Phase 1 compile tier (docs/old/plans/global-test-coverage-plan.md) for the
// reference backend (Hono/TS).  The fast `corpus-coverage` gate proves every
// corpus feature *generates* on `node`; this gate proves the emitted project
// actually *type-checks* under strict `tsc` — upgrading the corpus from a
// generation floor to a compile guarantee, from the SAME single source of
// truth (one `.ddd` per feature, no per-backend duplicate).
//
// Slow (npm install + tsc per feature) — opt-in via LOOM_TS_BUILD=1.  CI shards
// one feature per cell via LOOM_CORPUS_TSC_CASE=<feature-id>.
// ---------------------------------------------------------------------------

const ENABLED = process.env.LOOM_TS_BUILD === "1";
const CASE = process.env.LOOM_CORPUS_TSC_CASE;

// Features that GENERATE on node but don't yet `tsc`-compile under strict mode —
// real Hono generator gaps this compile tier surfaced (the generation gate still
// covers all of them on all six backends; each line is a precise, reproducible
// bug report).  Widen the gate by FIXING the emitter, then dropping the entry.
const TS_COMPILE_SKIP: Record<string, string> = {};

// Every corpus feature the manifest declares to generate on `node`, minus the
// documented compile-tier skips.
const nodeFeatures = CORPUS.filter((f) => f.backends.includes("node"))
  .filter((f) => !(f.id in TS_COMPILE_SKIP))
  .filter((f) => !CASE || f.id === CASE)
  .map((f) => f.id);

describe.skipIf(!ENABLED)("corpus features type-check under strict tsc (Hono/node)", () => {
  it.each(nodeFeatures)("%s — generated node project type-checks", async (featureId) => {
    const files = await generateCorpusCase(featureId, "node");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-corpus-tsc-${featureId}-`));
    try {
      // Write the emitted file map to disk.
      for (const [rel, content] of files) {
        const abs = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
      // The deployable is named `d` → its project lands under `d/`.
      const proj = path.join(outDir, "d");
      expect(
        fs.existsSync(path.join(proj, "package.json")),
        `${featureId}: node project emitted`,
      ).toBe(true);
      execSync("npm install --silent --no-audit --no-fund", {
        cwd: proj,
        stdio: "inherit",
        timeout: 180_000,
      });
      execSync("npx tsc --noEmit", { cwd: proj, stdio: "inherit", timeout: 120_000 });
    } finally {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 360_000);
});
