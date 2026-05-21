// In-browser test harness for the playground's API test runner.
//
// The Loom system generator emits `e2e/<System>.e2e.test.ts` — a
// vitest + `fetch` suite (`src/system/e2e-render.ts`).  This harness
// re-implements the tiny slice of `vitest` that file uses
// (`describe` / `it` / `expect(...).toBe` / `expect(fn).rejects.toThrow`)
// so the suite can run in the playground against the booted in-browser
// runtime, with no Node, no real vitest, and no network.
//
// Pure and dependency-free so it's unit-testable directly.

export interface TestCase {
  suite: string;
  name: string;
  fn: () => void | Promise<void>;
}

/** One line captured from `console.*` while a test ran. */
export interface ConsoleLine {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

export interface TestResult {
  suite: string;
  name: string;
  status: "pass" | "fail";
  durationMs: number;
  /** Assertion / thrown-error message when `status === "fail"`. */
  error?: string;
  /** `console.*` output captured during the run (omitted when empty). */
  logs?: ConsoleLine[];
}

export interface Harness {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: (received: unknown) => Expectation;
  /** Tests registered so far — filled as the suite module executes. */
  readonly tests: TestCase[];
}

interface Expectation {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  /** Synchronous throw assertion — `expect(() => …).toThrow()`, as the
   *  generated aggregate unit tests emit. */
  toThrow(matcher?: string | RegExp): void;
  readonly not: { toBe(expected: unknown): void; toEqual(expected: unknown): void };
  readonly rejects: { toThrow(matcher?: string | RegExp): Promise<void> };
}

function matchesError(err: unknown, matcher?: string | RegExp): boolean {
  if (matcher == null) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return typeof matcher === "string" ? msg.includes(matcher) : matcher.test(msg);
}

class AssertionError extends Error {}

function stringify(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(ao[k], bo[k]));
}

export function makeExpect(received: unknown): Expectation {
  return {
    toBe(expected: unknown): void {
      if (received !== expected) {
        throw new AssertionError(
          `expected ${stringify(received)} to be ${stringify(expected)}`,
        );
      }
    },
    toEqual(expected: unknown): void {
      if (!deepEqual(received, expected)) {
        throw new AssertionError(
          `expected ${stringify(received)} to equal ${stringify(expected)}`,
        );
      }
    },
    toBeGreaterThan(expected: number): void {
      if (!((received as number) > expected)) {
        throw new AssertionError(
          `expected ${stringify(received)} to be greater than ${stringify(expected)}`,
        );
      }
    },
    toBeGreaterThanOrEqual(expected: number): void {
      if (!((received as number) >= expected)) {
        throw new AssertionError(
          `expected ${stringify(received)} to be greater than or equal to ${stringify(expected)}`,
        );
      }
    },
    toBeLessThan(expected: number): void {
      if (!((received as number) < expected)) {
        throw new AssertionError(
          `expected ${stringify(received)} to be less than ${stringify(expected)}`,
        );
      }
    },
    toBeLessThanOrEqual(expected: number): void {
      if (!((received as number) <= expected)) {
        throw new AssertionError(
          `expected ${stringify(received)} to be less than or equal to ${stringify(expected)}`,
        );
      }
    },
    get not() {
      return {
        toBe(expected: unknown): void {
          if (received === expected) {
            throw new AssertionError(
              `expected ${stringify(received)} not to be ${stringify(expected)}`,
            );
          }
        },
        toEqual(expected: unknown): void {
          if (deepEqual(received, expected)) {
            throw new AssertionError(
              `expected ${stringify(received)} not to equal ${stringify(expected)}`,
            );
          }
        },
      };
    },
    toThrow(matcher?: string | RegExp): void {
      if (typeof received !== "function") {
        throw new AssertionError("toThrow expects a function");
      }
      try {
        (received as () => unknown)();
      } catch (err) {
        if (!matchesError(err, matcher)) {
          throw new AssertionError(
            `expected the thrown error to match ${String(matcher)}`,
          );
        }
        return;
      }
      throw new AssertionError("expected the call to throw, but it did not");
    },
    get rejects() {
      return {
        // The generator emits `expect(async () => { … }).rejects.toThrow()`,
        // so `received` is a function; invoke it to get the promise, then
        // require it to reject.  A resolved value is a failed expectation.
        async toThrow(matcher?: string | RegExp): Promise<void> {
          const promise =
            typeof received === "function"
              ? (received as () => unknown)()
              : received;
          try {
            await promise;
          } catch (err) {
            if (matcher != null) {
              const msg = err instanceof Error ? err.message : String(err);
              const ok =
                typeof matcher === "string"
                  ? msg.includes(matcher)
                  : matcher.test(msg);
              if (!ok) {
                throw new AssertionError(
                  `expected rejection ${stringify(msg)} to match ${String(matcher)}`,
                );
              }
            }
            return;
          }
          throw new AssertionError(
            "expected the call to reject, but it resolved",
          );
        },
      };
    },
  };
}

/** Fresh harness — its `describe`/`it`/`expect` are injected into the
 *  suite module, and `tests` collects what `it(...)` registered. */
export function createHarness(): Harness {
  const tests: TestCase[] = [];
  let currentSuite = "";
  return {
    describe(name: string, fn: () => void): void {
      const prev = currentSuite;
      currentSuite = name;
      try {
        fn();
      } finally {
        currentSuite = prev;
      }
    },
    it(name: string, fn: () => void | Promise<void>): void {
      tests.push({ suite: currentSuite, name, fn });
    },
    expect: makeExpect,
    tests,
  };
}

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

/** Patch `console.*` to tee into `sink` while still forwarding to the
 *  real console; returns a restore fn.  Lets the runner attach a test's
 *  own log output to its result for in-panel debugging. */
function captureConsole(sink: ConsoleLine[]): () => void {
  const original: Partial<Record<(typeof CONSOLE_LEVELS)[number], typeof console.log>> = {};
  for (const level of CONSOLE_LEVELS) {
    original[level] = console[level];
    console[level] = (...args: unknown[]): void => {
      sink.push({ level, text: args.map(formatArg).join(" ") });
      original[level]?.(...args);
    };
  }
  return () => {
    for (const level of CONSOLE_LEVELS) {
      if (original[level]) console[level] = original[level]!;
    }
  };
}

/** Run registered tests sequentially (the generated suites assume
 *  serial execution against one shared DB), capturing pass/fail and any
 *  `console.*` output the test body produced. */
export async function runTests(tests: TestCase[]): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const t of tests) {
    const start = now();
    const logs: ConsoleLine[] = [];
    const restore = captureConsole(logs);
    try {
      await t.fn();
      results.push({
        suite: t.suite,
        name: t.name,
        status: "pass",
        durationMs: now() - start,
        ...(logs.length ? { logs } : {}),
      });
    } catch (err) {
      results.push({
        suite: t.suite,
        name: t.name,
        status: "fail",
        durationMs: now() - start,
        error: err instanceof Error ? err.message : String(err),
        ...(logs.length ? { logs } : {}),
      });
    } finally {
      restore();
    }
  }
  return results;
}
