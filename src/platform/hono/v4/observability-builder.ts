// ---------------------------------------------------------------------------
// Per-deployable observability scaffolding emitted alongside the rest
// of the Hono backend.  One file:
//
//   obs/request-id.ts — tiny middleware that:
//     1. honours an inbound `X-Request-Id` header (or mints a fresh
//        UUID when absent),
//     2. echoes the value back on the response as `X-Request-Id`,
//     3. emits a JSON `request_start` log line at entry and a
//        matching `request_end` line at exit (status + duration_ms),
//     4. stashes the id on the Hono context as `requestId` so
//        downstream code (per-router app.onError) can include it in
//        error envelopes.
//
// Logging is plain `console.log(JSON.stringify(...))` — matches the
// existing `console.error` style in the per-router onError handlers
// and avoids dragging in pino for v1.  Operators who want pino can
// pin the file in `.loomignore`.
// ---------------------------------------------------------------------------

const REQUEST_ID_TS = `// Auto-generated.
import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";

/** Module augmentation could expose a strongly-typed Variables key,
 *  but the generated route handlers / onError chains use \`c.get\`
 *  with a runtime cast — keeps this file dependency-free for any
 *  consumer (workflows, views, per-aggregate routers). */
export const REQUEST_ID_HEADER = "X-Request-Id";

export interface RequestStartLog {
  ts: string;
  level: "info";
  event: "request_start";
  request_id: string;
  method: string;
  path: string;
}

export interface RequestEndLog {
  ts: string;
  level: "info";
  event: "request_end";
  request_id: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
}

/** Per-request middleware.  Mounts before any business route in
 *  http/index.ts so every downstream handler + onError sees the id. */
export const requestIdMiddleware = createMiddleware<{
  Variables: { requestId: string };
}>(async (c, next) => {
  const inbound = c.req.header(REQUEST_ID_HEADER);
  const requestId = inbound && inbound.length > 0 ? inbound : randomUUID();
  c.set("requestId", requestId);

  const url = new URL(c.req.url);
  const startLog: RequestStartLog = {
    ts: new Date().toISOString(),
    level: "info",
    event: "request_start",
    request_id: requestId,
    method: c.req.method,
    path: url.pathname,
  };
  console.log(JSON.stringify(startLog));

  const startedAt = Date.now();
  try {
    await next();
  } finally {
    // Set the X-Request-Id header on the (now-finalised) response.
    // Calling \`c.header(...)\` BEFORE next() queues the header and
    // sends Hono down a Response-construction path that breaks on
    // null-body statuses (204 / 304) in browser-bundled fetch
    // runtimes ("Response with null body status cannot have body").
    // Mutating c.res.headers directly after the handler returned
    // sidesteps the rebuild — the Headers object is mutable on a
    // Response that hasn't been consumed yet.
    try {
      c.res.headers.set(REQUEST_ID_HEADER, requestId);
    } catch {
      /* best-effort: headers are read-only on some runtimes */
    }
    const endLog: RequestEndLog = {
      ts: new Date().toISOString(),
      level: "info",
      event: "request_end",
      request_id: requestId,
      method: c.req.method,
      path: url.pathname,
      status: c.res.status,
      duration_ms: Date.now() - startedAt,
    };
    console.log(JSON.stringify(endLog));
  }
});
`;

export function emitObservabilityFiles(out: Map<string, string>): void {
  out.set("obs/request-id.ts", REQUEST_ID_TS);
}
