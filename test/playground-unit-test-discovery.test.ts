// Unit tests for the unit-suite discovery helpers (web/src/testing/
// run-unit-tests.ts) — the pure file-tree selection that feeds the
// playground's Tests panel.  (The bundle/run path is browser-only and
// exercised live.)

import { describe, expect, it } from "vitest";
import type { VirtualFile } from "../web/src/build/protocol.js";
import { findUnitTestFiles, unitSuiteFiles } from "../web/src/testing/run-unit-tests.js";

const f = (path: string, content = ""): VirtualFile => ({
  path,
  content,
  size: content.length,
});

describe("unit-suite discovery", () => {
  const files = [
    f("catalog_web/domain/product.ts"),
    f("catalog_web/domain/product.test.ts", "test product"),
    f("catalog_web/domain/value-objects.ts", "vo"),
    f("catalog_web/domain/ids.ts", "ids"),
    f("catalog_web/http/index.ts"),
    f("catalog_web/e2e/Acme.ui.spec.ts"), // not a unit test
    f("e2e/Acme.e2e.test.ts"), // api e2e, not a unit test
  ];

  it("finds only the domain/*.test.ts unit suites", () => {
    expect(findUnitTestFiles(files).map((x) => x.path)).toEqual([
      "catalog_web/domain/product.test.ts",
    ]);
  });

  it("gathers the domain dir (aggregate + VOs/ids) for the bundle", () => {
    const spec = findUnitTestFiles(files)[0];
    const bundleFiles = unitSuiteFiles(files, spec);
    // The whole domain dir comes along (so `./value-objects`, `./ids`
    // resolve), but nothing outside it.
    expect(Object.keys(bundleFiles).sort()).toEqual([
      "catalog_web/domain/ids.ts",
      "catalog_web/domain/product.test.ts",
      "catalog_web/domain/product.ts",
      "catalog_web/domain/value-objects.ts",
    ]);
    expect(bundleFiles).not.toHaveProperty("catalog_web/http/index.ts");
  });
});
