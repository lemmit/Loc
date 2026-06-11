import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Generator regression gate: emit each fixture via `ddd generate system`,
// then run the generated Python project's full static toolchain —
// `uv sync` (resolve + install the pinned dep set), `ruff check`,
// `ruff format --check` (the emitted source must be ruff-format-clean,
// the Python analogue of the Biome gate on emitted TS), and
// `mypy --strict app` (the same bar `/warnaserror` sets for .NET).
//
// Mirrors `generated-dotnet-build.test.ts`.  Opt-in via
// LOOM_PYTHON_BUILD=1 so the default `npm test` stays fast.  CI's
// `.github/workflows/python-build.yml` runs the same check.
//
// Requires `uv` on PATH (it provisions Python 3.12 itself).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_PYTHON_BUILD === "1";

/** Fixture → the deployable folder (serviceSlug) to gate. */
const CASES: Array<[fixture: string, project: string]> = [
  ["test/e2e/fixtures/python-build/shell.ddd", "api"],
  // Entity parts + containment + collection ops + money domain logic.
  ["test/e2e/fixtures/python-build/domain.ddd", "api"],
  // TPH (shared kind-discriminated table) + TPC (per-concrete tables)
  // hierarchies with polymorphic base readers.
  ["test/e2e/fixtures/python-build/inheritance.ddd", "api"],
  // persistedAs(eventLog): append-only stream + appliers fold.
  ["test/e2e/fixtures/python-build/eventlog.ddd", "api"],
  // Channels + event-triggered saga (in-process dispatcher, persisted
  // correlation state).
  ["test/e2e/fixtures/python-build/saga.ddd", "api"],
  // `auth: required` — User dataclass + verifier registry + middleware,
  // requires-guarded op/workflow, currentUser-scoped find.
  ["test/e2e/fixtures/python-build/auth.ddd", "api"],
  // `seed { ... }` — domain-create + raw datasets, __loom_seed marker.
  ["test/e2e/fixtures/python-build/seeds.ddd", "api"],
];

describe.skipIf(!ENABLED)(
  "generated Python project passes uv sync + ruff + mypy --strict (LOOM_PYTHON_BUILD=1)",
  () => {
    it.each(CASES)(
      "%s — generated project is statically clean",
      (fixture, project) => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-python-"));
        try {
          execSync(`node ${cli} generate system ${fixture} -o ${outDir}`, {
            stdio: "inherit",
            cwd: repoRoot,
          });
          const proj = path.join(outDir, project);
          expect(fs.existsSync(path.join(proj, "pyproject.toml"))).toBe(true);
          const run = (cmd: string) =>
            execSync(cmd, { cwd: proj, stdio: "inherit", timeout: 300_000 });
          // No `ruff format --check`: arbitrary domain expressions (long
          // derived chains) can't guarantee format-identical output —
          // same reason dotnet/phoenix keep their format checks as
          // separate opt-in suites rather than the build gate.
          run("uv sync");
          run("uv run ruff check .");
          const hasTests = fs.existsSync(path.join(proj, "tests"));
          run(`uv run mypy --strict app${hasTests ? " tests" : ""}`);
          if (hasTests) {
            run("uv run pytest -q");
          }
        } finally {
          try {
            fs.rmSync(outDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      },
      600_000,
    );
  },
);
