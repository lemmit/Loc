/// <reference lib="webworker" />
import { synthDDL } from "./ddl";
import { pgliteAssetUrl } from "../bundle/plugin.js";
import type {
  BootResult,
  DispatchResult,
  RuntimeRpcRequest,
  RuntimeRpcResponse,
  SerializedRequest,
  SerializedResponse,
} from "./protocol.js";

declare const self: DedicatedWorkerGlobalScope;

// PGlite's normal boot path computes WASM/data URLs relative to its
// own `import.meta.url` and fetches them at runtime.  When the
// bundle is loaded from a `blob:` URL the relative resolution lands
// on a nonexistent path.  PGlite's escape hatch is the
// `{ pgliteWasmModule, initdbWasmModule, fsBundle }` constructor
// options: pre-compile / pre-fetch the artifacts and it skips its
// own URL-based loading entirely.  See bundle/plugin.ts
// `pgliteAssetUrl` for the shared (jsdelivr-hosted) source.

interface BundleModule {
  createApp: (db: unknown) => { fetch: (req: Request) => Promise<Response> };
  schema: Record<string, unknown>;
  drizzle: (pglite: unknown, opts: { schema: Record<string, unknown> }) => unknown;
  // `new PGlite()`, `new PGlite(options)`, or `new PGlite(dataDir, options)`.
  // PGlite picks the right overload based on whether the first arg is
  // a string.  `dataDir` of `":memory:"` (or omitted) is in-memory;
  // `"opfs-ahp://<name>"` enables OPFS persistence.
  PGlite: new (
    dataDirOrOptions?: string | unknown,
    options?: unknown,
  ) => { exec: (sql: string) => Promise<unknown>; close?: () => Promise<void> };
  is: (value: unknown, type: unknown) => boolean;
  Table: unknown;
  getTableConfig: (t: unknown) => never;
}

let cachedPgliteWasm: WebAssembly.Module | null = null;
let cachedInitdbWasm: WebAssembly.Module | null = null;
let cachedFsBundle: Blob | null = null;

async function loadPgliteAssets(): Promise<{
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
  fsBundle: Blob;
}> {
  if (!cachedPgliteWasm || !cachedInitdbWasm || !cachedFsBundle) {
    const [pgliteRes, initdbRes, dataRes] = await Promise.all([
      fetch(pgliteAssetUrl("pglite.wasm")),
      fetch(pgliteAssetUrl("initdb.wasm")),
      fetch(pgliteAssetUrl("pglite.data")),
    ]);
    if (!pgliteRes.ok) throw new Error(`pglite.wasm fetch failed: ${pgliteRes.status}`);
    if (!initdbRes.ok) throw new Error(`initdb.wasm fetch failed: ${initdbRes.status}`);
    if (!dataRes.ok) throw new Error(`pglite.data fetch failed: ${dataRes.status}`);
    const [pgliteMod, initdbMod, dataBlob] = await Promise.all([
      WebAssembly.compileStreaming(pgliteRes),
      WebAssembly.compileStreaming(initdbRes),
      dataRes.blob(),
    ]);
    cachedPgliteWasm = pgliteMod;
    cachedInitdbWasm = initdbMod;
    cachedFsBundle = dataBlob;
  }
  return {
    pgliteWasmModule: cachedPgliteWasm,
    initdbWasmModule: cachedInitdbWasm,
    fsBundle: cachedFsBundle,
  };
}

interface RuntimeState {
  app: { fetch: (req: Request) => Promise<Response> };
  pglite: { close?: () => Promise<void>; exec: (sql: string) => Promise<unknown> };
  ddl: string;
  /** Blob URL the bundle was loaded from.  Tracked here so we can
   *  revoke on reset and on the next boot — without this, every
   *  successful Boot leaks one URL for the worker's lifetime. */
  bundleUrl: string;
  /** Cached `mod.PGlite` ctor for `wipe()` to reuse.  We could
   *  instead `mod.drizzle(state.pglite, ...)` to rebuild the app,
   *  but DROP+CREATE inside the existing PGlite is simpler. */
  PGlite: BundleModule["PGlite"];
  drizzle: BundleModule["drizzle"];
  schema: BundleModule["schema"];
  createApp: BundleModule["createApp"];
}

let state: RuntimeState | null = null;

// Default cap on a single dispatch.  A generated op with an
// infinite loop or a runaway query would otherwise hang the worker
// forever — every subsequent dispatch queues behind it and the
// UI looks frozen with no recovery path.
const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

async function tearDownState(): Promise<void> {
  if (!state) return;
  try {
    await state.pglite.close?.();
  } catch {
    // best-effort
  }
  try {
    URL.revokeObjectURL(state.bundleUrl);
  } catch {
    // best-effort
  }
  state = null;
}

