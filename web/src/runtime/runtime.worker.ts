/// <reference lib="webworker" />
import { synthDDL } from "./ddl";
import { pgliteAssetUrl } from "../bundle/plugin.js";
import { fnv1a32 } from "../util/hash.js";
import { asStructuredPayload, formatLogArg, LOG_LEVELS, type LogLine } from "../util/log-line.js";
import type {
  BootResult,
  DispatchResult,
  QueryResult,
  RuntimeRpcRequest,
  RuntimeRpcResponse,
  SerializedRequest,
  SerializedResponse,
} from "./protocol.js";

declare const self: DedicatedWorkerGlobalScope;

// Tee `console.*` into `sink` (while still writing through to the real
// console for DevTools) for the duration of one RPC.  This is how the
// generated Hono handlers' logs — which run inside this worker via
// `app.fetch` — reach the playground's "Backend" log stream.  Returns a
// restore fn the caller invokes in a `finally`.
//
// Structured pino lines (emitted by every generated Hono backend; see
// docs/proposals/observability.md) flow in as a single object argument:
// `console.info({ level, event, ts, request_id, … })`.  We detect that
// shape on the way through and:
//   - attach the parsed payload as `structured` so the Output panel can
//     render event / request_id / fields without re-parsing,
//   - override the LogLine `level` from `payload.level`.  pino in
//     browser maps `logger.trace(...)` to `console.debug(...)`, so the
//     console method's name UNDER-represents the semantic level —
//     reading it off the payload restores `trace` as a first-class
//     filter target in the UI.
function captureConsole(sink: LogLine[]): () => void {
  const original: Partial<Record<LogLine["level"], (...a: unknown[]) => void>> = {};
  for (const level of LOG_LEVELS) {
    original[level] = console[level] as (...a: unknown[]) => void;
    console[level] = (...args: unknown[]): void => {
      const structured = args.length === 1 ? asStructuredPayload(args[0]) : undefined;
      sink.push({
        level: structured?.level ?? level,
        text: args.map(formatLogArg).join(" "),
        ...(structured ? { structured } : {}),
      });
      original[level]!(...args);
    };
  }
  return () => {
    for (const level of LOG_LEVELS) {
      console[level] = original[level]!;
    }
  };
}

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
  ) => PgliteHandle;
  is: (value: unknown, type: unknown) => boolean;
  Table: unknown;
  getTableConfig: (t: unknown) => never;
}

interface PgliteHandle {
  exec: (sql: string) => Promise<unknown>;
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{
    rows: Array<Record<string, unknown>>;
    fields?: Array<{ name: string; dataTypeID: number }>;
    affectedRows?: number;
  }>;
  close?: () => Promise<void>;
}

// PGlite/Postgres can reject with a plain object (a serialized
// protocol error: `{ message, severity, code, … }`) rather than an
// `Error`.  The naive `String(err)` then prints "[object Object]",
// hiding the only useful detail.  Dig out a real message, falling
// back to a JSON dump so nothing is ever swallowed.
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) return msg;
    try {
      return JSON.stringify(err);
    } catch {
      /* circular / non-serialisable — fall through */
    }
  }
  return String(err);
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
  pglite: PgliteHandle;
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

async function boot(
  bundleCode: string,
  dataDir?: string,
  fresh = false,
): Promise<BootResult> {
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
      message: `Bundle import failed: ${errText(err)}`,
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
      message: `PGlite boot failed: ${errText(err)}`,
    };
  }

  // Recovery path: a persistent island whose stored data is
  // incompatible with the current schema can fail every boot, and the
  // normal Reset is unreachable without a booted instance.  `fresh`
  // wipes both the user schema and our bookkeeping schema here — after
  // PGlite has opened cleanly but before any DDL — so the subsequent
  // apply starts from a blank database.
  if (fresh) {
    try {
      await pglite.exec(
        "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; " +
          "DROP SCHEMA IF EXISTS __loom CASCADE;",
      );
    } catch (err) {
      return {
        ok: false,
        message: `Reset of stored data failed: ${errText(err)}`,
      };
    }
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
      message: `DDL synth failed: ${errText(err)}`,
    };
  }

  let migrated = false;
  try {
    migrated = await migrateOrApplyDDL(pglite, ddl);
  } catch (err) {
    return {
      ok: false,
      message: `DDL execution failed: ${errText(err)}\n--- DDL ---\n${ddl}`,
    };
  }

  let app: BundleModule["createApp"] extends (db: unknown) => infer R ? R : never;
  try {
    const db = mod.drizzle(pglite, { schema: mod.schema });
    app = mod.createApp(db);
  } catch (err) {
    return {
      ok: false,
      message: `createApp failed: ${errText(err)}`,
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
    migrated,
  };
}

