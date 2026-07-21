// Auto-generated.
import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";
import { type RequestContext, requestContextStore } from "./als";
import { baseLogger, type RequestLogger } from "./log";
import { recordHttpRequest } from "./metrics";

export const CORRELATION_ID_HEADER = "X-Correlation-Id";
export const REQUEST_ID_HEADER = "X-Request-Id";

/** Per-request middleware.  Mounts before any business route in
 *  http/index.ts so every downstream handler + onError sees the
 *  ambient RequestContext (correlation id, locale, start time, scope id,
 *  the bound child logger; the principal is attached later by auth). */
export const requestIdMiddleware = createMiddleware<{
  Variables: { requestId: string; log: RequestLogger };
}>(async (c, next) => {
  // Correlation id — prefer the cross-backend X-Correlation-Id, fall back
  // to X-Request-Id, else mint.  Never derived from a sampled trace id.
  const inbound = c.req.header(CORRELATION_ID_HEADER) ?? c.req.header(REQUEST_ID_HEADER);
  const correlationId = inbound && inbound.length > 0 ? inbound : randomUUID();
  c.set("requestId", correlationId);

  // Per-request child logger — every line emitted via `c.get("log")` or
  // `requestLog()` downstream auto-includes `request_id` (pino child
  // binding).
  const log = baseLogger.child({ request_id: correlationId });
  c.set("log", log);

  const url = new URL(c.req.url);

  const acceptLanguage = c.req.header("Accept-Language");
  const startedAt = Date.now();
  // The ambient RequestContext for the whole request.  The principal slot
  // starts null; auth middleware attaches it one step later.
  const ctx: RequestContext = {
    correlationId,
    currentUser: null,
    actorId: null,
    locale: acceptLanguage && acceptLanguage.length > 0 ? acceptLanguage : "en",
    startedAt,
    scopeId: randomUUID(),
    parentId: null,
    log,
  };
  // Wrap `next()` (and the request_end emission) in the AsyncLocalStorage
  // run so every async frame downstream — including code with no Hono
  // context (repositories, dispatcher, domain on --trace) — resolves the
  // same context via `requestContext()` / `requestLog()`.
  await requestContextStore.run(ctx, async () => {
    // Emitted inside the frame so request_start carries the same scope_id as
    // request_end and every line between (the mixin reads the ambient frame).
    log.info({ event: "request_start", method: c.req.method, path: url.pathname });
    try {
      await next();
    } finally {
      // Echo the correlation id on the (now-finalised) response, on both
      // the cross-backend X-Correlation-Id and the legacy X-Request-Id.
      // Calling `c.header(...)` BEFORE next() queues the header and sends
      // Hono down a Response-construction path that breaks on null-body
      // statuses (204 / 304) in browser-bundled fetch runtimes ("Response
      // with null body status cannot have body").  Mutating c.res.headers
      // directly after the handler returned sidesteps the rebuild — the
      // Headers object is mutable on a Response that hasn't been consumed.
      try {
        c.res.headers.set(CORRELATION_ID_HEADER, correlationId);
        c.res.headers.set(REQUEST_ID_HEADER, correlationId);
      } catch {
        /* best-effort: headers are read-only on some runtimes */
      }
      const durationMs = Date.now() - startedAt;
      log.info({
        event: "request_end",
        method: c.req.method,
        path: url.pathname,
        status: c.res.status,
        duration_ms: durationMs,
      });
      // Record the same finished request against the Prometheus HTTP
      // metrics — same seam as request_end.  `routePath` is the matched
      // route TEMPLATE (`/api/carts/*`), keeping label cardinality bounded
      // (raw `url.pathname` carries per-request ids).
      recordHttpRequest(c.req.method, c.req.routePath, c.res.status, durationMs);
    }
  });
});
