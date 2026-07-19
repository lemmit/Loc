// API test runner — orchestrates running the generated `e2e/*.e2e.test.ts`
// suite in the playground against the booted runtime.
//
// Steps: strip the `vitest` import, transpile TS→JS (the only
// browser-only seam — esbuild-wasm — is injected as `compile`), then
// run the suite body via `new Function` with our harness globals +
// the dispatch-backed `fetch` injected.  No bundler, no blob import.
//
// `compile` is injected so the orchestration is unit-testable with a
// plain-JS source and a fake dispatcher.

import { createHarness, runTests, type TestCase, type TestResult } from "./harness.js";
import { makeDispatchFetch } from "./fetch-dispatch.js";
import type {
  DispatchResult,
  SerializedRequest,
} from "../runtime/protocol.js";
import type { VirtualFile } from "../build/protocol.js";

/** TS→JS transpile (strip types).  In the app this is esbuild-wasm
 *  `transform`; in tests it can be a passthrough for plain JS. */
export type TsCompile = (ts: string) => Promise<string>;

/** The generated API e2e suite within a generated file tree, if the
 *  source declared any `test e2e … against <backend>` blocks. */
export function findApiTestFile(files: VirtualFile[]): VirtualFile | null {
  return (
    files.find((f) => /(^|\/)e2e\/[^/]+\.e2e\.test\.ts$/.test(f.path)) ?? null
  );
}

const VITEST_IMPORT_RE =
  /^[ \t]*import\s*\{[^}]*\}\s*from\s*["']vitest["'];?[ \t]*$/m;

export interface RunApiTestsOpts {
  /** Contents of the generated `e2e/<System>.e2e.test.ts`. */
  source: string;
  compile: TsCompile;
  dispatch: (req: SerializedRequest) => Promise<DispatchResult>;
  /** Values exposed to the suite as `process.env` — the emitted `__authHeaders`
   *  reads `E2E_DEV_CLAIMS` (dev-stub principal) / `E2E_BEARER_TOKEN` (OIDC) from
   *  here.  Empty by default (auth-less systems need nothing). */
  env?: Record<string, string | undefined>;
}

/** Register the suite (run `describe`/`it`, NOT the test bodies) so the
 *  caller can list and run cases individually.  The returned cases'
 *  `fn`s close over the dispatch-backed `fetch`, so they're runnable
 *  on demand via `runTests`. */
export async function loadApiTests(opts: RunApiTestsOpts): Promise<TestCase[]> {
  const stripped = opts.source.replace(VITEST_IMPORT_RE, "");
  const js = await opts.compile(stripped);
  const harness = createHarness();
  const fetchImpl = makeDispatchFetch(opts.dispatch);
  const runSuite = new Function(
    "describe",
    "it",
    "expect",
    "fetch",
    "process",
    js,
  ) as (
    describe: typeof harness.describe,
    it: typeof harness.it,
    expect: typeof harness.expect,
    fetch: typeof fetchImpl,
    process: { env: Record<string, string | undefined> },
  ) => void;
  runSuite(harness.describe, harness.it, harness.expect, fetchImpl, {
    env: opts.env ?? {},
  });
  return harness.tests;
}

export async function runApiTests(
  opts: RunApiTestsOpts,
): Promise<TestResult[]> {
  return runTests(await loadApiTests(opts));
}