// Apply DDL idempotently on a possibly-pre-existing PGlite, with
// schema-drift detection.
//
// We keep a tiny `__loom.schema_meta` bookkeeping table (one row,
// `key='ddl_hash'`, `value=<fnv1a32 of the DDL string>`) in a
// separate schema so it survives `DROP SCHEMA public CASCADE`.
// On boot we compute the hash of the current DDL and compare:
//
//   - First boot (table missing or row absent): apply DDL,
//     record hash.  Returns `migrated = false` (this isn't a
//     migration, it's an initial setup).
//   - Subsequent boot, hash matches: skip — the persistent
//     PGlite already has the right schema, the user's rows are
//     intact.  Returns `migrated = false`.
//   - Subsequent boot, hash differs: drop public schema, re-apply
//     new DDL, update hash.  Returns `migrated = true` so the
//     UI can flash a "schema changed — DB reset" message.  This
//     is necessary because IF-NOT-EXISTS DDL would otherwise
//     leave stale tables that don't match the new generated
//     repositories' expectations.
async function migrateOrApplyDDL(
  pglite: PgliteHandle,
  ddl: string,
): Promise<boolean> {
  // Bootstrap the meta table.  Both statements are idempotent.
  await pglite.exec(
    "CREATE SCHEMA IF NOT EXISTS __loom; " +
      "CREATE TABLE IF NOT EXISTS __loom.schema_meta (" +
      "  key text PRIMARY KEY, " +
      "  value text NOT NULL" +
      ");",
  );
  const newHash = fnv1a32(ddl);
  const result = await pglite.query(
    "SELECT value FROM __loom.schema_meta WHERE key = $1",
    ["ddl_hash"],
  );
  const oldHash =
    result.rows.length > 0 ? String(result.rows[0]["value"]) : null;

  if (oldHash === newHash) {
    // Same schema — nothing to do.  Skips even the IF-NOT-EXISTS
    // round-trip, saving a few milliseconds on each warm reload.
    return false;
  }

  let migrated = false;
  if (oldHash !== null) {
    // Schema drifted: drop and recreate.  CASCADE is essential —
    // foreign-keyed rows would otherwise block the drop.
    await pglite.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    migrated = true;
  }
  if (ddl.trim().length > 0) await pglite.exec(ddl);

  // Record the new hash.  ON CONFLICT for the case where the row
  // existed (drift) and INSERT for first boot.
  await pglite.query(
    "INSERT INTO __loom.schema_meta (key, value) VALUES ($1, $2) " +
      "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    ["ddl_hash", newHash],
  );
  return migrated;
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
      message: errText(err),
    };
  }
}

// Run an arbitrary SQL statement against the booted PGlite for the
// Database console.  Single-statement (PGlite's `query` runs one
// parameterless statement) — enough for SELECT browsing and ad-hoc
// INSERT/UPDATE/DELETE.  The same timeout race as `dispatch` guards
// against a runaway query wedging the worker.
async function query(sql: string): Promise<QueryResult> {
  if (!state) {
    return { ok: false, message: "Runtime not booted — boot first." };
  }
  const start = performance.now();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`query timed out after ${DEFAULT_DISPATCH_TIMEOUT_MS} ms`));
      }, DEFAULT_DISPATCH_TIMEOUT_MS);
    });
    const res = await Promise.race([state.pglite.query(sql), timeoutPromise]);
    return {
      ok: true,
      fields: (res.fields ?? []).map((f) => f.name),
      rows: res.rows ?? [],
      affectedRows: res.affectedRows ?? 0,
      durationMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      ok: false,
      message: errText(err),
    };
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
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
      message: errText(err),
    };
  }
}

self.onmessage = async (ev: MessageEvent<RuntimeRpcRequest>) => {
  const req = ev.data;
  const response: RuntimeRpcResponse = { id: req.id };
  const logs: LogLine[] = [];
  const restore = captureConsole(logs);
  try {
    switch (req.method) {
      case "boot":
        response.result = await boot(
          req.params.bundleCode,
          req.params.dataDir,
          req.params.fresh,
        );
        break;
      case "dispatch":
        response.result = await dispatch(req.params);
        break;
      case "query":
        response.result = await query(req.params.sql);
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
    // Surface the stack in the Backend log stream — the RPC error
    // message itself only carries `err.message`.
    logs.push({
      level: "error",
      text: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    response.error = {
      message: errText(err),
    };
  } finally {
    restore();
  }
  if (logs.length > 0) response.logs = logs;
  self.postMessage(response);
};
