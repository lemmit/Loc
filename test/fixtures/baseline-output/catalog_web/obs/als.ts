// Auto-generated.
import { AsyncLocalStorage } from "node:async_hooks";
import { baseLogger, type RequestLogger } from "./log";

/** The ambient execution context for a single request/flow — the one
 *  AsyncLocalStorage carrier every governance slice reads from
 *  (correlation id, principal, locale, start time, the per-request
 *  logger, and the frame's scope id).  Established at the HTTP edge by
 *  the request-id middleware; downstream code (repositories, dispatcher,
 *  domain methods when --trace is on) resolves it via `requestContext()`
 *  / `requestLog()` with no Hono context in scope. */
export interface RequestContext {
  /** Correlation id — from an inbound X-Correlation-Id / X-Request-Id
   *  header or freshly minted; echoed on the response and bound onto the
   *  request logger as request_id. */
  correlationId: string;
  /** The verified principal, or null before auth has run (and always null
   *  when the deployable has no auth).  Typed via the auth-emitted
   *  `requireCurrentUser()` accessor. */
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
 *  The middleware calls `requestContextStore.run(ctx, next)`; downstream
 *  code reads via `requestContext()` / `requestLog()`. */
export const requestContextStore = new AsyncLocalStorage<RequestContext>();

/** The in-flight request context, or undefined outside any request. */
export function requestContext(): RequestContext | undefined {
  return requestContextStore.getStore();
}

/** Resolve the request-scoped logger.  Falls back to the process-level
 *  `baseLogger` when called outside a request (boot, shutdown, ad-hoc
 *  tests) so the call never throws and lines outside a request still
 *  emit through the standard logger. */
export function requestLog(): RequestLogger {
  return requestContextStore.getStore()?.log ?? baseLogger;
}
