// ---------------------------------------------------------------------------
// Hono/pino renderer for the neutral log-event catalog (see
// `./log-events.ts`).  Produces the source line every per-model generator
// emits at a log seam — one shape, one logger, one catalog.
//
// Two seams call out:
//   - the per-request seam (`renderHonoLogCall`) uses the child logger
//     stashed on the Hono context by the request-id middleware, so every
//     line auto-carries `request_id`;
//   - the boot/lifecycle seam (`renderHonoBaseLogCall`) uses the process-
//     level `baseLogger` from `obs/log.ts`, since there is no per-request
//     scope at startup / shutdown.
//
// Cast pattern: the sub-router's `OpenAPIHono` can't carry custom
// `Variables` typing (zod-openapi's internal `Env` constraint rejects it),
// so we bridge `c.get("log")` through the same untyped-cast pattern the
// shipped `trace_id` read uses.  The cast keeps the call site
// strict-tsc-clean and the typed `RequestLogger` import gives the IDE
// proper method completion + signature help.
// ---------------------------------------------------------------------------

import { LogEvents, type LogEventKey } from "./log-events.js";

const LOG_GET = `(c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log")`;

/** Per-request log call — every line auto-includes `request_id` via the
 *  child logger the request-id middleware bound to the Hono context.
 *
 *  `fieldsJs` is the comma-separated JS-property syntax for the
 *  structured fields beyond the envelope, in catalog order.  Example:
 *
 *      renderHonoLogCall("operationInvoked",
 *        `aggregate: "Cart", op: "applyTotal", id`)
 *      // → `(c as unknown as { get(k: "log"): … }).get("log").info({ event: "operation_invoked", aggregate: "Cart", op: "applyTotal", id });`
 */
export function renderHonoLogCall(eventKey: LogEventKey, fieldsJs = ""): string {
  const e = LogEvents[eventKey];
  const tail = fieldsJs ? `, ${fieldsJs}` : "";
  return `${LOG_GET}.${e.level}({ event: "${e.event}"${tail} });`;
}

/** Process-level log call — used by the boot script and any seam that
 *  runs outside a request scope.  Resolves through the imported
 *  `baseLogger` directly (no `request_id` correlation since none exists). */
export function renderHonoBaseLogCall(eventKey: LogEventKey, fieldsJs = ""): string {
  const e = LogEvents[eventKey];
  const tail = fieldsJs ? `, ${fieldsJs}` : "";
  return `baseLogger.${e.level}({ event: "${e.event}"${tail} });`;
}
