// Runtime-worker protocol.
//
import type { LogLine } from "../util/log-line.js";

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
  /** Empty string when the upstream Response had no body, or when
   *  the status (204 / 205 / 304) forbids a body.  Consumers must
   *  pass `null` to `new Response()` for null-body statuses — the
   *  Web Fetch invariant rejects "" as a body for those. */
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
  /** Recovery escape hatch: drop the persistent DB's `public` +
   *  `__loom` schemas right after opening PGlite, before applying
   *  DDL.  Lets the user recover from a boot that fails on stale /
   *  incompatible persisted data — the normal Reset needs a booted
   *  instance, which a failing boot never produces. */
  fresh?: boolean;
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
  /** True iff this boot detected schema drift in a pre-existing
   *  persistent DB and dropped+recreated the public schema with
   *  fresh DDL.  False on first boot (no prior schema to drift
   *  from) and on no-change reboots.  UI surfaces it as a
   *  transient "schema migrated — rows reset" notification so the
   *  user understands why their data isn't there anymore. */
  migrated: boolean;
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

export interface QueryOk {
  ok: true;
  /** Column names in result order, taken from PGlite's `fields`.
   *  Present even when `rows` is empty so a zero-row SELECT still
   *  renders its header. */
  fields: string[];
  rows: Array<Record<string, unknown>>;
  /** Rows affected by an INSERT/UPDATE/DELETE.  0 for SELECT. */
  affectedRows: number;
  durationMs: number;
}

export interface QueryFail {
  ok: false;
  message: string;
}

export type QueryResult = QueryOk | QueryFail;

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
  | { id: number; method: "query"; params: { sql: string } }
  | { id: number; method: "reset"; params: Record<string, never> }
  | { id: number; method: "wipe"; params: Record<string, never> };

export interface RuntimeRpcResponse {
  id: number;
  result?: BootResult | DispatchResult | QueryResult | WipeResult | { ok: true };
  error?: { message: string };
  /** `console.*` (and any thrown stack) captured in the worker while
   *  this RPC ran — surfaced as the playground's "Backend" log stream.
   *  Omitted when nothing was logged. */
  logs?: LogLine[];
}
