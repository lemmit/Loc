// The `@playwright/test` slice the generated UI spec uses: `test(name,
// async ({ page }) => …)` + `expect`.  `test` collects cases; the
// runner invokes each with a `page` (a parent `RemotePage` bound to the
// driver transport).  `expect` is the same matcher set as the API
// harness.

import { makeExpect, runTests, type TestResult } from "./harness.js";
import type { RemotePage } from "./remote-page.js";

export interface UiTestCase {
  name: string;
  fn: (args: { page: RemotePage }) => void | Promise<void>;
}

export interface UiHarness {
  test: (
    name: string,
    fn: (args: { page: RemotePage }) => void | Promise<void>,
  ) => void;
  expect: typeof makeExpect;
  tests: UiTestCase[];
}

export function createUiHarness(): UiHarness {
  const tests: UiTestCase[] = [];
  return {
    test(name, fn) {
      tests.push({ name, fn });
    },
    expect: makeExpect,
    tests,
  };
}

export function runUiTests(
  tests: UiTestCase[],
  page: RemotePage,
  /** Suite name to report — must match the UI `ExecTestRef.suite`
   *  (`"<System> e2e"`) so results join the verification rollup. */
  suite = "",
): Promise<TestResult[]> {
  // Reuse the API harness's sequential runner (timing + pass/fail +
  // console capture) by binding `page` into each case, and capture a
  // best-effort final-state screenshot after each test (proof on pass,
  // evidence on fail).
  return runTests(
    tests.map((t) => ({ suite, name: t.name, fn: () => t.fn({ page }) })),
    {
      afterEach: async (r) => {
        const shot = await page.screenshot();
        if (shot) r.screenshot = shot;
      },
    },
  );
}
