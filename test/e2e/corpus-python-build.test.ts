import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORPUS_DEPLOYABLE, materializeCorpusFixture } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// Phase 1 compile tier (docs/plans/global-test-coverage-plan.md) for the Python
// (FastAPI / SQLAlchemy) backend — the sibling of `corpus-tsc-build.test.ts`.
// The fast `corpus-coverage` gate proves every corpus feature *generates* on
// `python`; this gate proves the emitted project is statically clean under
// `uv sync` + `ruff check` + `mypy --strict` (+ `pytest` when emitted tests
// exist) — the same `/warnaserror` bar the .NET gate sets — upgrading the
// corpus from a generation floor to a static-soundness guarantee on a THIRD
// backend, from the SAME single source of truth (one `.ddd` per feature, no
// per-backend duplicate).
//
// Slow (uv resolve/install + mypy per feature) — opt-in via LOOM_PYTHON_BUILD=1.
// CI shards one feature per cell via LOOM_CORPUS_PYTHON_CASE=<feature-id>.
// Requires uv on PATH.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_PYTHON_BUILD === "1";
const CASE = process.env.LOOM_CORPUS_PYTHON_CASE;

// Features that GENERATE on python but aren't yet ruff-/mypy-clean — real
// Python generator gaps this compile tier surfaced (the generation gate still
// covers all of them on all six backends; each line is a precise, reproducible
// bug report).  Widen the gate by FIXING the emitter, then dropping the entry.
const PYTHON_COMPILE_SKIP: Record<string, string> = {
  // FEATURE GAP (not an emitter bug): workflow own-state mutation.  `attempts := 1`
  // in a saga body is documented ("own-state mutation", workflow.md) but not yet
  // lowered — the same cross-backend gap the Hono tier tracks (corpus-tsc-build).
  "workflow-view": "FEATURE GAP: workflow own-state mutation (`field := …`) not yet lowered",
  // PLATFORM LIMITATION (the CLI refuses to generate, by design): provenanced
  // fields need the trace-capture runtime, emitted for node/dotnet only (DBT-1,
  // provenance.md).  Hosting the context on python is a generate-time error.
  provenance: "PLATFORM LIMITATION: provenance runtime is node/dotnet-only (DBT-1)",
  // Real Python generator bug: the repository hydration `_create(...)` call omits
  // the value-object-array fields (`line_items` / `surcharges`), so mypy --strict
  // rejects the missing named args (invoice_repository.py).
  "value-collections":
    "Python repo `_create` omits value-object-array args (mypy missing named arg)",
  // Real Python generator bug: the stamps entity imports `datetime.UTC` without
  // using it for this stamp shape (ruff F401, domain/order.py).
  stamps: "Python stamps entity imports unused `datetime.UTC` (ruff F401)",
  // Real Python generator bug: a workflow `let x = resource.get(...)` whose binding
  // is unused emits a dead local assignment (ruff F841, workflows_routes.py).
  resources: "Python workflow resource-let emits an unused local (ruff F841)",
};

// Every corpus feature the manifest declares to generate on `python`, minus the
// documented compile-tier skips.
const pythonFeatures = CORPUS.filter((f) => f.backends.includes("python"))
  .filter((f) => !(f.id in PYTHON_COMPILE_SKIP))
  .filter((f) => !CASE || f.id === CASE)
  .map((f) => f.id);

describe.skipIf(!ENABLED)("corpus features are statically clean (Python/FastAPI)", () => {
  it.each(
    pythonFeatures,
  )("%s — generated python project passes ruff + mypy --strict", (featureId) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-corpus-python-${featureId}-`));
    try {
      const src = materializeCorpusFixture(featureId, "python", outDir);
      execSync(`node ${cli} generate system ${src} -o ${outDir}`, {
        stdio: "inherit",
        cwd: repoRoot,
      });
      // The deployable is named `d` → its project lands under `d/`.
      const proj = path.join(outDir, CORPUS_DEPLOYABLE);
      expect(
        fs.existsSync(path.join(proj, "pyproject.toml")),
        `${featureId}: python project emitted`,
      ).toBe(true);
      const run = (cmd: string) => execSync(cmd, { cwd: proj, stdio: "inherit", timeout: 300_000 });
      run("uv sync");
      run("uv run ruff check .");
      const hasTests = fs.existsSync(path.join(proj, "tests"));
      run(`uv run mypy --strict app${hasTests ? " tests" : ""}`);
      if (hasTests) {
        run("uv run pytest -q");
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 600_000);
});
