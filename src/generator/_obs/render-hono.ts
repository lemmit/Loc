// ---------------------------------------------------------------------------
// Hono/pino renderer for the neutral log-event catalog (see
// `./log-events.ts`).  Produces the source line every per-model generator
// emits at a log seam — one shape, one logger, one catalog.
//
// Three seams call out:
//   - the per-request HTTP seam (`renderHonoLogCall`) reads the child
//     logger off the Hono context (where the middleware stashed it), so
//     route handlers + onError get the bound logger without an import;
//   - the per-request non-HTTP seam (`renderHonoStoreLogCall`) reads the
//     SAME bound logger via `requestLog()` from `obs/als.ts` (Node's
//     AsyncLocalStorage), so repositories, the event dispatcher, and
//     domain code under `--trace` can log without `c` in scope;
//   - the boot/lifecycle seam (`renderHonoBaseLogCall`) uses the process-
//     level `baseLogger` from `obs/log.ts` directly, since startup /
//     shutdown runs outside any request scope.
//
// Typing: the sub-router's `OpenAPIHono` can't carry custom `Variables`
// typing (zod-openapi's internal `Env` constraint rejects it), so the
// context's variables are declared ONCE for the whole project — a
// `declare module "hono" { interface ContextVariableMap … }` in the emitted
// `obs/log.ts` (see `observability-builder.ts`).  `c.get("log")` is therefore
// plain, typed code at every seam.  It used to be a per-site double cast,
// `(c as unknown as { get(k: "log"): import("../obs/log").RequestLogger })
// .get("log")` — 90 characters repeated at hundreds of seams in one backend,
// each an independent chance to name the wrong type.
// ---------------------------------------------------------------------------

import { type LogEventKey, LogEvents } from "./log-events.js";

const LOG_GET = `c.get("log")`;

/** Per-request log call — every line auto-includes `request_id` via the
 *  child logger the request-id middleware bound to the Hono context.
 *
 *  `fieldsJs` is the comma-separated JS-property syntax for the
 *  structured fields beyond the envelope, in catalog order.  Example:
 *
 *      renderHonoLogCall("operationInvoked",
 *        `aggregate: "Cart", op: "applyTotal", id`)
 *      // → `c.get("log").info({ event: "operation_invoked", aggregate: "Cart", op: "applyTotal", id });`
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

/** AsyncLocalStorage-backed per-request log call — used by seams that
 *  run inside a request but don't have the Hono `c` in scope (repository,
 *  event dispatcher, domain methods on `--trace`).  Resolves through
 *  `requestLog()` from `obs/als.ts`, which reads the bound child logger
 *  out of ALS (falls back to `baseLogger` outside a request).  Emit a
 *  matching `import { requestLog } from "<path>/obs/als"` at the file's
 *  top. */
export function renderHonoStoreLogCall(eventKey: LogEventKey, fieldsJs = ""): string {
  const e = LogEvents[eventKey];
  const tail = fieldsJs ? `, ${fieldsJs}` : "";
  return `requestLog().${e.level}({ event: "${e.event}"${tail} });`;
}
