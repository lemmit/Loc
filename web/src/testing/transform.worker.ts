// esbuild-wasm TS-transform worker for the API test runner.
//
// The generated `e2e/*.e2e.test.ts` suite is TypeScript; the runner
// executes it via `new Function`, which needs plain JS.  This worker
// type-strips a single self-contained file (no bundling, no module
// resolution) with esbuild-wasm `transform`.
//
// It's a separate, tiny worker rather than a method on the project
// bundler worker so it stays decoupled — its only job is `transform`.
// esbuild is initialised once per worker thread; the wasm bytes are
// already cached by the browser from the project bundler's fetch.

import * as esbuild from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";

export interface TransformRequest {
  id: number;
  ts: string;
}

export interface TransformResponse {
  id: number;
  ok: boolean;
  code?: string;
  message?: string;
}

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const res = await fetch(wasmURL);
      if (!res.ok) {
        throw new Error(
          `transform.worker: failed to fetch esbuild wasm (${res.status} ${res.statusText})`,
        );
      }
      const wasmModule = await WebAssembly.compile(await res.arrayBuffer());
      await esbuild.initialize({ wasmModule, worker: false });
    })();
  }
  return initPromise;
}

self.onmessage = async (ev: MessageEvent<TransformRequest>): Promise<void> => {
  const { id, ts } = ev.data;
  try {
    await ensureInit();
    const out = await esbuild.transform(ts, {
      loader: "ts",
      // Keep it as plain top-level statements (the suite has no
      // imports/exports once the `vitest` import is stripped) so the
      // runner can execute it via `new Function`.
      format: "esm",
    });
    self.postMessage({ id, ok: true, code: out.code } satisfies TransformResponse);
  } catch (e) {
    self.postMessage({
      id,
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    } satisfies TransformResponse);
  }
};
