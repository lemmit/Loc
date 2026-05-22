// Unit test runner — runs the generated aggregate unit suites
// (`<backend>/domain/<agg>.test.ts`) in the playground.
//
// These are pure in-process domain tests: they import the generated
// aggregate / value-object / id classes and call them directly
// (`Order.create({…})`, `expectThrows order.confirm()`), with no HTTP,
// no DB, no booted runtime.  So we bundle the test + its domain imports
// (esbuild over the domain VFS, `vitest` aliased to the harness) and run
// it — runnable straight after Generate, before any Boot.

import { createHarness, runTests, type TestCase, type TestResult } from "./harness.js";
import type { EsbuildBuild } from "./transform-client.js";
import type { VirtualFile } from "../build/protocol.js";

const VITEST_SHIM =
  "export const describe = globalThis.__loomUnit.describe;" +
  " export const it = globalThis.__loomUnit.it;" +
  " export const expect = globalThis.__loomUnit.expect;";

/** Generated aggregate unit suites in a file tree (one per aggregate
 *  that declares `test "…" { … }`). */
export function findUnitTestFiles(files: VirtualFile[]): VirtualFile[] {
  return files.filter((f) => /(^|\/)domain\/[^/]+\.test\.ts$/.test(f.path));
}

/** The domain dir holding `spec` (the aggregate + its value-objects /
 *  ids / enums / events / errors) — everything the test imports. */
export function unitSuiteFiles(
  files: VirtualFile[],
  spec: VirtualFile,
): Record<string, string> {
  const dir = spec.path.slice(0, spec.path.lastIndexOf("/") + 1);
  const out: Record<string, string> = {};
  for (const f of files) {
    if (f.path.startsWith(dir) && /\.tsx?$/.test(f.path)) out[f.path] = f.content;
  }
  return out;
}

interface UnitGlobal {
  describe: ReturnType<typeof createHarness>["describe"];
  it: ReturnType<typeof createHarness>["it"];
  expect: ReturnType<typeof createHarness>["expect"];
}

export interface LoadUnitSuiteOpts {
  entry: string;
  files: Record<string, string>;
  build: EsbuildBuild;
}

/** Bundle + register the unit suite (run `describe`/`it`, NOT the
 *  bodies).  The bundled module captures the harness off
 *  `globalThis.__loomUnit` at import, so it's safe to clear after. */
export async function loadUnitSuite(
  opts: LoadUnitSuiteOpts,
): Promise<TestCase[]> {
  const js = await opts.build(opts.entry, opts.files, { vitest: VITEST_SHIM });
  const harness = createHarness();
  const g = globalThis as unknown as { __loomUnit?: UnitGlobal };
  g.__loomUnit = {
    describe: harness.describe,
    it: harness.it,
    expect: harness.expect,
  };
  const url = URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
  try {
    await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
    delete g.__loomUnit;
  }
  return harness.tests;
}

export async function runUnitSuite(
  opts: LoadUnitSuiteOpts,
): Promise<TestResult[]> {
  return runTests(await loadUnitSuite(opts));
}
