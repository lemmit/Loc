// Auto-generated.
import { pino, type Logger } from "pino";
import { requestContextStore } from "./als";

/** Base process logger.  Level is read from `LOG_LEVEL` (env), default
 *  `info`.  In dev, pipe stdout through `pino-pretty` for readable
 *  output:  `tsx index.ts | pino-pretty`.
 *
 *  Configuration aligned with the project's log envelope
 *  (`{ ts, level, event, request_id, scope_id?, actor_id?, ...fields }`):
 *    - `base: undefined`     — drop pino's default `{ pid, hostname }`
 *                                fields (noisy; orchestrator already records).
 *    - `formatters.level`     — emit the level *label* (`"info"`) rather
 *                                than pino's default numeric severity.
 *    - `timestamp`            — emit `"ts":"<ISO>"` rather than pino's
 *                                default epoch-ms `"time"`.
 *    - `mixin`                — read the ambient frame at log time so every
 *                                line carries the carrier's `scope_id` (and
 *                                `actor_id` once auth has run), joining logs to
 *                                the audit / provenance rows of the same frame.
 *                                Evaluated per call, so a workflow's child frame
 *                                surfaces its own scope; empty outside a request
 *                                (boot / outbox relay). */
export const baseLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  mixin() {
    const ctx = requestContextStore.getStore();
    if (ctx === undefined) return {};
    return ctx.actorId == null
      ? { scope_id: ctx.scopeId }
      : { scope_id: ctx.scopeId, actor_id: ctx.actorId };
  },
});

/** Per-request child logger type — created by the request-id middleware
 *  with `baseLogger.child({ request_id })`, so every line carries the
 *  correlation id automatically; `scope_id` / `actor_id` ride via the
 *  base logger's `mixin` (read from the ambient frame per line). */
export type RequestLogger = Logger;
