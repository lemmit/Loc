// The `@playwright/test` slice the generated UI spec uses: `test(name,
// async ({ page }) => …)` + `expect`.  `test` collects cases; the
// runner invokes each with a `page` (a parent `RemotePage` bound to the
// driver transport).
//
// `expect` mirrors Playwright's: handed a plain value it behaves like the
// API harness's one-shot matchers; handed a `RemoteLocator` it returns
// Playwright's web-first matchers — `toHaveText` / `toHaveCount` /
// `toBeVisible` — which AUTO-RETRY against the live DOM until they pass or
// time out.  That retry is what makes the playground faithful to real
// Playwright: a post-mutation refetch that lands a few ms late is awaited,
// not lost to a one-shot read.

import { makeExpect, runTests, type TestResult } from "./harness.js";
import {
  createLocatorMatchers,
  RemoteLocator,
  type LocatorAssertions,
  type RemotePage,
} from "../../../packages/ui-test-driver/index";
import type { LogLine } from "../util/log-line";

export interface UiTestCase {
  name: string;
  fn: (args: { page: RemotePage }) => void | Promise<void>;
}

type UiExpect = (
  received: unknown,
) => ReturnType<typeof makeExpect> | LocatorAssertions;

// Handed a RemoteLocator, return Playwright's web-first matchers (which
// auto-retry against the live DOM); handed a plain value, the one-shot
// matchers. The locator matchers live in the driver package so the
// capability ships with it.
const uiExpect: UiExpect = (received) =>
  received instanceof RemoteLocator
    ? createLocatorMatchers(received)
    : makeExpect(received);

export interface UiHarness {
  test: (
    name: string,
    fn: (args: { page: RemotePage }) => void | Promise<void>,
  ) => void;
  expect: UiExpect;
  tests: UiTestCase[];
}

export function createUiHarness(): UiHarness {
  const tests: UiTestCase[] = [];
  return {
    test(name, fn) {
      tests.push({ name, fn });
    },
    expect: uiExpect,
    tests,
  };
}

export function runUiTests(
  tests: UiTestCase[],
  page: RemotePage,
  /** Suite name to report — must match the UI `ExecTestRef.suite`
   *  (`"<System> e2e"`) so results join the verification rollup. */
  suite = "",
  /** Live accessor for the preview app's captured console/error stream.
   *  When provided, each test's slice (the lines emitted while it ran)
   *  is attached to its `TestResult.logs` — so a failing UI test reports
   *  the generated app's own output, not just a screenshot. */
  getAppLog?: () => LogLine[],
): Promise<TestResult[]> {
  // Reuse the API harness's sequential runner (timing + pass/fail +
  // console capture) by binding `page` into each case, and capture a
  // best-effort final-state screenshot after each test (proof on pass,
  // evidence on fail).  Tests run sequentially, so a moving cursor into
  // the (append-only) app-log buffer slices each test's own output.
  let cursor = getAppLog ? getAppLog().length : 0;
  return runTests(
    tests.map((t) => ({ suite, name: t.name, fn: () => t.fn({ page }) })),
    {
      afterEach: async (r) => {
        const shot = await page.screenshot();
        if (shot) r.screenshot = shot;
        if (getAppLog) {
          const all = getAppLog();
          const slice = all.slice(cursor);
          cursor = all.length;
          if (slice.length > 0) r.logs = [...(r.logs ?? []), ...slice];
        }
      },
    },
  );
}
