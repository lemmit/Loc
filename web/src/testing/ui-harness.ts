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
import { RemoteLocator, type RemotePage } from "./remote-page.js";

export interface UiTestCase {
  name: string;
  fn: (args: { page: RemotePage }) => void | Promise<void>;
}

const LOCATOR_TIMEOUT_MS = 5_000;
const LOCATOR_POLL_MS = 50;
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const show = (v: unknown): string =>
  typeof v === "string" ? JSON.stringify(v) : String(v);

interface LocatorExpectation {
  toHaveText(expected: string): Promise<void>;
  toHaveCount(expected: number): Promise<void>;
  toBeVisible(): Promise<void>;
  readonly not: {
    toHaveText(expected: string): Promise<void>;
    toHaveCount(expected: number): Promise<void>;
  };
}

/** Poll `check` until it reports `ok`, then resolve; on timeout reject
 *  with the last failure message — Playwright's web-first retry. */
async function pollUntil(
  check: () => Promise<{ ok: boolean; message: string }>,
): Promise<void> {
  const deadline = Date.now() + LOCATOR_TIMEOUT_MS;
  let last = { ok: false, message: "assertion never evaluated" };
  for (;;) {
    try {
      last = await check();
    } catch (e) {
      last = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (last.ok) return;
    if (Date.now() >= deadline) throw new Error(last.message);
    await sleep(LOCATOR_POLL_MS);
  }
}

function makeLocatorExpect(loc: RemoteLocator): LocatorExpectation {
  const textCheck = (expected: string, negate: boolean) => async () => {
    const actual = (await loc.innerText()).trim();
    const eq = actual === expected;
    return {
      ok: negate ? !eq : eq,
      message: negate
        ? `expected element not to have text ${show(expected)}`
        : `expected element to have text ${show(expected)}, but got ${show(actual)}`,
    };
  };
  const countCheck = (expected: number, negate: boolean) => async () => {
    const actual = await loc.count();
    const eq = actual === expected;
    return {
      ok: negate ? !eq : eq,
      message: negate
        ? `expected not to have ${expected} element(s)`
        : `expected ${expected} element(s), but found ${actual}`,
    };
  };
  return {
    toHaveText: (e) => pollUntil(textCheck(e, false)),
    toHaveCount: (e) => pollUntil(countCheck(e, false)),
    async toBeVisible() {
      await loc.waitFor({ state: "visible" });
    },
    get not() {
      return {
        toHaveText: (e: string) => pollUntil(textCheck(e, true)),
        toHaveCount: (e: number) => pollUntil(countCheck(e, true)),
      };
    },
  };
}

type UiExpect = (
  received: unknown,
) => ReturnType<typeof makeExpect> | LocatorExpectation;

const uiExpect: UiExpect = (received) =>
  received instanceof RemoteLocator
    ? makeLocatorExpect(received)
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
