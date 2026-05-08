// Runtime-worker protocol.
//
// The runtime worker is long-lived: once booted it holds a PGlite
// instance, the bootstrapped Hono `app`, and the DDL that built the
// schema.  Each `dispatch` request transports a serialised
// Request → the worker reconstructs it, calls `app.fetch`, and
// returns a serialised Response.

export interface SerializedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Body as text.  null when the request has no body. */
  body: string | null;
}

export interface SerializedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface BootRequest {
  /** ESM bundle source produced by the bundler worker. */
  bundleCode: string;
  /** PGlite data-dir.  Default `:memory:` (wiped on close).  Pass
   *  `opfs-ahp://<some-name>` for OPFS-backed persistence — data
   *  survives page reloads.  Source-keyed paths (e.g.
   *  `opfs-ahp://loom-<source-hash>`) give each `.ddd` its own
   *  data island. */
  dataDir?: string;
}

export interface BootOk {
  ok: true;
  ddl: string;
  durationMs: number;
  /** Whether PGlite actually attached to a persistent backing
   *  (OPFS / IDB) rather than falling back to in-memory.  When the
   *  caller asked for OPFS but the browser refused (e.g. cross-
   *  origin iframe blocking the storage API), this flips to false
   *  so the UI can show "in-memory" instead of misleadingly
   *  saying "persisted". */
  persistent: boolean;
}

export interface BootFail {
  ok: false;
  message: string;
}

export type BootResult = BootOk | BootFail;

export interface DispatchOk {
  ok: true;
  response: SerializedResponse;
  durationMs: number;
}

export interface DispatchFail {
  ok: false;
  message: string;
}

export type DispatchResult = DispatchOk | DispatchFail;

export interface WipeResult {
  ok: boolean;
  /** Best-effort error message when `ok === false`.  The runtime
   *  swallows OPFS-removal failures because the next Boot
   *  re-applies idempotent DDL anyway — the DB just won't be
   *  emptied of pre-existing rows. */
  message?: string;
}

export type RuntimeRpcRequest =
  | { id: number; method: "boot"; params: BootRequest }
  | { id: number; method: "dispatch"; params: SerializedRequest }
  | { id: number; method: "reset"; params: Record<string, never> }
  | { id: number; method: "wipe"; params: Record<string, never> };

export interface RuntimeRpcResponse {
  id: number;
  result?: BootResult | DispatchResult | WipeResult | { ok: true };
  error?: { message: string };
}
