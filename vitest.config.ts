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
    exclude: ["node_modules/**", "test/fixtures/**"],
    testTimeout: 30_000,
  },
});
