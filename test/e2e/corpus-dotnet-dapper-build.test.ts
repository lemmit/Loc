import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { corpusProjectDirs, materializeCorpusFixture } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// The compile tier for the .NET backend's SECOND persistence adapter,
// `persistence: dapper` — the sibling of `corpus-dotnet-build` (EF Core).
//
// WHY THIS EXISTS.  The .NET corpus gate only ever exercised EF Core, so an
// emitter that referenced EF from a code path Dapper also takes was invisible to
// it.  That is not hypothetical — it is how two separate bugs shipped:
//
//   - #2387: `IAuditWriter` was referenced by the command handlers but its
//     runtime was emitted only on the EF path.  Every audited operation under
//     Dapper failed with CS0246, and `corpus × dotnet` was green throughout.
//   - the folded-projection read controller injected `AppDbContext` directly
//     (fixed earlier; see `dapper-projection-emission.test.ts`).
//
// Both are the same shape: the `.ddd` parses, the project generates, and the
// break only appears at `dotnet build`.  A generation-tier gate cannot see it.
// This gate closes that hole for every corpus feature at once.
//
// Slow (`dotnet restore` per feature) — opt-in via LOOM_DOTNET_BUILD=1, sharded
// one feature per cell via LOOM_CORPUS_DAPPER_CASE=<feature-id>.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_DOTNET_BUILD === "1";
const CASE = process.env.LOOM_CORPUS_DAPPER_CASE;

// Features that GENERATE under `persistence: dapper` but do not yet COMPILE.
// Each entry is a precise, reproducible bug report; widen the gate by FIXING
// the emitter and dropping the entry.  Ratcheted by `allowlist-ratchet.test.ts`
// so this map can only shrink.
const DAPPER_COMPILE_SKIP: Record<string, string> = {
  "projection-aggregation":
    "query-time projection handlers are EF-LINQ over AppDbContext (CS0234: no Microsoft.EntityFrameworkCore under dapper) — needs the raw-Npgsql port the FOLDED read controller already got",
  "projection-groupby":
    "same as projection-aggregation — the grouped QP handler is EF-LINQ over AppDbContext",
};

// Features the IR validator HONESTLY rejects under dapper — not a gap, a
// documented capability boundary (`loom.dapper-unsupported`).  These never
// reach the compiler, so they are excluded rather than skipped.
const DAPPER_UNSUPPORTED: Record<string, string> = {
  "tenancy-hierarchy":
    "hierarchical tenancy's capability filter is outside the Dapper SQL subset; the validator says so with loom.dapper-unsupported",
};

const dapperFeatures = CORPUS.filter((f) => f.backends.includes("dotnet"))
  .filter((f) => !(f.id in DAPPER_COMPILE_SKIP))
  .filter((f) => !(f.id in DAPPER_UNSUPPORTED))
  .filter((f) => !CASE || f.id === CASE)
  .map((f) => f.id);

// A typo'd key in either map would silently exclude NOTHING (the feature keeps
// running) or, worse, read as covered when it isn't.  Runs unconditionally —
// it needs no SDK, so it also guards the maps when the slow tier is off.
describe("the dapper compile-tier maps name real corpus features", () => {
  it("every skip / unsupported key exists in the manifest", () => {
    const known = new Set(CORPUS.map((f) => f.id));
    for (const id of [...Object.keys(DAPPER_COMPILE_SKIP), ...Object.keys(DAPPER_UNSUPPORTED)]) {
      expect(known.has(id), `'${id}' is not a corpus feature id`).toBe(true);
    }
  });
  it("every entry carries a rationale", () => {
    for (const [id, why] of [
      ...Object.entries(DAPPER_COMPILE_SKIP),
      ...Object.entries(DAPPER_UNSUPPORTED),
    ]) {
      expect(why.trim().length, `'${id}' needs a reason`).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!ENABLED)("corpus features compile under dotnet build (dapper)", () => {
  it.each(dapperFeatures)("%s — generated .NET/Dapper project compiles", (featureId) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-corpus-dapper-${featureId}-`));
    try {
      const src = materializeCorpusFixture(featureId, "dotnet", outDir, "dapper");
      execSync(`node ${cli} generate system ${src} -o ${outDir}`, {
        stdio: "inherit",
        cwd: repoRoot,
      });
      for (const dir of corpusProjectDirs(featureId)) {
        const proj = path.join(outDir, dir);
        expect(fs.existsSync(proj), `${featureId}: .NET project '${dir}' emitted`).toBe(true);
        execSync("dotnet restore --nologo", { cwd: proj, stdio: "inherit", timeout: 300_000 });
        execSync("dotnet build --no-restore --nologo /warnaserror", {
          cwd: proj,
          stdio: "inherit",
          timeout: 300_000,
        });
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 660_000);
});
