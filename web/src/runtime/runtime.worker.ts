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
  PGlite: new (options?: unknown) => { exec: (sql: string) => Promise<unknown>; close?: () => Promise<void> };
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
  pglite: { close?: () => Promise<void> };
  ddl: string;
}

let state: RuntimeState | null = null;

async function boot(bundleCode: string): Promise<BootResult> {
  const start = performance.now();
  // Tear down a previous boot if present.  PGlite exposes `close`;
  // we'd ignore failures because the new boot will replace state
  // wholesale anyway.
  if (state) {
    try {
      await state.pglite.close?.();
    } catch {
      // best-effort
    }
    state = null;
  }

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
  // browsers re-fetch sub-resources lazily.  Bundle is self-contained
  // for our case but the cost of leaving the URL is negligible.

  let pglite;
  try {
    const assets = await loadPgliteAssets();
    pglite = new mod.PGlite(assets);
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

  state = { app, pglite, ddl };
  return { ok: true, ddl, durationMs: Math.round(performance.now() - start) };
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
    const response = await state.app.fetch(request);
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
  if (state) {
    try {
      await state.pglite.close?.();
    } catch {
      // best-effort
    }
    state = null;
  }
  return { ok: true };
}

self.onmessage = async (ev: MessageEvent<RuntimeRpcRequest>) => {
  const req = ev.data;
  const response: RuntimeRpcResponse = { id: req.id };
  try {
    switch (req.method) {
      case "boot":
        response.result = await boot(req.params.bundleCode);
        break;
      case "dispatch":
        response.result = await dispatch(req.params);
        break;
      case "reset":
        response.result = await reset();
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
