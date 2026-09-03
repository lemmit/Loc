// Requests → operations (M-T8.22 slice 4 — Darklang's traces over data the
// playground already holds).
//
// Every request the booted backend serves — from the API console, the
// preview iframe, or a UI test — ends in a structured `request_end` log line
// (method, raw path, status, duration) that the runtime worker tees into
// `ctx.backendLog`.  This module matches those lines to the OpenAPI
// operations the Runtime tab already fetched (`ctx.apiEndpoints`) and folds
// them into per-operation counts, so the count can sit on the operation
// (here in the Requests sub-view; on the Model-pane node in M-T8.20) and the
// unmatched paths collect in a 404s list.
//
// Pure data → data: no React, no DOM, no worker — the root vitest suite
// drives it without `web/node_modules`.

import type { LogLine } from "../util/log-line";
import type { ApiEndpoint } from "./openapi";

/** One served request, as the `request_end` line reports it. */
export interface RequestRecord {
  method: string;
  /** Raw request path, query string stripped. */
  path: string;
  status: number;
  durationMs: number;
  requestId?: string;
}

/** Read a `request_end` line into a record; `null` for every other line. */
export function requestFromLogLine(line: LogLine): RequestRecord | null {
  const p = line.structured;
  if (!p || p.event !== "request_end") return null;
  const method = typeof p.method === "string" ? p.method.toUpperCase() : null;
  const path = typeof p.path === "string" ? p.path : null;
  if (!method || !path) return null;
  const status = typeof p.status === "number" ? p.status : Number(p.status);
  const durationMs = typeof p.duration_ms === "number" ? p.duration_ms : Number(p.duration_ms ?? 0);
  return {
    method,
    path: stripQuery(path),
    status: Number.isFinite(status) ? status : 0,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    requestId: typeof p.request_id === "string" ? p.request_id : undefined,
  };
}

function stripQuery(path: string): string {
  const q = path.indexOf("?");
  return q >= 0 ? path.slice(0, q) : path;
}

/** Split a path into segments, dropping the empty ones a leading / trailing
 *  slash produces so `/products/` and `/products` are the same route. */
function segments(path: string): string[] {
  return stripQuery(path)
    .split("/")
    .filter((s) => s.length > 0);
}

/** Does `template` (`/products/{id}`) match `path` (`/products/42`)?  A
 *  `{param}` segment matches any single non-empty segment; literals match
 *  exactly.  Returns the number of LITERAL segments matched (the
 *  specificity), or -1 for no match — so `/products/search` beats
 *  `/products/{id}` when both apply. */
export function matchPathTemplate(template: string, path: string): number {
  const t = segments(template);
  const p = segments(path);
  if (t.length !== p.length) return -1;
  let literals = 0;
  for (let i = 0; i < t.length; i++) {
    const ts = t[i]!;
    const ps = p[i]!;
    if (ts.startsWith("{") && ts.endsWith("}")) continue;
    if (ts !== decodeSegment(ps)) return -1;
    literals++;
  }
  return literals;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The operation a request hit, or `null` when no operation's method + path
 *  template matches (a 404 — or a route the spec does not describe, such as
 *  `/openapi.json` or `/health`, which the caller filters). */
export function matchRoute(
  method: string,
  path: string,
  endpoints: readonly ApiEndpoint[],
): ApiEndpoint | null {
  const m = method.toUpperCase();
  let best: ApiEndpoint | null = null;
  let bestScore = -1;
  for (const ep of endpoints) {
    if (ep.method.toUpperCase() !== m) continue;
    const score = matchPathTemplate(ep.path, path);
    if (score > bestScore) {
      best = ep;
      bestScore = score;
    }
  }
  return best;
}

/** Paths the backend serves that no domain operation owns — infrastructure
 *  the Runtime tab itself calls (the spec fetch, health probes, docs).  They
 *  are neither an operation hit nor a 404, so the aggregate skips them. */
export const INFRA_PATHS: readonly RegExp[] = [
  /^\/openapi\.json$/,
  /^\/asyncapi\.json$/,
  /^\/health(?:\/|$)/,
  /^\/ready(?:\/|$)/,
  /^\/metrics$/,
  /^\/docs(?:\/|$)/,
  /^\/auth\/me$/,
];

export function isInfraPath(path: string): boolean {
  return INFRA_PATHS.some((re) => re.test(stripQuery(path)));
}

export interface OperationTrace {
  endpoint: ApiEndpoint;
  count: number;
  /** Count of responses with a status ≥ 400. */
  errors: number;
  last: RequestRecord | null;
}

export interface UnmatchedTrace {
  method: string;
  path: string;
  count: number;
  lastStatus: number;
}

export interface RequestTraces {
  /** Keyed by `operationId`, in the endpoints' own order. */
  byOperation: OperationTrace[];
  /** Requests no operation matched — the 404s list.  Keyed by method +
   *  path, most recent first. */
  unmatched: UnmatchedTrace[];
  /** Every served request, infra excluded. */
  total: number;
}

export const EMPTY_TRACES: RequestTraces = { byOperation: [], unmatched: [], total: 0 };

/** Fold the runtime log into per-operation counts + the 404s list.  Runs
 *  on every log change (memoised by the caller), so it is a single pass. */
export function aggregateRequestTraces(
  lines: readonly LogLine[],
  endpoints: readonly ApiEndpoint[],
): RequestTraces {
  if (endpoints.length === 0 && lines.length === 0) return EMPTY_TRACES;
  const ops = new Map<string, OperationTrace>();
  for (const ep of endpoints) {
    ops.set(ep.operationId, { endpoint: ep, count: 0, errors: 0, last: null });
  }
  const unmatched = new Map<string, UnmatchedTrace>();
  let total = 0;
  for (const line of lines) {
    const r = requestFromLogLine(line);
    if (!r || isInfraPath(r.path)) continue;
    total++;
    const ep = matchRoute(r.method, r.path, endpoints);
    if (ep) {
      const t = ops.get(ep.operationId)!;
      t.count++;
      if (r.status >= 400) t.errors++;
      t.last = r;
    } else {
      const k = `${r.method} ${r.path}`;
      const u = unmatched.get(k);
      if (u) {
        u.count++;
        u.lastStatus = r.status;
        // Re-insert so the most recent sits last (reversed below).
        unmatched.delete(k);
        unmatched.set(k, u);
      } else {
        unmatched.set(k, { method: r.method, path: r.path, count: 1, lastStatus: r.status });
      }
    }
  }
  return {
    byOperation: [...ops.values()],
    unmatched: [...unmatched.values()].reverse(),
    total,
  };
}
