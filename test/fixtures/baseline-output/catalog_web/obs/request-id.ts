// Auto-generated.
import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";
import { baseLogger, type RequestLogger } from "./log";

export const REQUEST_ID_HEADER = "X-Request-Id";

/** Per-request middleware.  Mounts before any business route in
 *  http/index.ts so every downstream handler + onError sees both the
 *  id and the bound child logger. */
export const requestIdMiddleware = createMiddleware<{
  Variables: { requestId: string; log: RequestLogger };
}>(async (c, next) => {
  const inbound = c.req.header(REQUEST_ID_HEADER);
  const requestId = inbound && inbound.length > 0 ? inbound : randomUUID();
  c.set("requestId", requestId);

  // Per-request child logger — every line emitted via `c.get("log")`
  // downstream auto-includes `request_id` (pino child binding).
  const log = baseLogger.child({ request_id: requestId });
  c.set("log", log);

  const url = new URL(c.req.url);
  log.info({ event: "request_start", method: c.req.method, path: url.pathname });

  const startedAt = Date.now();
  try {
    await next();
  } finally {
    // Set the X-Request-Id header on the (now-finalised) response.
    // Calling `c.header(...)` BEFORE next() queues the header and
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
    log.info({
      event: "request_end",
      method: c.req.method,
      path: url.pathname,
      status: c.res.status,
      duration_ms: Date.now() - startedAt,
    });
  }
});
