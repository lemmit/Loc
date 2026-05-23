// ---------------------------------------------------------------------------
// Per-deployable observability scaffolding emitted alongside the rest
// of the Hono backend.  Three files:
//
//   obs/log.ts        — base pino logger.  Level from `LOG_LEVEL` env
//                       (default `info`); structured JSON to stdout.
//   obs/als.ts        — AsyncLocalStorage that wires the per-request
//                       child logger into every async frame downstream
//                       of the middleware, so non-HTTP code (repository,
//                       dispatcher, domain when `--trace` is on) can
//                       resolve the request-scoped logger via
//                       `requestLog()` — no Hono context needed at the
//                       call site.
//   obs/request-id.ts — tiny middleware that:
//     1. honours an inbound `X-Request-Id` header (or mints a fresh
//        UUID when absent),
//     2. echoes the value back on the response as `X-Request-Id`,
//     3. binds a per-request child logger (`pino.child({ request_id })`)
//        onto the Hono context as `log` (HTTP-layer reads via
//        `c.get("log")`) and into AsyncLocalStorage (non-HTTP code reads
//        via `requestLog()`),
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

/** Per-request store wiring the bound child logger into Node's
 *  AsyncLocalStorage so any frame downstream of the request-id
 *  middleware can resolve the request-scoped logger — even code that has
 *  no Hono context in scope (repositories, dispatcher, domain methods
 *  when the --trace switch is on).
 *
 *  The middleware calls \`requestLogStore.run({ log }, next)\`; downstream
 *  code reads via \`requestLog()\` and gets the same child logger the
 *  HTTP layer sees through \`c.get("log")\`. */
export const requestLogStore = new AsyncLocalStorage<{ log: RequestLogger }>();

/** Resolve the request-scoped logger.  Falls back to the process-level
 *  \`baseLogger\` when called outside a request (boot, shutdown, ad-hoc
 *  tests) so the call never throws and lines outside a request still
 *  emit through the standard logger. */
export function requestLog(): RequestLogger {
  return requestLogStore.getStore()?.log ?? baseLogger;
}
`;

const REQUEST_ID_TS = `// Auto-generated.
import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";
import { requestLogStore } from "./als";
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

  // Per-request child logger — every line emitted via \`c.get("log")\` or
  // \`requestLog()\` downstream auto-includes \`request_id\` (pino child
  // binding).
  const log = baseLogger.child({ request_id: requestId });
  c.set("log", log);

  const url = new URL(c.req.url);
  log.info({ event: "request_start", method: c.req.method, path: url.pathname });

  const startedAt = Date.now();
  // Wrap \`next()\` (and the request_end emission) in the AsyncLocalStorage
  // run so every async frame downstream — including code with no Hono
  // context (repositories, dispatcher, domain on --trace) — resolves the
  // same logger via \`requestLog()\`.
  await requestLogStore.run({ log }, async () => {
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