async function boot(bundleCode: string, dataDir?: string): Promise<BootResult> {
  const start = performance.now();
  // Tear down a previous boot if present (close PGlite + revoke its
  // bundle URL).
  await tearDownState();

  const blob = new Blob([bundleCode], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  let mod: BundleModule;
  try {
    mod = (await import(/* @vite-ignore */ url)) as unknown as BundleModule;
  } catch (err) {
    URL.revokeObjectURL(url);
    return {
      ok: false,
      message: `Bundle import failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Keep the blob URL alive for the lifetime of the module — some
  // browsers re-fetch sub-resources lazily.  Stored on `state` so
  // tearDownState can revoke it on reset / next boot.

  // Try the requested persistent backend first; fall back to
  // in-memory if the browser refuses (Safari < 17, restrictive
  // iframe sandboxing, etc.).  `persistent` flag flows back to the
  // UI so the badge can say "in-memory" instead of misleadingly
  // claiming "persisted" when storage is actually ephemeral.
  let pglite;
  let persistent = false;
  try {
    const assets = await loadPgliteAssets();
    if (dataDir && dataDir !== ":memory:") {
      try {
        pglite = new mod.PGlite(dataDir, assets);
        persistent = true;
      } catch (err) {
        console.warn(
          `[runtime] persistent dataDir "${dataDir}" rejected, falling back to :memory:`,
          err,
        );
        pglite = new mod.PGlite(assets);
      }
    } else {
      pglite = new mod.PGlite(assets);
    }
  } catch (err) {
    return {
      ok: false,
      message: `PGlite boot failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let ddl: string;
  try {
    ddl = synthDDL(mod.schema, {
      is: mod.is,
      Table: mod.Table,
      getTableConfig: mod.getTableConfig,
    });
  } catch (err) {
    return {
      ok: false,
      message: `DDL synth failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    if (ddl.trim().length > 0) await pglite.exec(ddl);
  } catch (err) {
    return {
      ok: false,
      message: `DDL execution failed: ${err instanceof Error ? err.message : String(err)}\n--- DDL ---\n${ddl}`,
    };
  }

  let app: BundleModule["createApp"] extends (db: unknown) => infer R ? R : never;
  try {
    const db = mod.drizzle(pglite, { schema: mod.schema });
    app = mod.createApp(db);
  } catch (err) {
    return {
      ok: false,
      message: `createApp failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  state = {
    app,
    pglite,
    ddl,
    bundleUrl: url,
    PGlite: mod.PGlite,
    drizzle: mod.drizzle,
    schema: mod.schema,
    createApp: mod.createApp,
  };
  return {
    ok: true,
    ddl,
    durationMs: Math.round(performance.now() - start),
    persistent,
  };
}

async function dispatch(req: SerializedRequest): Promise<DispatchResult> {
  if (!state) {
    return { ok: false, message: "Runtime not booted — call /boot first." };
  }
  const start = performance.now();
  try {
    const request = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
    });
    // Race the dispatch against a timeout so a hung handler
    // (infinite loop, deadlock in user logic, network in the
    // generated app waiting forever) doesn't wedge the worker.
    // The user can interrupt by reset; without the race, every
    // subsequent dispatch queues behind the hung one and the UI
    // never recovers.
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Response>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`dispatch timed out after ${DEFAULT_DISPATCH_TIMEOUT_MS} ms`));
      }, DEFAULT_DISPATCH_TIMEOUT_MS);
    });
    let response: Response;
    try {
      response = await Promise.race([state.app.fetch(request), timeoutPromise]);
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const body = await response.text();
    const out: SerializedResponse = {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
    };
    return { ok: true, response: out, durationMs: Math.round(performance.now() - start) };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function reset(): Promise<{ ok: true }> {
  await tearDownState();
  return { ok: true };
}

// Drop every user object inside the currently-booted PGlite, then
// re-apply DDL from the cached schema metadata.  Works the same
// for in-memory and OPFS-backed PGlite — for OPFS the underlying
// data island is preserved (so the next reload reattaches a clean
// schema), but the rows are gone.  No-op when not booted.
async function wipe(): Promise<{ ok: boolean; message?: string }> {
  if (!state) {
    return { ok: false, message: "Runtime not booted — nothing to wipe." };
  }
  try {
    // `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` is the
    // shortest path to "remove every user object and start fresh".
    // Postgres-flavoured PGlite supports it.  We then re-run the
    // saved DDL to recreate the tables in the same shape.
    await state.pglite.exec(
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
    );
    if (state.ddl.trim().length > 0) {
      await state.pglite.exec(state.ddl);
    }
    // The drizzle db + Hono app are still bound to the same
    // PGlite instance, so they keep working without a rebuild.
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

self.onmessage = async (ev: MessageEvent<RuntimeRpcRequest>) => {
  const req = ev.data;
  const response: RuntimeRpcResponse = { id: req.id };
  try {
    switch (req.method) {
      case "boot":
        response.result = await boot(req.params.bundleCode, req.params.dataDir);
        break;
      case "dispatch":
        response.result = await dispatch(req.params);
        break;
      case "reset":
        response.result = await reset();
        break;
      case "wipe":
        response.result = await wipe();
        break;
      default:
        response.error = {
          message: `Unknown method: ${(req as { method: string }).method}`,
        };
    }
  } catch (err) {
    response.error = {
      message: err instanceof Error ? err.message : String(err),
    };
  }
  self.postMessage(response);
};
