// Playwright-style web-first locator assertions: each polls the live DOM
// (over whatever transport the locator uses) until it passes or times out,
// so a post-mutation update that lands a few ms late is awaited rather than
// lost to a one-shot read. Framework-neutral — the host's `expect(locator)`
// shim delegates here.

/** The locator surface the matchers read.  Both RemoteLocator and DomLocator
 *  satisfy this structurally. */
export interface AssertableLocator {
  innerText(): Promise<string>;
  count(): Promise<number>;
  inputValue(): Promise<string>;
  isVisible(): Promise<boolean>;
  isChecked(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
}

export interface LocatorAssertions {
  toBeVisible(): Promise<void>;
  toBeHidden(): Promise<void>;
  toHaveText(expected: string): Promise<void>;
  toContainText(expected: string): Promise<void>;
  toHaveValue(expected: string): Promise<void>;
  toHaveCount(expected: number): Promise<void>;
  toBeEnabled(): Promise<void>;
  toBeDisabled(): Promise<void>;
  toBeChecked(): Promise<void>;
  /** Negated form of every matcher above. */
  readonly not: Omit<LocatorAssertions, "not">;
}

export interface AssertionOptions {
  timeout?: number;
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 50;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const show = (v: unknown): string =>
  typeof v === "string" ? JSON.stringify(v) : String(v);

/** Poll `evaluate` (which reports whether the *un-negated* matcher holds)
 *  until the (possibly negated) result is satisfied, or throw on timeout. */
async function pollAssert(
  negate: boolean,
  evaluate: () => Promise<{ pass: boolean; message: string }>,
  timeout: number,
  pollMs: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let last = { pass: false, message: "assertion never evaluated" };
  for (;;) {
    try {
      last = await evaluate();
    } catch (e) {
      last = { pass: false, message: e instanceof Error ? e.message : String(e) };
    }
    if ((negate ? !last.pass : last.pass)) return;
    if (Date.now() >= deadline) {
      throw new Error((negate ? "expected NOT: " : "") + last.message);
    }
    await sleep(pollMs);
  }
}

export function createLocatorMatchers(
  loc: AssertableLocator,
  opts?: AssertionOptions,
): LocatorAssertions {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;

  const build = (negate: boolean): Omit<LocatorAssertions, "not"> => {
    const run = (
      evaluate: () => Promise<{ pass: boolean; message: string }>,
    ): Promise<void> => pollAssert(negate, evaluate, timeout, pollMs);
    return {
      toBeVisible: () =>
        run(async () => ({
          pass: await loc.isVisible(),
          message: "expected element to be visible",
        })),
      toBeHidden: () =>
        run(async () => ({
          pass: !(await loc.isVisible()),
          message: "expected element to be hidden",
        })),
      toHaveText: (expected) =>
        run(async () => {
          const actual = norm(await loc.innerText());
          return {
            pass: actual === norm(expected),
            message: `expected text ${show(expected)}, but got ${show(actual)}`,
          };
        }),
      toContainText: (expected) =>
        run(async () => {
          const actual = norm(await loc.innerText());
          return {
            pass: actual.includes(norm(expected)),
            message: `expected text to contain ${show(expected)}, but got ${show(actual)}`,
          };
        }),
      toHaveValue: (expected) =>
        run(async () => {
          const actual = await loc.inputValue();
          return {
            pass: actual === expected,
            message: `expected value ${show(expected)}, but got ${show(actual)}`,
          };
        }),
      toHaveCount: (expected) =>
        run(async () => {
          const actual = await loc.count();
          return {
            pass: actual === expected,
            message: `expected ${expected} element(s), but found ${actual}`,
          };
        }),
      toBeEnabled: () =>
        run(async () => ({
          pass: await loc.isEnabled(),
          message: "expected element to be enabled",
        })),
      toBeDisabled: () =>
        run(async () => ({
          pass: !(await loc.isEnabled()),
          message: "expected element to be disabled",
        })),
      toBeChecked: () =>
        run(async () => ({
          pass: await loc.isChecked(),
          message: "expected element to be checked",
        })),
    };
  };

  return { ...build(false), not: build(true) };
}
