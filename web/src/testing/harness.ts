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

export interface TestResult {
  suite: string;
  name: string;
  status: "pass" | "fail";
  durationMs: number;
  /** Assertion / thrown-error message when `status === "fail"`. */
  error?: string;
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
  readonly rejects: { toThrow(matcher?: string | RegExp): Promise<void> };
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

function makeExpect(received: unknown): Expectation {
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

/** Run registered tests sequentially (the generated suites assume
 *  serial execution against one shared DB), capturing pass/fail. */
export async function runTests(tests: TestCase[]): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const t of tests) {
    const start = now();
    try {
      await t.fn();
      results.push({
        suite: t.suite,
        name: t.name,
        status: "pass",
        durationMs: now() - start,
      });
    } catch (err) {
      results.push({
        suite: t.suite,
        name: t.name,
        status: "fail",
        durationMs: now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
