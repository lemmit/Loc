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
): Promise<TestResult[]> {
  // Reuse the API harness's sequential runner (timing + pass/fail
  // capture) by binding `page` into each case.
  return runTests(
    tests.map((t) => ({ suite: "", name: t.name, fn: () => t.fn({ page }) })),
  );
}
