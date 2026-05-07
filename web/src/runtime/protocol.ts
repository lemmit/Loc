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
}

export interface BootOk {
  ok: true;
  ddl: string;
  durationMs: number;
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

export type RuntimeRpcRequest =
  | { id: number; method: "boot"; params: BootRequest }
  | { id: number; method: "dispatch"; params: SerializedRequest }
  | { id: number; method: "reset"; params: Record<string, never> };

export interface RuntimeRpcResponse {
  id: number;
  result?: BootResult | DispatchResult | { ok: true };
  error?: { message: string };
}
