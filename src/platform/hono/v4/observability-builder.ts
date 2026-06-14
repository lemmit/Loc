// ---------------------------------------------------------------------------
// Per-deployable observability scaffolding emitted alongside the rest
// of the Hono backend.  Three files:
//
//   obs/log.ts        — base pino logger.  Level from `LOG_LEVEL` env
//                       (default `info`); structured JSON to stdout.
//   obs/als.ts        — AsyncLocalStorage carrying the ambient
//                       `RequestContext` (correlation id, principal,
//                       locale, start time, scope id, the per-request
//                       child logger) into every async frame downstream
//                       of the middleware, so non-HTTP code (repository,
//                       dispatcher, domain when `--trace` is on) can
//                       resolve it via `requestContext()` / `requestLog()`
//                       — no Hono context needed at the call site.
//   obs/request-id.ts — tiny middleware that:
//     1. honours an inbound `X-Correlation-Id` / `X-Request-Id` header
//        (or mints a fresh UUID when absent),
//     2. echoes the value back on the response as both headers,
//     3. binds a per-request child logger (`pino.child({ request_id })`)
//        onto the Hono context as `log` (HTTP-layer reads via
//        `c.get("log")`) and opens the ambient RequestContext (non-HTTP
//        code reads via `requestContext()` / `requestLog()`),
//     4. emits a structured `request_start` log line at entry and a
//        matching `request_end` line at exit (status + duration_ms),
//     5. also stashes the bare `requestId` string on the context so the
//        per-router `app.onError` envelopes can include it in errors.
//
// Logger choice: pino — levels match our taxonomy (trace/debug/info/
// warn/error), child loggers are the standard request-context binding
// mechanism, JSON output keeps the existing playground line-streaming
// working unchanged, and the level check happens before any field-object
// construction so suppressed levels cost ~nothing.  See
// docs/proposals/observability.md.
// ---------------------------------------------------------------------------

const LOG_TS = `// Auto-generated.
import { pino, type Logger } from "pino";

/** Base process logger.  Level is read from \`LOG_LEVEL\` (env), default
 *  \`info\`.  In dev, pipe stdout through \`pino-pretty\` for readable
 *  output:  \`tsx index.ts | pino-pretty\`.
 *
 *  Configuration aligned with the project's log envelope
 *  (\`{ ts, level, event, request_id, ...fields }\`):
 *    - \`base: undefined\`     — drop pino's default \`{ pid, hostname }\`
 *                                fields (noisy; orchestrator already records).
 *    - \`formatters.level\`     — emit the level *label* (\`"info"\`) rather
 *                                than pino's default numeric severity.
 *    - \`timestamp\`            — emit \`"ts":"<ISO>"\` rather than pino's
 *                                default epoch-ms \`"time"\`. */
export const baseLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: () => \`,"ts":"\${new Date().toISOString()}"\`,
});

/** Per-request child logger type — created by the request-id middleware
 *  with \`baseLogger.child({ request_id })\`, so every line carries the
 *  correlation id automatically. */
export type RequestLogger = Logger;
`;

const ALS_TS = `// Auto-generated.
import { AsyncLocalStorage } from "node:async_hooks";
import { baseLogger, type RequestLogger } from "./log";

/** The ambient execution context for a single request/flow — the one
 *  AsyncLocalStorage carrier every governance slice reads from
 *  (correlation id, principal, locale, start time, the per-request
 *  logger, and the frame's scope id).  Established at the HTTP edge by
 *  the request-id middleware; downstream code (repositories, dispatcher,
 *  domain methods when --trace is on) resolves it via \`requestContext()\`
 *  / \`requestLog()\` with no Hono context in scope. */
export interface RequestContext {
  /** Correlation id — from an inbound X-Correlation-Id / X-Request-Id
   *  header or freshly minted; echoed on the response and bound onto the
   *  request logger as request_id. */
  correlationId: string;
  /** The verified principal, or null before auth has run (and always null
   *  when the deployable has no auth).  Typed via the auth-emitted
   *  \`requireCurrentUser()\` accessor. */
  currentUser: unknown;
  /** Request locale from Accept-Language (default "en"). */
  locale: string;
  /** Epoch ms at request start. */
  startedAt: number;
  /** This frame's scope id — the root frame opened at the boundary. */
  scopeId: string;
  /** Parent frame id — null at the root frame. */
  parentId: string | null;
  /** The per-request child logger (the logger slice). */
  log: RequestLogger;
}

/** Per-request store wiring the RequestContext into Node's
 *  AsyncLocalStorage so any frame downstream of the request-id
 *  middleware can resolve it — even code that has no Hono context in
 *  scope (repositories, dispatcher, domain methods when --trace is on).
 *
 *  The middleware calls \`requestContextStore.run(ctx, next)\`; downstream
 *  code reads via \`requestContext()\` / \`requestLog()\`. */
export const requestContextStore = new AsyncLocalStorage<RequestContext>();

/** The in-flight request context, or undefined outside any request. */
export function requestContext(): RequestContext | undefined {
  return requestContextStore.getStore();
}

/** Resolve the request-scoped logger.  Falls back to the process-level
 *  \`baseLogger\` when called outside a request (boot, shutdown, ad-hoc
 *  tests) so the call never throws and lines outside a request still
 *  emit through the standard logger. */
export function requestLog(): RequestLogger {
  return requestContextStore.getStore()?.log ?? baseLogger;
}
`;

const REQUEST_ID_TS = `// Auto-generated.
import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";
import { type RequestContext, requestContextStore } from "./als";
import { baseLogger, type RequestLogger } from "./log";

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

  // Per-request child logger — every line emitted via \`c.get("log")\` or
  // \`requestLog()\` downstream auto-includes \`request_id\` (pino child
  // binding).
  const log = baseLogger.child({ request_id: correlationId });
  c.set("log", log);

  const url = new URL(c.req.url);
  log.info({ event: "request_start", method: c.req.method, path: url.pathname });

  const acceptLanguage = c.req.header("Accept-Language");
  const startedAt = Date.now();
  // The ambient RequestContext for the whole request.  The principal slot
  // starts null; auth middleware attaches it one step later.
  const ctx: RequestContext = {
    correlationId,
    currentUser: null,
    locale: acceptLanguage && acceptLanguage.length > 0 ? acceptLanguage : "en",
    startedAt,
    scopeId: randomUUID(),
    parentId: null,
    log,
  };
  // Wrap \`next()\` (and the request_end emission) in the AsyncLocalStorage
  // run so every async frame downstream — including code with no Hono
  // context (repositories, dispatcher, domain on --trace) — resolves the
  // same context via \`requestContext()\` / \`requestLog()\`.
  await requestContextStore.run(ctx, async () => {
    try {
      await next();
    } finally {
      // Echo the correlation id on the (now-finalised) response, on both
      // the cross-backend X-Correlation-Id and the legacy X-Request-Id.
      // Calling \`c.header(...)\` BEFORE next() queues the header and sends
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
      log.info({
        event: "request_end",
        method: c.req.method,
        path: url.pathname,
        status: c.res.status,
        duration_ms: Date.now() - startedAt,
      });
    }
  });
});
`;

export function emitObservabilityFiles(out: Map<string, string>): void {
  out.set("obs/log.ts", LOG_TS);
  out.set("obs/als.ts", ALS_TS);
  out.set("obs/request-id.ts", REQUEST_ID_TS);
}
