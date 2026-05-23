// Auto-generated.
import { AsyncLocalStorage } from "node:async_hooks";
import { baseLogger, type RequestLogger } from "./log";

/** Per-request store wiring the bound child logger into Node's
 *  AsyncLocalStorage so any frame downstream of the request-id
 *  middleware can resolve the request-scoped logger — even code that has
 *  no Hono context in scope (repositories, dispatcher, domain methods
 *  when the --trace switch is on).
 *
 *  The middleware calls `requestLogStore.run({ log }, next)`; downstream
 *  code reads via `requestLog()` and gets the same child logger the
 *  HTTP layer sees through `c.get("log")`. */
export const requestLogStore = new AsyncLocalStorage<{ log: RequestLogger }>();

/** Resolve the request-scoped logger.  Falls back to the process-level
 *  `baseLogger` when called outside a request (boot, shutdown, ad-hoc
 *  tests) so the call never throws and lines outside a request still
 *  emit through the standard logger. */
export function requestLog(): RequestLogger {
  return requestLogStore.getStore()?.log ?? baseLogger;
}
