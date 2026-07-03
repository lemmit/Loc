import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "packages/**/*.test.ts"],
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
    // in the default `vitest run` (== `npm test`) they are discovered and
    // cleanly skipped (no docker, no build) — the same way the many opt-in
    // e2e suites that were never in the old `--exclude` list already behave.
    // A dedicated `test:*` script opts each back in by naming its file path
    // AND setting its env var.  (A config-level `exclude` can't live here:
    // vitest MERGES it with an explicitly-named path, so it would also block
    // the opt-in `test:*` runs — the reason the exclude list stayed a
    // per-script `--exclude` flag before this simplification removed it.)
    exclude: ["**/node_modules/**", "test/fixtures/**"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**"],
      // src/language/generated/ is langium codegen (gitignored); never our coverage.
      exclude: ["src/language/generated/**", "**/*.d.ts"],
    },
  },
});
