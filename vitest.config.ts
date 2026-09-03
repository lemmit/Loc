import { defineConfig } from "vitest/config";

// ── Why the suite is split into projects ─────────────────────────────────────
//
// The fast suite is ~1,900 files whose test bodies are cheap; what was NOT
// cheap was the per-file fixed cost.  With vitest's default `isolate: true`
// every file re-evaluates the whole toolchain module graph (~336k LOC incl.
// the 730 KB generated Langium grammar) — measured on a typical generator
// file: 1.6 s of tests, ~11 s of import.  Across the suite that fixed cost
// was the suite: `test/generator/react` (82 files) took 163 s isolated and
// 38 s with `isolate: false`; the full run went from >10 min (CI: ~20 min
// single-job) to ~6 min on the same 4 cores.
//
// `isolate: false` keeps one module graph per worker, so a file that mutates
// module state can leak into the next file in that worker.  Two kinds of
// files need the old per-file isolation and get it via their own project:
//
//   • `mocked`  — files that `vi.mock()` a src module.  A hoisted module mock
//                 rewires the module registry for every later file in the
//                 worker (vitest documents `vi.mock` + `isolate: false` as
//                 unsafe).  Add a file here when it uses `vi.mock`/`vi.doMock`.
//   • `corpus`  — the whole-corpus censuses (each iterates every tracked
//                 `.ddd`), the four files that take >30 s each.  Isolation is
//                 not their problem; they are separated so CI can run them as
//                 their own job instead of letting one of them pin a shard's
//                 wall-clock (see .github/workflows/test.yml).
//
// Everything else is `unit`: shared module graph, no per-file isolation.
// A test that needs a fresh module graph belongs in `mocked`; a test that
// needs fresh PROCESS state (env, cwd) must restore it itself (afterEach) —
// that was already true under the default `forks` pool, which reuses
// processes across files.
//
// Local affected-only runs: `npm test` = `vitest run --changed origin/main`
// (files whose import graph reaches a changed file); `npm run test:all` is
// the whole suite, what CI runs.

/** Files that `vi.mock()` a src module — keep per-file isolation. */
const MOCKED = [
  "test/language/validation/validator-fault-isolation.test.ts",
  "test/platform/pack-render-reachability.test.ts",
  "test/playground/expr-hints-cache.test.ts",
];

/** Whole-corpus censuses (>30 s each) — their own CI job. */
const CORPUS = [
  "test/conformance/corpus-mutation.test.ts",
  "test/language/print/print-roundtrip.test.ts",
  "test/system/emitted-unbound-identifiers.test.ts",
  "test/cli/new.test.ts",
];

const INCLUDE = ["test/**/*.test.ts", "packages/**/*.test.ts"];

// test/fixtures/baseline-output/ is a snapshot of the legacy
// generator's emitted file tree (regression fixture for the
// page-metamodel migration; see scripts/capture-baseline-fixture.mjs).
// Vitest must not try to execute the .test.ts files inside it as
// real tests — they require a running backend on :8080 and are
// byte-for-byte copies of generated source we are diffing against,
// not part of this project's own test surface.
// `**/node_modules/**` (not just root `node_modules/**`) so the
// opt-in harness deps under test/behavioral/node_modules — installed
// by `npm ci` there for the behavioral tiers — aren't discovered as
// this project's tests.
// The slow opt-in suites under test/e2e/ are NOT excluded here: each
// self-gates on a `LOOM_*` env var via `describe.skipIf(!ENABLED)`, so
// in the default `vitest run` (== `npm run test:all`) they are discovered
// and cleanly skipped (no docker, no build) — the same way the many opt-in
// e2e suites that were never in the old `--exclude` list already behave.
// A dedicated `test:*` script opts each back in by naming its file path
// AND setting its env var.  (A config-level `exclude` can't live here:
// vitest MERGES it with an explicitly-named path, so it would also block
// the opt-in `test:*` runs — the reason the exclude list stayed a
// per-script `--exclude` flag before this simplification removed it.)
const EXCLUDE = ["**/node_modules/**", "test/fixtures/**"];

// NOTE: `include` deliberately lives ONLY on the projects.  A project with
// `extends: true` MERGES arrays with the root config (vitest's mergeConfig
// concatenates), so a root `include` would make every project discover every
// file — three copies of the suite, verified: `vitest list --filesOnly
// --project mocked` counted all 1,889 files until the root include went.
export default defineConfig({
  test: {
    exclude: EXCLUDE,
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: INCLUDE,
          exclude: [...MOCKED, ...CORPUS],
          isolate: false,
        },
      },
      {
        extends: true,
        test: { name: "mocked", include: MOCKED, isolate: true },
      },
      {
        extends: true,
        test: { name: "corpus", include: CORPUS, isolate: false },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**"],
      // src/language/generated/ is langium codegen (gitignored); never our coverage.
      exclude: ["src/language/generated/**", "**/*.d.ts"],
    },
  },
});
