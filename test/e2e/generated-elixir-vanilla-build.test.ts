import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Slice 6 of docs/plans/vanilla-foundation-tdd-plan.md — CI gate for
// the vanilla emit subtree.  Parallel to test/e2e/generated-phoenix-
// build.test.ts but exercises `foundation: vanilla` deployables and
// expects no Ash deps in the generated mix.exs.
//
// For every fixture under `test/e2e/fixtures/elixir-vanilla-build/`,
// generate the project then `mix deps.get && mix compile
// --warnings-as-errors` inside the hexpm/elixir Docker image.  Catches
// every Elixir surface error the unit-test layer (string assertions)
// can't see — the actual acceptance gate for the vanilla emitters.
//
// Gated behind LOOM_PHOENIX_VANILLA_BUILD=1 so it stays out of the
// always-on `test` matrix; runs in CI via .github/workflows/elixir-
// vanilla-build.yml and locally via `npm run test:phoenix-vanilla`.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixturesDir = path.join(here, "fixtures", "elixir-vanilla-build");
const ENABLED = process.env.LOOM_PHOENIX_VANILLA_BUILD === "1";

describe.skipIf(!ENABLED)(
  "generated vanilla Phoenix project compiles against plain Ecto (LOOM_PHOENIX_VANILLA_BUILD=1)",
  () => {
    it.each([
      { name: "vanilla-min.ddd", deployable: "api" },
      { name: "vanilla-channels.ddd", deployable: "api" },
      // Event sourcing (T2.b) + operation `or`-union returns (T2.c) — compile the
      // from-scratch ES + producer-translation Elixir, not just the structure tests.
      { name: "vanilla-eventlog.ddd", deployable: "api" },
      { name: "vanilla-returns.ddd", deployable: "api" },
      // Returning-op body statements (T2.c tail) — precondition/requires raise
      // guards, `assign` struct-update, `emit` PubSub broadcast, fall-through
      // success serialised to a wire map.
      { name: "vanilla-returns-body.ddd", deployable: "api" },
      // ES applier folds over value-object / enum fields (P4.3): an inline VO
      // constructor renders to a plain map on vanilla — compile that path.
      { name: "vanilla-vo-fold.ddd", deployable: "api" },
      // Per-field changeset validators (T2.i) — validate_number/length/format.
      { name: "vanilla-invariants.ddd", deployable: "api" },
      // Event-sourced append → Dispatcher fan-out (an ES event a workflow saga
      // consumes) — compile the `<Ctx>.Dispatcher.dispatch/1` call in append.
      { name: "vanilla-es-dispatch.ddd", deployable: "api" },
      // Custom-find HTTP surface — list / single / param-less GET actions.
      { name: "vanilla-finds.ddd", deployable: "api" },
      // Union-returning find — tagged success + problem_variant absence.
      { name: "vanilla-union-find.ddd", deployable: "api" },
      // Capability `filter` AND-ed into every Ecto read (list/find_by_id/find/
      // retrieval/view) — plain Ecto has no Ash base_filter, so the conjoined
      // `from(... where: ...)` reads must compile (and not silently drop the filter).
      { name: "vanilla-capability-filter.ddd", deployable: "api" },
    ])("$name → mix compile --warnings-as-errors", ({ name, deployable }) => {
      const fixturePath = path.join(fixturesDir, name);
      const baseOutDir = process.env.LOOM_PHOENIX_OUT_DIR;
      const outDir = baseOutDir
        ? path.join(baseOutDir, name.replace(/\.ddd$/, ""))
        : fs.mkdtempSync(path.join(os.tmpdir(), "loom-vanilla-"));
      fs.mkdirSync(outDir, { recursive: true });

      try {
        // The vanilla orchestrator emits to `<deployable>/`, not
        // `phoenix_app/`.  Read the deployable slug per fixture.
        const projDir = path.join(outDir, "out", deployable);
        if (!fs.existsSync(path.join(projDir, "mix.exs"))) {
          execSync(`node ${cli} generate system ${fixturePath} -o ${outDir}/out`, {
            stdio: "inherit",
            cwd: repoRoot,
          });
        }
        expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);

        // Vanilla mix.exs must have zero Ash deps — re-asserting at
        // the e2e level on top of the unit assertion.
        const mix = fs.readFileSync(path.join(projDir, "mix.exs"), "utf8");
        expect(mix).not.toContain(":ash,");
        expect(mix).not.toContain(":ash_postgres,");
        expect(mix).not.toContain(":ash_phoenix,");

        // mix deps.get + compile inside the elixir image.  Mirrors the Ash
        // test's 600s exec timeout — cold-cache mix deps.get + compile of
        // a plain Phoenix+Ecto skeleton fits comfortably under this budget,
        // but the headroom protects against transient hex registry slowness.
        const image = "hexpm/elixir:1.17.2-erlang-27.0.1-debian-bookworm-20240722-slim";
        execSync(
          `docker run --rm -v ${projDir}:/app -w /app -e MIX_ENV=prod ${image} ` +
            `bash -c 'mix local.hex --force && mix local.rebar --force && ` +
            `mix deps.get --only prod && mix compile --warnings-as-errors'`,
          { stdio: "inherit", cwd: repoRoot, timeout: 600_000 },
        );
      } finally {
        if (!baseOutDir) {
          try {
            fs.rmSync(outDir, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
        }
      }
    }, 700_000);
    // Cold mix deps.get + mix compile inside docker can take several
    // minutes on a fresh cache; mirror the Ash test's 700_000 ms
    // per-test timeout so vitest doesn't kill the docker exec at the
    // default 30s.
  },
);
