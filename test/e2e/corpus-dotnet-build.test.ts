import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORPUS_DEPLOYABLE, materializeCorpusFixture } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// Phase 1 compile tier (docs/plans/global-test-coverage-plan.md) for the .NET
// (ASP.NET + EF Core + Mediator) backend — the sibling of `corpus-tsc-build`
// (node) and `corpus-java-build` (Java).  The fast `corpus-coverage` gate
// proves every corpus feature *generates* on `dotnet`; this gate proves the
// emitted project actually *compiles* under `dotnet build /warnaserror`,
// upgrading the corpus from a generation floor to a compile guarantee on the
// .NET backend too — from the SAME single source of truth (one `.ddd` per
// feature, no per-backend duplicate).
//
// Slow (`dotnet restore` per feature) — opt-in via LOOM_DOTNET_BUILD=1 (the
// same switch the single-fixture `generated-dotnet-build` gate uses).  CI
// shards one feature per cell via LOOM_CORPUS_DOTNET_CASE=<feature-id>.
// Requires the .NET SDK on PATH (the workflow runs it in the dotnet/sdk
// container; locally, run vitest inside `mcr.microsoft.com/dotnet/sdk:10.0`).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_DOTNET_BUILD === "1";
const CASE = process.env.LOOM_CORPUS_DOTNET_CASE;

// Features that GENERATE on dotnet but don't yet compile under `dotnet build
// /warnaserror` — real .NET generator gaps this compile tier surfaces (the
// generation gate still covers all of them on all six backends; each line is a
// precise, reproducible bug report).  Widen the gate by FIXING the emitter,
// then dropping the entry.
const DOTNET_COMPILE_SKIP: Record<string, string> = {
  // PLATFORM LIMITATION: `shape(embedded)` + a ref-collection (`X id[]`) — the
  // join-table type (`...Persistence.JoinTables`, `OrderTags`) the AppDbContext +
  // repository reference is not emitted on .NET for an embedded aggregate (CS0234).
  // The same shape java skip-lists; use shape(document)/relational or host on node.
  embedded:
    "PLATFORM LIMITATION: jsonb-embedded + ref collection has no join-table type on .NET (CS0234)",
  // EMITTER GAP: aggregate inheritance (TPH/TPC) — a polymorphic find body reads
  // `.Id` off the abstract base (`Asset`), which the base class doesn't expose
  // (CS1061).  The base aggregate's `Id` property isn't surfaced on .NET.
  inheritance:
    "EMITTER GAP: abstract base aggregate missing `Id` for polymorphic find on .NET (CS1061)",
  // EMITTER GAP: outbox dispatcher — `OutboxDomainEventDispatcher` references
  // `IDomainEvent` / `IDomainEventDispatcher.DispatchAsync` shapes that aren't
  // emitted for the durable-channel outbox on .NET (CS0246 / CS0535).
  outbox:
    "EMITTER GAP: outbox dispatcher references unemitted IDomainEvent shapes on .NET (CS0246/CS0535)",
  // EMITTER GAP: tenancy `filter this.tenantId == currentUser.tenantId` — the EF
  // entity configuration emits a bare `currentUser` reference with nothing in
  // scope (CS0103); the filter expr isn't threaded a current-user accessor there.
  "tenancy-filter":
    "EMITTER GAP: tenancy filter emits unbound `currentUser` in EF configuration on .NET (CS0103)",
  // EMITTER GAP: provenance pipeline behaviour — `ExecutionContextBehavior` doesn't
  // match the Mediator `IPipelineBehavior<,>.Handle(...)` signature it claims to
  // implement (CS0535) — a generated-vs-library API-shape drift on .NET.
  provenance:
    "EMITTER GAP: provenance IPipelineBehavior.Handle signature mismatch on .NET (CS0535)",
};

// Every corpus feature the manifest declares to generate on `dotnet`, minus the
// documented compile-tier skips.
const dotnetFeatures = CORPUS.filter((f) => f.backends.includes("dotnet"))
  .filter((f) => !(f.id in DOTNET_COMPILE_SKIP))
  .filter((f) => !CASE || f.id === CASE)
  .map((f) => f.id);

describe.skipIf(!ENABLED)("corpus features compile under dotnet build (.NET)", () => {
  it.each(dotnetFeatures)("%s — generated .NET project compiles", (featureId) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-corpus-dotnet-${featureId}-`));
    try {
      const src = materializeCorpusFixture(featureId, "dotnet", outDir);
      execSync(`node ${cli} generate system ${src} -o ${outDir}`, {
        stdio: "inherit",
        cwd: repoRoot,
      });
      // The deployable is named `d` → its project lands under `d/`.
      const proj = path.join(outDir, CORPUS_DEPLOYABLE);
      expect(fs.existsSync(proj), `${featureId}: .NET project emitted`).toBe(true);
      execSync("dotnet restore --nologo", { cwd: proj, stdio: "inherit", timeout: 300_000 });
      // `/warnaserror` keeps the gate honest about both real errors and warnings
      // (an unused-using or nullable-mismatch the emitter shouldn't produce).
      execSync("dotnet build --no-restore --nologo /warnaserror", {
        cwd: proj,
        stdio: "inherit",
        timeout: 300_000,
      });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 660_000);
});
