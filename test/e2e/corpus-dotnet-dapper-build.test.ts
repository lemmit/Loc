import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  corpusProjectDirs,
  materializeCorpusFixture,
  validateCorpusCase,
} from "../fixtures/corpus/harness.js";
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
// History: 2 -> 0 (both former entries were the same query-time-projection bug,
// ported to raw Npgsql by M-T6.25), then 0 -> 1 when `policy-document` joined
// the manifest's `dotnet` row and surfaced the SAME class of bug on the Dapper
// adapter — silently, exactly like the pre-M-T6.25 one: codegen clean, the IR
// validator silent (`validateCorpusCase` under `dapper` raises no diagnostic at
// all — the oracle below proves it), and only the C# compiler objecting.
//
// DRAINED again (1 -> 0).  The single entry was `policy-document`, carrying two
// independent EF leaks in the Dapper document/hierarchy path.  Both are fixed:
//
//   1. `Infrastructure/Persistence/EfOrgPathResolver.cs` was emitted whatever
//      the persistence adapter was — it opens `using Microsoft.EntityFrameworkCore;`
//      and takes an `AppDbContext`, neither of which a `persistence: dapper`
//      project has (CS0234 + 2x CS0246).  The hierarchy seam now emits ONE
//      resolver per adapter; the Dapper twin (`DapperOrgPathResolver.cs`) reads
//      the registry's `data_key` with one raw Npgsql statement, and Program.cs
//      registers whichever one was emitted.
//   2. The DAPPER document repository did not implement `GetByIdForWriteAsync`,
//      so the `allow` ladder's write-scope port member was unimplemented
//      (CS0535).  The EF twin's `writeScopeMethod` is ported — along with the
//      in-app `_CapabilityVisible` read filter the Dapper document repository
//      had also never received, which was the SILENT half of the same defect
//      (a `tenantOwned` document aggregate read across tenants here).
//
// Structural pin: `test/generator/dotnet/dapper-document-authz.test.ts`.
const DAPPER_COMPILE_SKIP: Record<string, string> = {};

// Features the IR validator HONESTLY rejects under dapper — not a gap, a
// documented capability boundary (`loom.dapper-unsupported`).  These never
// reach the compiler, so they are excluded rather than skipped.
//
// 2 -> 1 (M-T6.25).  `read-gates` was here for ONE reason — it carries a
// query-time projection (`OpenOrders`), and "the Dapper adapter does not emit
// query-time projections" — and that boundary is gone: the four direct-table
// arms (whole-table aggregation, grouped, workflow-sourced, projection-sourced)
// are raw Npgsql now, and the per-row arm never touched EF at all (it reads
// through the aggregate's repository, which this adapter has always emitted).
// So the fixture is back to covering all three of its read-gate kinds here, not
// two-thirds dropped as collateral.  What survives of the gate is narrow enough
// to have no corpus witness: an aggregation whose source aggregate keeps its
// fields somewhere other than columns (`shape: document`, event-sourced) — see
// `dapperQueryProjectionGap`.
//
// DRAINED (1 -> 0).  The last entry was `tenancy-hierarchy`, held out because
// "hierarchical tenancy's capability filter is outside the Dapper SQL subset".
// It never was, in principle — the `deep`/`global` sentinel is perfectly
// SQL-expressible; what the adapter lacked was the PARAM BINDING, because
// `collectFilterPrincipalRefs` did not descend into the `authz-filter` node to
// find the `currentUser.<claim>` reads inside its decision.  Both halves now
// land together (`authzFilterToSql`'s `scope` arm + the collector's
// `authz-filter` arm), so the fixture reaches the compiler like any other and
// this register is empty.
const DAPPER_UNSUPPORTED: Record<string, string> = {};

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

// ---------------------------------------------------------------------------
// The maps' ORACLE — always on, no SDK, no docker.
//
// Until now nothing checked that these maps described reality.  They are only
// consulted when `LOOM_DOTNET_BUILD=1`, so the claim "this feature is outside
// the adapter's boundary" (or "this one is fine") was unfalsifiable on an
// ordinary PR — and the two halves that must agree, the FIXTURE corpus and the
// per-adapter VALIDATOR gate, are edited by different PRs weeks apart.
//
// That is not a hypothetical either.  `read-gates` landed in #2523; #2498 then
// added `loom.dapper-unsupported` for query-time projections, which rejects it.
// Both PRs were green, `main` went red for ~6h, and the failure surfaced from a
// docker job named after a compiler that never ran.  This gate reproduces that
// disagreement in ~10s of pure Node.
//
// It runs the IR validator (phase ⑦) directly, because the corpus GENERATION
// gate cannot: `generateSystems` never calls `validateLoomModel` (see
// `validateCorpusCase`), so no other per-PR gate sees these diagnostics at all.
// ---------------------------------------------------------------------------
describe("the dapper maps agree with what the IR validator actually says", () => {
  const dapperDeclared = CORPUS.filter((f) => f.backends.includes("dotnet")).map((f) => f.id);

  it.each(dapperDeclared)("%s — its map placement matches its diagnostics", async (id) => {
    const diags = await validateCorpusCase(id, "dotnet", "dapper");
    const rejections = diags.filter(
      (d) => d.severity === "error" && d.code === "loom.dapper-unsupported",
    );
    const otherErrors = diags.filter(
      (d) => d.severity === "error" && d.code !== "loom.dapper-unsupported",
    );

    if (id in DAPPER_UNSUPPORTED) {
      // Claimed a capability boundary — the validator must actually say so.
      // A stale entry (the gap got fixed, the entry stayed) fails here, which
      // is what makes this register ratchet rather than accumulate.
      expect(
        rejections.length,
        `'${id}' is in DAPPER_UNSUPPORTED but the validator raises no ` +
          "loom.dapper-unsupported under `persistence: dapper` — the boundary moved, so " +
          "drop the entry and let the feature run.",
      ).toBeGreaterThan(0);
    } else {
      // Everything else is claimed to REACH the compiler — including
      // DAPPER_COMPILE_SKIP entries, which are compile debt, not boundaries.
      // A fixture that the validator rejects while sitting outside
      // DAPPER_UNSUPPORTED is precisely the `read-gates` failure.
      expect(
        rejections.map((d) => d.message),
        `'${id}' is rejected by loom.dapper-unsupported but is not in DAPPER_UNSUPPORTED — ` +
          "the dapper compile leg will fail at `generate`, before dotnet runs. Add it to the " +
          "map (with the boundary stated) or narrow the validator gate.",
      ).toEqual([]);
      expect(
        otherErrors.map((d) => `${d.code}: ${d.message}`),
        `'${id}' does not validate under \`persistence: dapper\``,
      ).toEqual([]);
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
